/**
 * Gate definitions that change when a repair lands (P15, D-P15-04, D-P15-07,
 * D-P15-11, SC-P15-07).
 *
 * A repair job may change anything, setup and the gate commands included, and a
 * changed definition applies to the verifications after it lands. Three things
 * follow, and all three are here:
 *
 * - **The run's current definitions.** The ratified contract's setup and
 *   verification, unless a landed repair changed them, in which case the latest
 *   `gate.repaired` event that says so carries the new ones. Derived from the
 *   run's records, as strand gating and red-base holding are, so an engine that
 *   re-attaches and `nightshift resume` read the same definitions; kept in
 *   memory, and refreshed when this process writes a `gate.repaired`. The
 *   stored Program Contract and its plan hash are never touched: the change is
 *   a run decision, reviewed afterwards, not a re-ratification.
 * - **What a landing records.** When a repair has been integrated, the merged
 *   setup and verification at the commit it landed are read with git, compared
 *   with the current ones, and `gate.repaired` says whether they changed (and
 *   to what). A change is also a Decision, so the report's reader sees it as
 *   one. The project's gate-health record, when there is one, is rewritten at
 *   the new head with the fingerprint recomputed there.
 * - **The setup reference.** The program checkout is what every new worktree
 *   is seeded from (D-P10-24), so after a repair lands, and once at a new run's
 *   start, the current setup runs there, writing the install marker as any
 *   setup does. Preparation, never a verdict: a failure is reported and the run
 *   goes on, because each worktree still runs setup itself.
 *
 * Every step is derived from the records and converges when repeated: a landing
 * reconciles every integrated repair, not only its own, so a write that failed
 * (a lost event, a gate-health put the control plane refused) is made by the
 * next landing or the next engine to attach.
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  type CheckpointId,
  type Decision,
  EventSchema,
  type ExecutionNode,
  type ExecutionNodeId,
  type GateHealth,
  type JobContract,
  mergeProgramFiles,
  NIGHTSHIFT_CONFIG_FILE,
  type NightshiftConfig,
  NightshiftConfigSchema,
  PROGRAMS_DIRECTORY,
  type Principal,
  type ProgramContract,
  programContractPath,
  type SetupStep,
  SetupStepSchema,
  type VerificationStep,
  VerificationStepSchema,
} from "@nightshift/contracts";
import { type GateHealthStore, nowIso, type ProjectStores } from "@nightshift/core";
import { runSetupSteps, setupFailed } from "@nightshift/verification";
import {
  DEFAULT_VERIFICATION_TIMEOUT_MS,
  type LandingEnvironment,
  type RunSession,
} from "./environment.js";
import { fingerprintAtCommit, gitBlobReader } from "./gate-fingerprint.js";
import { type GitRunner, revParse, tryGit } from "./git/index.js";
import { recordArtifact } from "./runner.js";
import { scratchEnv } from "./scratch.js";
import { setupLog } from "./setup.js";

/** What a verification runs: setup first, then the gates. */
export interface GateDefinitions {
  readonly setup: readonly SetupStep[];
  readonly verification: readonly VerificationStep[];
}

/** What reading the run's definitions needs of a session. */
export type GateSession = Pick<RunSession, "scope" | "program">;

/** A `ProgramContract` whose setup and verification are `gates`: what a brief shows an agent. */
export const withGateDefinitions = (
  program: ProgramContract,
  gates: GateDefinitions,
): ProgramContract => {
  const { setup: _ratified, ...rest } = program;
  return {
    ...rest,
    ...(gates.setup.length === 0 && program.setup === undefined ? {} : { setup: [...gates.setup] }),
    verification: [...gates.verification],
  };
};

// --- The run's current definitions ------------------------------------------------------

/**
 * Per store and run. Keyed by the stores object, so two environments over the
 * same stores agree, and a process that reads the records afresh (another
 * engine, `nightshift resume`) derives them rather than trusting this one.
 */
const cached = new WeakMap<object, Map<string, Promise<GateDefinitions>>>();

const runsOf = (stores: ProjectStores): Map<string, Promise<GateDefinitions>> => {
  let runs = cached.get(stores);
  if (runs === undefined) {
    runs = new Map();
    cached.set(stores, runs);
  }
  return runs;
};

const ratified = (program: ProgramContract): GateDefinitions => ({
  setup: program.setup ?? [],
  verification: program.verification,
});

/** The definitions a `gate.repaired` payload changed, over `current`. */
const applyRepaired = (current: GateDefinitions, payload: unknown): GateDefinitions => {
  const body = payload as { definitionsChanged?: unknown; setup?: unknown; verification?: unknown };
  if (body.definitionsChanged !== true) return current;
  const setup = SetupStepSchema.array().safeParse(body.setup);
  const verification = VerificationStepSchema.array().min(1).safeParse(body.verification);
  return {
    setup: setup.success ? setup.data : current.setup,
    verification: verification.success ? verification.data : current.verification,
  };
};

const deriveGateDefinitions = async (
  stores: ProjectStores,
  session: GateSession,
): Promise<GateDefinitions> => {
  let current = ratified(session.program);
  let cursor: string | undefined;
  do {
    const page = await stores.events.listByRun(
      session.scope,
      cursor === undefined ? {} : { cursor },
    );
    for (const event of page.items) {
      if (event.type === "gate.repaired") current = applyRepaired(current, event.payload);
    }
    cursor = page.cursor;
  } while (cursor !== undefined);
  return current;
};

/**
 * The run's current setup and verification: the ratified contract's, or what
 * the latest landed repair that changed them made them. The one answer every
 * reader uses: verification, a candidate's checks, a checkout's preparation,
 * an agent's brief, and the setup reference.
 */
export const gateDefinitions = (
  environment: Pick<LandingEnvironment, "stores">,
  session: GateSession,
): Promise<GateDefinitions> => {
  const runs = runsOf(environment.stores);
  const key = session.scope.runId;
  const known = runs.get(key);
  if (known !== undefined) return known;
  const derived = deriveGateDefinitions(environment.stores, session);
  runs.set(key, derived);
  // A read that failed is not an answer: the next reader asks again.
  derived.catch(() => {
    if (runs.get(key) === derived) runs.delete(key);
  });
  return derived;
};

const remember = (
  environment: Pick<LandingEnvironment, "stores">,
  session: GateSession,
  gates: GateDefinitions,
): void => {
  runsOf(environment.stores).set(session.scope.runId, Promise.resolve(gates));
};

// --- The definitions at a commit ---------------------------------------------------------

const show = async (
  runner: GitRunner,
  repo: string,
  commit: string,
  path: string,
): Promise<string | undefined> => {
  const result = await tryGit(runner, ["show", `${commit}:${path}`], { cwd: repo });
  return result.exitCode === 0 ? result.stdout : undefined;
};

const configAt = async (
  runner: GitRunner,
  repo: string,
  commit: string,
): Promise<NightshiftConfig | undefined> => {
  const text = await show(runner, repo, commit, NIGHTSHIFT_CONFIG_FILE);
  return text === undefined ? undefined : NightshiftConfigSchema.parse(JSON.parse(text));
};

/**
 * The program's authored contract at `commit`: `docs/programs/{programId}/`,
 * or whichever program directory's contract names this program, since a
 * directory is named for the program rather than by its id.
 */
const authoredContractAt = async (
  runner: GitRunner,
  repo: string,
  commit: string,
  programId: string,
): Promise<unknown> => {
  const direct = await show(runner, repo, commit, programContractPath(programId));
  if (direct !== undefined) return JSON.parse(direct);
  const listed = await tryGit(
    runner,
    ["ls-tree", "-r", "--name-only", commit, "--", PROGRAMS_DIRECTORY],
    { cwd: repo },
  );
  if (listed.exitCode !== 0) return undefined;
  const candidates = listed.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((path) => /^docs\/programs\/[^/]+\/contract\.json$/.test(path));
  for (const path of candidates) {
    const text = await show(runner, repo, commit, path);
    if (text === undefined) continue;
    try {
      const parsed: unknown = JSON.parse(text);
      if ((parsed as { programId?: unknown } | null)?.programId === programId) return parsed;
    } catch {
      // Somebody else's contract, and not valid JSON: not this program's either.
    }
  }
  return undefined;
};

/** Key order is not meaning: two step lists are the same when they say the same. */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, inner: unknown) =>
    inner !== null && typeof inner === "object" && !Array.isArray(inner)
      ? Object.fromEntries(
          Object.entries(inner as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
        )
      : inner,
  );

const sameSteps = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b);

/**
 * The merged setup and verification at `commit`, as `nightshift run {id}`
 * merges them: the program's `contract.json` over `nightshift.config.json`.
 *
 * A contract authored elsewhere (not under `docs/programs/`) has no file here
 * to read, so the config's own setup and verification apply over the current
 * ones, and only where this landing changed them in the config: a project
 * default the run's contract has always overridden is not a repair's change.
 */
export const gateDefinitionsAt = async (
  runner: GitRunner,
  repo: string,
  commit: string,
  session: GateSession,
  current: GateDefinitions,
): Promise<GateDefinitions> => {
  const config = await configAt(runner, repo, commit);
  const authored = await authoredContractAt(runner, repo, commit, session.program.programId);
  if (authored !== undefined) {
    const merged = mergeProgramFiles(authored, config) as {
      readonly setup?: unknown;
      readonly verification?: unknown;
    };
    return {
      setup: SetupStepSchema.array().parse(merged.setup ?? []),
      verification: VerificationStepSchema.array().min(1).parse(merged.verification),
    };
  }
  if (config === undefined) return current;
  const before = await configAt(runner, repo, `${commit}^`).catch(() => undefined);
  return {
    setup: sameSteps(config.setup, before?.setup) ? current.setup : (config.setup ?? current.setup),
    verification: sameSteps(config.verification, before?.verification)
      ? current.verification
      : config.verification,
  };
};

// --- Reconciling the landed repairs ------------------------------------------------------

interface LandedRepair {
  readonly node: ExecutionNode & { readonly commitSha: NonNullable<ExecutionNode["commitSha"]> };
  readonly job: JobContract & { readonly repair: NonNullable<JobContract["repair"]> };
}

const readAll = async <T>(
  list: (page: { cursor?: string }) => Promise<{ items: readonly T[]; cursor?: string }>,
): Promise<T[]> => {
  const items: T[] = [];
  let cursor: string | undefined;
  do {
    const page = await list(cursor === undefined ? {} : { cursor });
    items.push(...page.items);
    cursor = page.cursor;
  } while (cursor !== undefined);
  return items;
};

/** Every repair job of the run that has been integrated, in the order they landed. */
const landedRepairs = async (
  stores: ProjectStores,
  session: GateSession,
): Promise<readonly LandedRepair[]> => {
  const integrated = (
    await readAll((page) => stores.executionNodes.listByRun(session.scope, page))
  ).filter((node) => node.status === "integrated" && node.jobContractId !== null);
  if (integrated.length === 0) return [];
  const jobs = new Map(
    (await readAll((page) => stores.jobContracts.listByRun(session.scope, page))).map((job) => [
      job.jobContractId,
      job,
    ]),
  );
  const landed: LandedRepair[] = [];
  for (const node of integrated) {
    const job = node.jobContractId === null ? undefined : jobs.get(node.jobContractId);
    if (job?.repair === undefined || node.commitSha === null) continue;
    landed.push({ node, job } as LandedRepair);
  }
  return landed.sort((a, b) => a.node.updatedAt.localeCompare(b.node.updatedAt));
};

const describeSteps = (steps: readonly (SetupStep | VerificationStep)[]): string =>
  steps.length === 0 ? "none" : steps.map((step) => `${step.id}: ${step.command}`).join("; ");

/** Names the repair in a decision's context, so a repeated landing finds the one it wrote. */
const decisionMarker = (repair: LandedRepair): string =>
  `gate definitions changed by repair ${repair.job.jobContractId}`;

/** The checkpoint the repair's integration made: the state the new definitions apply from. */
const checkpointOf = async (
  stores: ProjectStores,
  session: GateSession,
  nodeId: ExecutionNodeId,
): Promise<CheckpointId | undefined> => {
  const checkpoints = await readAll((page) => stores.checkpoints.listByRun(session.scope, page));
  return (
    checkpoints.filter((checkpoint) => checkpoint.executionNodeId === nodeId).at(-1) ??
    checkpoints.at(-1)
  )?.checkpointId;
};

/** The decision a changed definition is (D-P15-04): the engine's, naming the repair's own. */
const recordChange = async (
  environment: LandingEnvironment,
  session: GateSession,
  repair: LandedRepair,
  before: GateDefinitions,
  after: GateDefinitions,
): Promise<void> => {
  const { stores, clock, ids } = environment;
  const marker = decisionMarker(repair);
  const existing = await readAll((page) => stores.decisions.listByRun(session.scope, page));
  if (
    existing.some(
      (decision) =>
        decision.executionNodeId === repair.node.executionNodeId &&
        decision.context.includes(marker),
    )
  ) {
    return;
  }
  const checkpointBefore = await checkpointOf(stores, session, repair.node.executionNodeId);
  if (checkpointBefore === undefined) {
    throw new Error("the run has no checkpoint for a decision to point at");
  }
  const changed: string[] = [];
  if (!sameSteps(before.setup, after.setup)) {
    changed.push(
      `setup was ${describeSteps(before.setup)}; it is now ${describeSteps(after.setup)}`,
    );
  }
  if (!sameSteps(before.verification, after.verification)) {
    changed.push(
      `verification was ${describeSteps(before.verification)}; it is now ${describeSteps(after.verification)}`,
    );
  }
  const decision: Decision = {
    schemaVersion: 1,
    ...session.scope,
    decisionId: ids.next("dec"),
    executionNodeId: repair.node.executionNodeId,
    agentId: null,
    context:
      `The ${marker} (its decision ${repair.job.repair.decisionId}, cause ${repair.job.repair.cause}), ` +
      `which landed at ${repair.node.commitSha}.`,
    alternatives: [
      {
        summary: "Keep verifying with the definitions the run had before the repair",
        rejectedBecause:
          "a changed gate definition applies to the verifications after the repair lands (D-P15-04)",
      },
    ],
    choice: `Verifications that start from here on use the new definitions: ${changed.join(". ")}.`,
    rationale:
      "The repair changed setup or the gate commands, was examined at high risk against the " +
      "gate standard, and landed. The run's stored Program Contract and its plan hash are " +
      "unchanged: this is a run decision, reviewed afterwards, not a re-ratification.",
    reversibility: "reversible",
    checkpointBefore,
    affectedNodes: [],
    authority: "agent",
    supersedesDecisionId: null,
    createdAt: nowIso(clock),
  };
  await stores.decisions.put(decision);
  environment.outbox.emit({
    type: "decision.recorded",
    source: "control-plane",
    payload: {
      decisionId: decision.decisionId,
      choice: decision.choice,
      reversibility: "reversible",
    },
    executionNodeId: repair.node.executionNodeId,
  });
};

/** `gate.repaired`, durably and once per repair: the key is the repair's own. */
const appendRepaired = async (
  environment: LandingEnvironment,
  session: GateSession,
  repair: LandedRepair,
  payload: Readonly<Record<string, unknown>>,
): Promise<void> => {
  const at = nowIso(environment.clock);
  await environment.stores.events.append(
    EventSchema.parse({
      schemaVersion: 1,
      ...session.scope,
      eventId: environment.ids.next("evt"),
      idempotencyKey: `control-plane:${session.scope.runId}:gate.repaired:${repair.job.jobContractId}`,
      sequence: null,
      type: "gate.repaired",
      source: "control-plane",
      executionNodeId: repair.node.executionNodeId,
      agentId: null,
      payload,
      occurredAt: at,
      recordedAt: at,
    }),
  );
};

/** The `gate.repaired` events already on the record, by job contract id. */
const repairedJobs = async (
  stores: ProjectStores,
  session: GateSession,
): Promise<ReadonlySet<string>> => {
  const events = await readAll((page) => stores.events.listByRun(session.scope, page));
  return new Set(
    events
      .filter((event) => event.type === "gate.repaired")
      .map((event) => String((event.payload as { jobContractId?: unknown }).jobContractId)),
  );
};

/** Records what each landed repair did to the gates, for every one not yet recorded. */
const recordRepairs = async (
  environment: LandingEnvironment,
  session: RunSession,
  repairs: readonly LandedRepair[],
): Promise<void> => {
  const recorded = await repairedJobs(environment.stores, session);
  for (const repair of repairs) {
    if (recorded.has(repair.job.jobContractId)) continue;
    const before = await gateDefinitions(environment, session);
    const after = await gateDefinitionsAt(
      environment.git,
      session.repoPath,
      repair.node.commitSha,
      session,
      before,
    );
    const setupChanged = !sameSteps(before.setup, after.setup);
    const verificationChanged = !sameSteps(before.verification, after.verification);
    const definitionsChanged = setupChanged || verificationChanged;
    // The decision first: a landing repeated after a lost event finds it and
    // writes the event alone, never a second decision.
    if (definitionsChanged) await recordChange(environment, session, repair, before, after);
    await appendRepaired(environment, session, repair, {
      jobContractId: repair.job.jobContractId,
      decisionId: repair.job.repair.decisionId,
      cause: repair.job.repair.cause,
      definitionsChanged,
      ...(setupChanged ? { setup: after.setup } : {}),
      ...(verificationChanged ? { verification: after.verification } : {}),
    });
    if (definitionsChanged) remember(environment, session, after);
  }
};

// --- The gate-health record (D-P15-07) ---------------------------------------------------

const isAncestor = async (
  runner: GitRunner,
  repo: string,
  ancestor: string,
  of: string,
): Promise<boolean> =>
  (await tryGit(runner, ["merge-base", "--is-ancestor", ancestor, of], { cwd: repo })).exitCode ===
  0;

/**
 * The run's engine, as the record names who wrote it: the program node and the
 * orchestrator agent the run was attached with. A resume has no orchestrator
 * of its own, so it is read from the program node.
 */
const enginePrincipal = async (
  stores: ProjectStores,
  session: RunSession,
): Promise<Principal | undefined> => {
  const nodeId = (session.rootNodeId as ExecutionNodeId | undefined) ?? session.run?.rootNodeId;
  if (nodeId === undefined) return undefined;
  const agentId =
    (session.orchestratorAgentId as RunSession["orchestratorAgentId"] | undefined) ??
    (await stores.agents.listByNode(session.scope, nodeId))
      .filter((agent) => agent.role === "orchestrator")
      .at(-1)?.agentId;
  if (agentId === undefined) return undefined;
  return {
    kind: "execution",
    projectId: session.scope.projectId,
    programId: session.scope.programId,
    runId: session.scope.runId,
    nodeId,
    agentId,
    role: "engine",
  };
};

/**
 * The project's record, at the program head, when a repair landed after it was
 * written and it does not yet stand at or after that repair. Derived from the
 * record itself, so a rewrite that failed is made by whoever reconciles next.
 * No store, or no record: nothing to do.
 */
const rewriteGateHealth = async (
  environment: LandingEnvironment,
  session: RunSession,
  repairs: readonly LandedRepair[],
): Promise<void> => {
  const store = environment.stores.gateHealth as GateHealthStore | undefined;
  if (store === undefined || repairs.length === 0) return;
  const record = await store.get(session.scope.projectId);
  if (record === undefined) return;
  const repo = session.repoPath;
  let behind = false;
  for (const repair of repairs) {
    // A record written after this repair landed is somebody's newer audit.
    if (Date.parse(record.auditedAt) > Date.parse(repair.node.updatedAt)) continue;
    if (!(await isAncestor(environment.git, repo, repair.node.commitSha, record.commit))) {
      behind = true;
      break;
    }
  }
  if (!behind) return;
  const auditedBy = await enginePrincipal(environment.stores, session);
  if (auditedBy === undefined) {
    throw new Error("the run's engine has no identity on the record to write it under");
  }
  const head = await revParse(environment.git, repo, session.program.repository.programBranch);
  const gates = await gateDefinitions(environment, session);
  const fingerprint = await fingerprintAtCommit(
    gitBlobReader(repo),
    head,
    { setup: [...gates.setup], verification: [...gates.verification] },
    record.machinery,
  );
  const rewritten: GateHealth = {
    ...record,
    commit: head as GateHealth["commit"],
    fingerprint,
    auditedBy,
    auditedAt: nowIso(environment.clock),
  };
  await store.put(rewritten);
};

// --- The setup reference (D-P15-11) ------------------------------------------------------

/**
 * The current setup, once, in the program checkout, writing the install marker
 * as any setup does, so later worktrees are seeded from it (D-P10-24). Run as
 * the engine, never as a worker, and with a temp directory made for this alone
 * under the run's own directory: the operator's checkout sits wherever they
 * cloned it, and nothing beside it is Nightshift's to delete. Never throws: a
 * failure is reported on `nodeId`, and each worktree still runs setup itself.
 */
export const prepareSetupReference = async (
  environment: LandingEnvironment,
  session: RunSession,
  nodeId: ExecutionNodeId,
  why: string,
): Promise<boolean> => {
  let scratch: string | undefined;
  try {
    const { setup } = await gateDefinitions(environment, session);
    if (setup.length === 0) return true;
    const runDir = environment.paths.runDir(session.scope.runId);
    await mkdir(runDir, { recursive: true });
    scratch = await mkdtemp(join(runDir, "reference-tmp-"));
    const results = await runSetupSteps({
      setup,
      cwd: session.repoPath,
      timeoutMs: environment.verificationTimeoutMs ?? DEFAULT_VERIFICATION_TIMEOUT_MS,
      env: scratchEnv(scratch),
    });
    const artifactId = await recordArtifact(environment, {
      scope: session.scope,
      nodeId,
      kind: "build-log",
      contentType: "text/plain; charset=utf-8",
      bytes: setupLog(results),
    });
    const failed = setupFailed(results) ? results.at(-1) : undefined;
    environment.outbox.emit({
      type: "node.progress",
      source: "control-plane",
      payload: {
        message:
          failed === undefined
            ? `the program checkout was prepared as the setup reference ${why}`
            : `setup failed in the program checkout ${why}: ${failed.stepId} exited ${failed.exitCode}; ` +
              "each worktree still runs setup itself",
        setupReference: session.repoPath,
        setupLogArtifactId: artifactId,
      },
      executionNodeId: nodeId,
    });
    return failed === undefined;
  } catch (error) {
    warn(environment, nodeId, `the program checkout could not be prepared ${why}`, error);
    return false;
  } finally {
    if (scratch !== undefined) await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
};

// --- The landing ---------------------------------------------------------------------------

const warn = (
  environment: LandingEnvironment,
  nodeId: ExecutionNodeId,
  what: string,
  error: unknown,
): void => {
  environment.outbox.emit({
    type: "node.progress",
    source: "control-plane",
    payload: {
      message: `${what}: ${error instanceof Error ? error.message : String(error)}`,
      warning: true,
    },
    executionNodeId: nodeId,
  });
};

export interface ReconcileGateRepairsInput {
  /** The node that just landed, when this is a landing; absent when an engine attaches. */
  readonly landed?: ExecutionNodeId;
  /** Where a warning is written when there is no landed node: the program node. */
  readonly nodeId: ExecutionNodeId;
}

/**
 * Brings the run's records up to date with its landed repairs: `gate.repaired`
 * (and the decision, when the definitions changed) for each that has none, and
 * the gate-health record. When `landed` is itself a repair, the program
 * checkout is then prepared as the setup reference. Called on every landing,
 * by the merge queue, a readmitted dispute and `nightshift resume` alike
 * (`integrateNode`), and when an engine attaches. Never throws: what failed is
 * reported, and the next reconciliation makes it.
 */
export const reconcileGateRepairs = async (
  environment: LandingEnvironment,
  session: RunSession,
  input: ReconcileGateRepairsInput,
): Promise<void> => {
  const at = input.landed ?? input.nodeId;
  let repairs: readonly LandedRepair[];
  try {
    repairs = await landedRepairs(environment.stores, session);
  } catch (error) {
    warn(environment, at, "the run's landed repairs could not be read", error);
    return;
  }
  if (repairs.length === 0) return;
  let recorded = false;
  try {
    await recordRepairs(environment, session, repairs);
    recorded = true;
  } catch (error) {
    warn(environment, at, "what a landed repair did to the gates could not be recorded", error);
  }
  // The record is fingerprinted with the run's current definitions, so it waits
  // for them: written over definitions a lost event left stale, it would look
  // current and never be corrected. Left behind, the next reconciliation writes it.
  if (recorded) {
    try {
      await rewriteGateHealth(environment, session, repairs);
    } catch (error) {
      warn(environment, at, "the project's gate-health record could not be updated", error);
    }
  }
  const repair = repairs.find((candidate) => candidate.node.executionNodeId === input.landed);
  if (repair !== undefined) {
    await prepareSetupReference(
      environment,
      session,
      repair.node.executionNodeId,
      `after repair ${repair.job.jobContractId} landed`,
    );
  }
};
