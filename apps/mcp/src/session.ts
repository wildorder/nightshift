/**
 * What an orchestrator-role server holds for a session.
 *
 * One run at a time, and one job in flight under it (contract §5). The state is
 * deliberately thin: the control plane is the authority for everything about the
 * run (A-06), and what lives here is only what a *process* has — the outbox it
 * delivers through, the job whose worker it is waiting on, and the identity it
 * acts as.
 *
 * Nothing here is read to answer a question about run state. `job.get` and
 * `program.status` go to the control plane, so an orchestrator and a human
 * reading `GET …/state` never disagree.
 */
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  Agent,
  AgentId,
  Checkpoint,
  ExecutionNode,
  ProgramContract,
  ProgramId,
  ProjectId,
  Run,
  RunId,
} from "@nightshift/contracts";
import {
  NIGHTSHIFT_CONFIG_FILE,
  PROGRAMS_DIRECTORY,
  ProgramIdSchema,
  ProjectIdSchema,
  RunIdSchema,
} from "@nightshift/contracts";
import {
  isPlanned,
  nowIso,
  type PlanSections,
  type RunScope,
  splitPlanSections,
} from "@nightshift/core";
import {
  checkpointRef,
  createEngine,
  createEventOutbox,
  type Engine,
  type EventOutbox,
  type ExecutionEnvironment,
  type RunSession,
  repairProvisionalLine,
  revParse,
  startRun,
  updateRef,
  type WorkerLaunchIdentity,
} from "@nightshift/execution";
import type { McpLaunch } from "@nightshift/harness";
import type { Runtime } from "./compose.js";
import { ToolRefusal } from "./results.js";
import { examinationServices, routeJob } from "./routing.js";

/** Where a repository declares which program it belongs to. */
export const DEFAULT_CONTRACT_FILE = "nightshift.program.json";

export interface AttachedRun {
  readonly session: RunSession;
  readonly environment: ExecutionEnvironment;
  readonly outbox: EventOutbox;
  /** The run's engine: everything this server has queued or started (P6, D-P6-01). */
  readonly engine: Engine;
  /** How many spooled events an earlier session for this run left behind. */
  readonly replayed: number;
  /** Whether the authored file disagrees with the stored contract. */
  readonly contractDrifted: boolean;
  /**
   * A planned run's strand sections, split from the **ratified** plan document
   * as the control plane holds it (P7, D-P7-02). Absent for a run with no plan.
   */
  readonly planSections?: PlanSections;
}

export interface OrchestratorSession {
  readonly runtime: Runtime;
  /** The operator's clone. Its program branch is what a job integrates into. */
  readonly repoPath: string;
  readonly contractFile: string;
  /** From the MCP initialize handshake: which harness is orchestrating. */
  clientInfo(): { readonly name: string; readonly version: string };
  /** Builds the launch for a worker's own MCP server (§4.2). */
  workerLaunch(identity: WorkerLaunchIdentity): McpLaunch;
  /**
   * Set when this server was launched **for** a headless root orchestrator (P7,
   * D-P7-09): the agent that launcher started. `run.attach` adopts it rather
   * than recording a second orchestrator for one process.
   */
  readonly rootAgentId?: AgentId;
  /**
   * P10 (D-P10-20): set on a machine, where this server is the engine of one
   * dispatched run. `run.attach` reads that run from the plane, whatever the
   * checkout holds, and `run.start` is refused.
   */
  readonly pinnedRun?: RunScope;
  current?: AttachedRun | undefined;
}

/** The execution environment a run is worked in: the runtime's, with the run's own examiners. */
export const buildEnvironment = (
  runtime: Runtime,
  outbox: EventOutbox,
  run: Run,
  program: ProgramContract,
): ExecutionEnvironment => ({
  stores: runtime.stores,
  bodies: runtime.bodies,
  tokens: runtime.tokens,
  harness: runtime.harness,
  clock: runtime.clock,
  ids: runtime.ids,
  paths: runtime.paths,
  git: runtime.git,
  outbox,
  workerEnvironment: runtime.workerEnvironment,
  ...(runtime.prerequisites === undefined ? {} : { prerequisites: runtime.prerequisites }),
  // P8: who examines and who arbitrates, by the run's own policy (D-P8-10, D-P8-13).
  examination: examinationServices(run, program, (identity) => runtime.workerLaunch(identity)),
  // P10 (D-P10-25): on a machine, every job's agent runs as a worker user.
  ...(runtime.runAs === undefined ? {} : { runAs: runtime.runAs }),
  ...(runtime.reclaim === undefined ? {} : { reclaim: runtime.reclaim }),
  // P16 (D-10): on a machine, every project step runs in the project environment.
  ...(runtime.projectEnv === undefined ? {} : { projectEnv: runtime.projectEnv }),
  // P10 (T4): on a machine, a worker's token is a file the engine keeps fresh.
  ...(runtime.workerTokens === undefined ? {} : { workerTokens: runtime.workerTokens }),
  // P10 (D-P10-22): on a machine, every landing raises a publication intent.
  ...(runtime.publication === undefined
    ? {}
    : {
        publish: runtime.publication({
          projectId: run.projectId,
          programId: run.programId,
          runId: run.runId,
        }),
      }),
});

interface ProgramRef {
  readonly projectId: ProjectId;
  readonly programId: ProgramId;
}

const readJson = async (path: string): Promise<unknown> => {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
};

/** The ids a contract names, with `projectId` inherited from the config when it states none. */
const refOf = (raw: unknown, config: unknown): ProgramRef | undefined => {
  if (raw === null || typeof raw !== "object") return undefined;
  const authored = raw as { projectId?: unknown; programId?: unknown };
  const projectId = ProjectIdSchema.safeParse(
    authored.projectId ?? (config as { projectId?: unknown } | undefined)?.projectId,
  );
  const programId = ProgramIdSchema.safeParse(authored.programId);
  return projectId.success && programId.success
    ? { projectId: projectId.data, programId: programId.data }
    : undefined;
};

/**
 * Every program this repository holds a contract for: the single authored
 * contract file of an unplanned program, and each planned program's
 * `docs/programs/{id}/contract.json` (P7, D-P7-03), whose `projectId` may come
 * from `nightshift.config.json`. Only the identifiers are taken from the files;
 * the **record** is the authority for the contract's content (§4.5).
 *
 * Found by the first real planned run (foodfly, 2026-09-22): this read the
 * contract file alone, which a planned program does not have, and the headless
 * root got past it by writing one by hand, which dirtied the checkout.
 */
const repositoryPrograms = async (state: OrchestratorSession): Promise<ProgramRef[]> => {
  const config = await readJson(resolve(state.repoPath, NIGHTSHIFT_CONFIG_FILE));
  const refs: ProgramRef[] = [];
  const single = refOf(await readJson(resolve(state.repoPath, state.contractFile)), config);
  if (single !== undefined) refs.push(single);
  const programsDir = resolve(state.repoPath, PROGRAMS_DIRECTORY);
  let entries: string[] = [];
  try {
    entries = await readdir(programsDir);
  } catch {
    // No planned programs here.
  }
  for (const entry of entries.sort()) {
    const ref = refOf(await readJson(resolve(programsDir, entry, "contract.json")), config);
    if (ref !== undefined && !refs.some((known) => known.programId === ref.programId)) {
      refs.push(ref);
    }
  }
  return refs;
};

/**
 * The directory under `docs/programs/` whose contract names `programId`, for
 * writing that program's `report.md` beside its plan. `undefined` for a program
 * with no planned directory.
 */
export const programDirectoryOf = async (
  state: OrchestratorSession,
  programId: ProgramId,
): Promise<string | undefined> => {
  const programsDir = resolve(state.repoPath, PROGRAMS_DIRECTORY);
  let entries: string[] = [];
  try {
    entries = await readdir(programsDir);
  } catch {
    return undefined;
  }
  for (const entry of entries.sort()) {
    const raw = await readJson(resolve(programsDir, entry, "contract.json"));
    if ((raw as { programId?: unknown } | undefined)?.programId === programId) {
      return resolve(programsDir, entry);
    }
  }
  return undefined;
};

/**
 * Which of this repository's programs a run belongs to: the one that holds the
 * named run, or the only one with a pending run. A repository with many planned
 * programs attaches without being told which, as long as that is unambiguous.
 */
const repositoryProgram = async (
  state: OrchestratorSession,
  runId: string | undefined,
): Promise<ProgramRef> => {
  const refs = await repositoryPrograms(state);
  if (refs.length === 0) {
    throw new ToolRefusal(
      "not_found",
      `this repository has no program contract (neither ${state.contractFile} nor ` +
        `${PROGRAMS_DIRECTORY}/<id>/contract.json), so there is no way to know which program it belongs to`,
    );
  }
  if (refs.length === 1) return refs[0] as ProgramRef;

  const { stores } = state.runtime;
  const holding: ProgramRef[] = [];
  for (const ref of refs) {
    if (runId !== undefined) {
      if ((await stores.runs.get(ref, RunIdSchema.parse(runId))) !== undefined) return ref;
      continue;
    }
    const runs = await stores.runs.listByProgram(ref).catch(() => ({ items: [] }));
    if (runs.items.some((run) => run.status === "pending")) holding.push(ref);
  }
  if (runId === undefined && holding.length === 1) return holding[0] as ProgramRef;
  throw new ToolRefusal(
    "validation_failed",
    runId === undefined
      ? `this repository has ${refs.length} programs and ${holding.length} of them have a pending run. ` +
          "Name the run with runId."
      : `run ${runId} belongs to none of this repository's programs`,
    { programs: refs.map((ref) => ref.programId) },
  );
};

/**
 * The orchestrator's own `Agent`, created and started.
 *
 * Its `harness` is the MCP client's name from the initialize handshake — which
 * is what is actually orchestrating — and its model is what `run.attach` was
 * told. Neither is guessed: an agent record claiming a model nobody chose would
 * poison the routing dataset it sits beside.
 */
const createOrchestratorAgent = async (
  state: OrchestratorSession,
  scope: RunScope,
  rootNodeId: ExecutionNode["executionNodeId"],
  model: string,
): Promise<AgentId> => {
  const client = state.clientInfo();
  const { stores, clock, ids } = state.runtime;
  if (state.rootAgentId !== undefined) {
    const launched = await stores.agents.get(scope, state.rootAgentId);
    // Only the agent the launcher made, for this node: anything else is a stale
    // or foreign id, and the ordinary path below is the honest answer to it.
    if (launched?.executionNodeId === rootNodeId && launched.role === "orchestrator") {
      if (launched.status === "created") {
        await stores.agents.put({ ...launched, status: "started", startedAt: nowIso(clock) });
      }
      return launched.agentId;
    }
  }
  const agent: Agent = {
    schemaVersion: 1,
    ...scope,
    agentId: ids.next("agent"),
    executionNodeId: rootNodeId,
    role: "orchestrator",
    harness: client.name,
    provider: "anthropic",
    model,
    status: "created",
    createdAt: nowIso(clock),
  };
  await stores.agents.put(agent);
  await stores.agents.put({ ...agent, status: "started", startedAt: nowIso(clock) });
  return agent.agentId;
};

/** Moves the root node and the run to `running`, one table step at a time. */
const beginRun = async (
  state: OrchestratorSession,
  run: Run,
  rootNode: ExecutionNode,
): Promise<Run> => {
  const { stores, clock } = state.runtime;
  let node = rootNode;
  for (const next of ["queued", "running"] as const) {
    if (
      (next === "queued" && node.status === "validated") ||
      (next === "running" && node.status === "queued")
    ) {
      node = { ...node, status: next, updatedAt: nowIso(clock) };
      await stores.executionNodes.put(node);
    }
  }
  if (run.status !== "pending") return run;
  const running: Run = { ...run, status: "running" };
  await stores.runs.put(running);
  return running;
};

interface Located {
  readonly program: ProgramContract;
  readonly run: Run;
  readonly rootNode: ExecutionNode;
}

/**
 * The run to attach to: the one named, or the single `pending` one.
 *
 * Two pending runs is a refusal that lists them. Picking one would mean an
 * orchestrator working on a run nobody asked it to, which is worse than making
 * the operator say which.
 */
const locateRun = async (
  state: OrchestratorSession,
  runId: string | undefined,
): Promise<Located> => {
  const { stores } = state.runtime;
  if (state.pinnedRun !== undefined && runId !== undefined && runId !== state.pinnedRun.runId) {
    throw new ToolRefusal(
      "not_found",
      `this server is the engine of run ${state.pinnedRun.runId} and can attach to no other`,
    );
  }
  const { projectId, programId } = state.pinnedRun ?? (await repositoryProgram(state, runId));
  const program = await stores.programContracts.get(projectId, programId);
  if (program === undefined) {
    throw new ToolRefusal(
      "not_found",
      `program ${programId} is not in the control plane. Authorize a run first with ` +
        "`nightshift run`, or start one here with run.start.",
    );
  }

  const chosen = await chooseRun(state, { projectId, programId }, runId ?? state.pinnedRun?.runId);
  const scope: RunScope = { projectId, programId, runId: chosen.runId };
  const rootNode = await stores.executionNodes.get(scope, chosen.rootNodeId);
  if (rootNode === undefined) {
    throw new ToolRefusal("not_found", `run ${chosen.runId} names a root node that does not exist`);
  }
  return { program, run: chosen, rootNode };
};

const chooseRun = async (
  state: OrchestratorSession,
  scope: { readonly projectId: ProjectId; readonly programId: ProgramId },
  runId: string | undefined,
): Promise<Run> => {
  const { stores } = state.runtime;
  if (runId !== undefined) {
    const run = await stores.runs.get(scope, RunIdSchema.parse(runId));
    if (run === undefined) {
      throw new ToolRefusal(
        "not_found",
        `run ${runId} does not exist in program ${scope.programId}`,
      );
    }
    return run;
  }

  const runs = await stores.runs.listByProgram(scope);
  const pending = runs.items.filter((run) => run.status === "pending");
  const only = pending[0];
  if (only === undefined) {
    throw new ToolRefusal(
      "not_found",
      `program ${scope.programId} has no pending run to attach to. Authorize one with ` +
        "`nightshift run <contract>`, which prints the run id.",
    );
  }
  if (pending.length > 1) {
    throw new ToolRefusal(
      "validation_failed",
      `program ${scope.programId} has ${pending.length} pending runs, so there is no single one to ` +
        `attach to. Name the one you mean: ${pending.map((run) => run.runId).join(", ")}`,
      { pendingRuns: pending.map((run) => run.runId) },
    );
  }
  return only;
};

/** Whether the authored file still says what the stored contract says. */
const contractDrifted = async (
  state: OrchestratorSession,
  stored: ProgramContract,
): Promise<boolean> => {
  try {
    const authored: unknown = JSON.parse(
      await readFile(resolve(state.repoPath, state.contractFile), "utf8"),
    );
    return JSON.stringify(authored) !== JSON.stringify(stored);
  } catch {
    return false;
  }
};

export interface AttachInput {
  readonly model: string;
  readonly runId?: string;
}

/**
 * The plan a planned run executes, read from the control plane by the hash its
 * program node carries. Not from the checkout: what is on disk may have been
 * edited since, and a strand's orchestrator is told what was ratified.
 */
const readPlanSections = async (
  state: OrchestratorSession,
  program: ProgramContract,
  rootNode: ExecutionNode,
): Promise<PlanSections | undefined> => {
  if (!isPlanned(program)) return undefined;
  const sha256 = rootNode.plan?.planDocument.sha256;
  const text =
    sha256 === undefined
      ? undefined
      : await state.runtime.planText?.(
          { projectId: program.projectId, programId: program.programId },
          sha256,
        );
  if (text === undefined) {
    throw new ToolRefusal(
      "plan_unavailable",
      "this run is of a planned program, and the control plane could not supply the plan " +
        "document it was ratified with, so no strand can be briefed. Ratify the plan again with " +
        "`nightshift plan ratify` and start a new run.",
    );
  }
  return splitPlanSections(text);
};

export const attachRun = async (
  state: OrchestratorSession,
  input: AttachInput,
): Promise<AttachedRun> => {
  if (state.current !== undefined) {
    throw new ToolRefusal(
      "already_attached",
      `this server is already bound to run ${state.current.session.scope.runId}. One run per ` +
        "session: start a new orchestrator for another.",
    );
  }

  const { runtime } = state;
  const { program, run, rootNode } = await locateRun(state, input.runId);
  const scope: RunScope = {
    projectId: program.projectId,
    programId: program.programId,
    runId: run.runId,
  };

  const agentId = await createOrchestratorAgent(
    state,
    scope,
    rootNode.executionNodeId,
    input.model,
  );
  const outbox = createEventOutbox({
    events: runtime.stores.events,
    scope,
    clock: runtime.clock,
    ids: runtime.ids,
    writerId: agentId,
  });

  // A spool an earlier server for this run left behind, replayed **before** any
  // new event is accepted, so the stream stays in order. The idempotency keys
  // make replaying safe even if the earlier server had in fact delivered them.
  const replayed = await outbox.replay(runtime.paths.spool(scope.runId));

  const started = await beginRun(state, run, rootNode);
  outbox.emit({
    type: "run.started",
    source: "control-plane",
    payload: { orchestrator: state.clientInfo().name, model: input.model },
    executionNodeId: rootNode.executionNodeId,
    agentId,
  });

  const session: RunSession = {
    scope,
    program,
    run: started,
    rootNodeId: rootNode.executionNodeId,
    orchestratorAgentId: agentId,
    repoPath: state.repoPath,
  };
  const planSections = await readPlanSections(state, program, rootNode);
  const environment = buildEnvironment(runtime, outbox, started, program);
  // Before the engine uses the provisional line: drop what an earlier engine's
  // stop left at its tip without a deferred node (provisional-line.ts).
  await repairProvisionalLine(environment, session);
  const attached: AttachedRun = {
    session,
    environment,
    engine: createEngine({
      environment,
      session,
      mcp: (identity) => state.workerLaunch(identity),
      // For what a sub-program's orchestrator delegates (D-P6-01), for a retry
      // and for a fallback: routed here, by the same rules over the same ladders
      // as the root's own delegations (D-P8-04).
      route: (job, context) => routeJob(started, program, job, context),
      // P15 (D-P15-11): a new run's program checkout becomes the setup
      // reference, once. Not on a machine: its workspace ran setup there
      // already (runner/workspace.ts), and not for a run being re-attached.
      prepareReference: run.status === "pending" && state.pinnedRun === undefined,
    }),
    outbox,
    replayed,
    contractDrifted: await contractDrifted(state, program),
    ...(planSections === undefined ? {} : { planSections }),
  };
  state.current = attached;
  return attached;
};

export interface StartRunInput {
  readonly program: unknown;
  readonly repoPath: string;
  readonly model: string;
  /** The plan document on disk, for a planned program: held to the ratified hash. */
  readonly planText?: string;
}

/**
 * `run.start`: the CLI's own function, then an attach (D-P3-17).
 *
 * The control-plane writes are `startRun` in `@nightshift/execution`, shared
 * verbatim with `nightshift run`. Two implementations of "what starting a run
 * means" is exactly what A-32's "same canonical model" forbids.
 */
export const startNewRun = async (
  state: OrchestratorSession,
  input: StartRunInput,
): Promise<AttachedRun & { readonly baseCommit: string }> => {
  const { runtime } = state;
  if (state.pinnedRun !== undefined) {
    throw new ToolRefusal(
      "pinned_run",
      `this server is the engine of run ${state.pinnedRun.runId}; attach to it with run.attach. ` +
        "A machine starts no run of its own.",
    );
  }
  const started = await startRun(
    { stores: runtime.stores, clock: runtime.clock, ids: runtime.ids, git: runtime.git },
    {
      program: input.program,
      repoPath: input.repoPath,
      ...(input.planText === undefined ? {} : { planText: input.planText }),
    },
  );
  const attached = await attachRun(state, { model: input.model, runId: started.run.runId });
  return { ...attached, baseCommit: started.baseCommit };
};

/** A node's line in `execution.status`. One line, because a tree is read at a glance. */
export const describeNodeLine = (node: ExecutionNode, agent: Agent | undefined): string => {
  const commit = node.commitSha === null ? "" : ` @${node.commitSha.slice(0, 8)}`;
  const worker = agent === undefined ? "" : ` [${agent.role} ${agent.model} ${agent.status}]`;
  const reason = node.outcomeReason === undefined ? "" : ` — ${node.outcomeReason}`;
  return `${"  ".repeat(node.depth)}${node.executionNodeId} ${node.kind} ${node.status}${commit}${worker}${reason}`;
};

/** A checkpoint at the program branch head: a ref, and the record that finds it. */
export const createCheckpointAt = async (
  state: OrchestratorSession,
  attached: AttachedRun,
  label: string | undefined,
): Promise<Checkpoint> => {
  const { runtime } = state;
  const commitSha = await revParse(
    runtime.git,
    state.repoPath,
    attached.session.program.repository.programBranch,
  );
  const checkpointId = runtime.ids.next("ckpt");
  const ref = checkpointRef(checkpointId);
  await updateRef(runtime.git, state.repoPath, ref, commitSha);
  const checkpoint: Checkpoint = {
    schemaVersion: 1,
    ...attached.session.scope,
    checkpointId,
    executionNodeId: attached.session.rootNodeId,
    commitSha,
    ref,
    ...(label === undefined ? {} : { label }),
    createdAt: nowIso(runtime.clock),
  };
  await runtime.stores.checkpoints.put(checkpoint);
  attached.outbox.emit({
    type: "checkpoint.created",
    source: "control-plane",
    payload: { checkpointId, ref, commitSha },
    executionNodeId: attached.session.rootNodeId,
  });
  return checkpoint;
};

export type { RunId };
