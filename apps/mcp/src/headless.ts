/**
 * The headless root orchestrator (P7, T4; D-P7-09).
 *
 * `nightshift run {id}` authorises a run and then calls this, in a process of
 * its own: it starts **an agent like any other**, through the routed adapters,
 * whose brief is the ratified plan and whose only Nightshift surface is the
 * orchestrator-role MCP server it is launched with. That server hosts the run's
 * engine, exactly as it does when a human's own session orchestrates, so this
 * adds the unattended path and changes nothing about the attended one.
 *
 * What is here and not in the CLI: the CLI may not import a harness, and this
 * package's composition root is the one place that may.
 *
 * The root is given a **detached checkout to read**, never the program checkout
 * itself. Workers run with permissions bypassed (A-39); a root that could edit
 * the operator's clone would leave it dirty, and integration refuses a dirty
 * checkout.
 */
import { mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Agent,
  type ExecutionNode,
  type JobContract,
  JobContractSchema,
  lifecycleOperationId,
  type ProgramContract,
  type RouteTarget,
  type Run,
  type RunId,
} from "@nightshift/contracts";
import {
  canTransitionAgent,
  isPlanned,
  isSettled,
  type NightshiftStores,
  nowIso,
  type RunScope,
  transition,
  transitionAgent,
} from "@nightshift/core";
import {
  addDetachedWorktree,
  createEventOutbox,
  createHookSink,
  createMeasurementRecorder,
  createRouteAvailability,
  type EventOutbox,
  freshScratch,
  observeLifecycle,
  pruneWorktrees,
  revParse,
  tryGit,
  unavailableUntil,
} from "@nightshift/execution";
import {
  describeExit,
  type HarnessExit,
  type McpLaunch,
  refusingWorkerTools,
} from "@nightshift/harness";
import type { Runtime } from "./compose.js";
import type { Env } from "./role.js";
import { routeJob } from "./routing.js";

/** Set on the root's MCP server so `run.attach` adopts the agent started here instead of inventing one. */
export const ROOT_AGENT_ENV = "NIGHTSHIFT_ROOT_AGENT_ID";
/** The program checkout, which is not the root agent's working directory. */
export const REPO_PATH_ENV = "NIGHTSHIFT_REPO_PATH";
/**
 * P10 (D-P10-20): on a machine the root's server is bound to one run, the
 * dispatch's, as `projectId/programId/runId`. `run.attach` then reads the
 * program and the run from the plane rather than from contract files in the
 * checkout, which a remote repository need not carry, and `run.start` is
 * refused: the engine's token is for this run and no other.
 */
export const PINNED_RUN_ENV = "NIGHTSHIFT_PINNED_RUN";

export const pinnedRunOf = (
  value: string | undefined,
): { projectId: string; programId: string; runId: string } | undefined => {
  if (value === undefined || value === "") return undefined;
  const [projectId, programId, runId] = value.split("/");
  if (projectId === undefined || programId === undefined || runId === undefined) return undefined;
  return { projectId, programId, runId };
};

export interface HeadlessInput {
  readonly scope: RunScope;
  /**
   * P10 (T6): this root is a replacement's, after the machine that was running
   * the run was lost. The run is `running`, not `pending`; what was in flight
   * on the lost machine is marked interrupted first, and the root is told.
   */
  readonly recovering?: { readonly generation: number };
  /** The operator's clone: what the run integrates into. */
  readonly repoPath: string;
  /** The human's choice of orchestrator (A-38). Absent means the contract's own routing. */
  readonly harness?: string;
  readonly model?: string;
}

export interface HeadlessResult {
  readonly exit: HarnessExit;
  /** The run as the control plane records it once the root has gone. */
  readonly run: Run;
  readonly agentId: Agent["agentId"];
  readonly transcript: string;
  /** Every root's transcript, in order, when a limit replaced one (D-P8-06, as amended 2026-10-12). */
  readonly transcripts: readonly { readonly agentId: Agent["agentId"]; readonly path: string }[];
  /** Every root's measurement summary, in order: each root is its own agent with its own summary. */
  readonly measurements: readonly {
    readonly agentId: Agent["agentId"];
    readonly measurementSummaryId: string;
  }[];
}

/**
 * How many times a root stopped by a usage limit is replaced on another route
 * before the run is left to the runner's own recovery. More than an
 * orchestrator's list is long in practice.
 */
const MAX_ROOT_RELAUNCHES = 4;

export class HeadlessRefusal extends Error {
  override readonly name = "HeadlessRefusal";
}

/** The launch for the root's own MCP server: the orchestrator role, in the program checkout. */
export const rootLaunch = (
  env: Env,
  input: { readonly repoPath: string; readonly agentId: string },
): McpLaunch => {
  const binary = fileURLToPath(new URL("./bin/nightshift-mcp.js", import.meta.url));
  // The operator's own session, as a human's orchestrator has: whatever of these
  // this process was given. A worker never sees any of them.
  const passThrough: Record<string, string> = {};
  for (const name of [
    "NIGHTSHIFT_CONFIG_DIR",
    "NIGHTSHIFT_STATE_DIR",
    "NIGHTSHIFT_API_ENDPOINT",
    "NIGHTSHIFT_API_TOKEN",
    "NIGHTSHIFT_API_TOKEN_FILE",
    "NIGHTSHIFT_PINNED_RUN",
    // Which machine, so prerequisites are judged by its own check (D-P7-10).
    "NIGHTSHIFT_DISPATCH_GENERATION",
    "NIGHTSHIFT_PROJECT_USER",
    "NIGHTSHIFT_PROJECT_CREDENTIAL_DIR",
    // The project environment's file (P16 S-01): the engine threads it to project steps (D-10).
    "NIGHTSHIFT_PROJECT_ENV_FILE",
    "NIGHTSHIFT_REMOTE_WORKSPACE",
    "NIGHTSHIFT_PUBLISH_BASE",
    "NIGHTSHIFT_PUBLISH_PACK_DIR",
    // The org's provider keys, as the heartbeat handed them to the engine on a
    // machine (D-P10-23); on a laptop, whatever the operator's shell holds.
    "ANTHROPIC_API_KEY",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "OPENAI_API_KEY",
    "CODEX_HOME",
    "NIGHTSHIFT_HARNESS_MODULE",
    "NIGHTSHIFT_JOB_WAIT_CAP_SECONDS",
    "HOME",
    "USERPROFILE",
    "LOCALAPPDATA",
    "XDG_CONFIG_HOME",
    "XDG_STATE_HOME",
    "PATH",
    "Path",
  ]) {
    const value = env[name];
    if (value !== undefined && value !== "") passThrough[name] = value;
  }
  return {
    name: "nightshift",
    command: process.execPath,
    args: [binary],
    env: {
      ...passThrough,
      NIGHTSHIFT_ROLE: "orchestrator",
      [REPO_PATH_ENV]: input.repoPath,
      [ROOT_AGENT_ENV]: input.agentId,
    },
  };
};

const requireRecords = async (
  runtime: Runtime,
  scope: RunScope,
): Promise<{ program: ProgramContract; run: Run; rootNode: ExecutionNode; planText: string }> => {
  const { stores } = runtime;
  const program = await stores.programContracts.get(scope.projectId, scope.programId);
  const run = await stores.runs.get(scope, scope.runId);
  if (program === undefined || run === undefined) {
    throw new HeadlessRefusal(`run ${scope.runId} does not exist in program ${scope.programId}`);
  }
  if (!isPlanned(program) || program.status !== "ratified") {
    throw new HeadlessRefusal(
      `program ${scope.programId} has no ratified plan, and an unattended run follows one`,
    );
  }
  const rootNode = await stores.executionNodes.get(scope, run.rootNodeId);
  const sha256 = rootNode?.plan?.planDocument.sha256;
  const planText = sha256 === undefined ? undefined : await runtime.planText?.(scope, sha256);
  if (rootNode === undefined || planText === undefined) {
    throw new HeadlessRefusal(
      `the control plane could not supply the plan run ${scope.runId} was ratified with`,
    );
  }
  return { program, run, rootNode, planText };
};

/** What the orphan sweep did to the lost machine's work, for the root's brief. */
export interface Orphans {
  /** Workers/orchestrators that were running; an explicit retry keeps their work. */
  readonly interrupted: readonly string[];
  /** Accepted jobs and completed candidates, adopted by the engine without redelegating. */
  readonly preserved: readonly string[];
}

/**
 * Interrupt dead agent processes, not their durable work. Queued jobs and
 * completed candidates retain their states for Engine.recover; only running
 * worker/sub-program nodes require an explicit retry. The root node itself
 * remains running while its old agent is interrupted and replaced.
 */
export const interruptOrphans = async (
  stores: Pick<NightshiftStores, "executionNodes" | "agents">,
  scope: RunScope,
  at: string,
  generation: number,
): Promise<Orphans> => {
  const reason = `the runner process ended; the run resumed at generation ${generation}`;
  const interrupted: string[] = [];
  const preserved: string[] = [];
  const interruptAgentsOf = async (nodeId: ExecutionNode["executionNodeId"]) => {
    for (const agent of await stores.agents.listByNode(scope, nodeId)) {
      if (!canTransitionAgent(agent.status, "interrupt")) continue;
      await stores.agents.put(transitionAgent(agent, "interrupt", { at, outcomeReason: reason }));
    }
  };
  let cursor: string | undefined;
  do {
    const page = await stores.executionNodes.listByRun(scope, {
      limit: 500,
      ...(cursor === undefined ? {} : { cursor }),
    });
    for (const node of page.items) {
      await interruptAgentsOf(node.executionNodeId);
      if (node.kind === "program") continue;
      if (node.status === "running") {
        await stores.executionNodes.put({
          ...transition(node, "interrupt", at),
          outcomeReason: reason,
        });
        interrupted.push(node.executionNodeId);
      } else if (
        ["queued", "implemented", "verifying", "verified", "examining", "sealed"].includes(
          node.status,
        )
      ) {
        preserved.push(node.executionNodeId);
      }
    }
    cursor = page.cursor;
  } while (cursor !== undefined);
  return { interrupted, preserved };
};

/** What a resuming root is told before the plan. */
export const recoveryNote = (generation: number, orphans: Orphans): string => {
  const lines = [
    `# This run is resuming after a runner restart (generation ${generation})`,
    "",
    "The previous runner process stopped, or its machine was replaced. Attach to this run with",
    "`run.attach`: the engine adopts retained queued jobs and completed candidates from the",
    "control-plane records. Read every strand's current state before doing more work.",
  ];
  if (orphans.interrupted.length + orphans.preserved.length === 0) {
    lines.push("No job was in flight when the machine was lost.");
  }
  if (orphans.interrupted.length > 0) {
    lines.push(
      `${orphans.interrupted.length} running node(s) are marked interrupted (${orphans.interrupted.join(", ")}). Inspect their kept work and retry with job.retry. Retry interrupted sub-program parents before their children: retained queued children can proceed once their parent runs again. Do not redelegate the same strands.`,
    );
  }
  if (orphans.preserved.length > 0) {
    lines.push(
      `${orphans.preserved.length} accepted job(s) or completed candidate(s) were preserved (${orphans.preserved.join(", ")}). The engine resumes their existing queue/verification/examination/integration stages; do not retry or redelegate them merely because the runner restarted.`,
    );
  }
  lines.push(
    "Then carry on with the plan below as if nothing had happened. Do not redo integrated strands.",
  );
  return lines.join("\n");
};

/** What the root is told before the plan when strands were carried over from an earlier run. */
const carriedNote = (carried: NonNullable<Run["carriedStrands"]>): string =>
  "Some strands of this plan were already built by an earlier run of it, and everything they " +
  "landed is on the program branch this run starts from. They count as succeeded here; do not " +
  `delegate them: ${carried.map((strand) => `${strand.strandId} (run ${strand.fromRunId})`).join(", ")}. ` +
  "Delegate every other strand as usual.";

/** Preparation is an observable operation the root can repair, not an admission gate. */
export const remoteEnvironmentNote = [
  "# Project environment on this machine",
  "Attach with run.attach, then inspect environment.status. For an unprepared or interrupted",
  "environment, call environment.prepare; it starts asynchronously, so follow environment.status",
  "for progress and the setup log. If preparation fails, diagnose its recorded error, repair the",
  "environment or repository setup, then call environment.prepare again. A setup failure does",
  "not end this run and does not require a new run or a special repair strand. Run project",
  "commands as the project user, not as the engine; environment.prepare does that for setup.",
  "Use this information to sequence useful work; preparation is not a delegation certificate.",
  "Required verification and examination still decide what can integrate.",
].join("\n");

/**
 * Starts the root orchestrator and waits for it to go. Resolves with how the
 * process ended and how the **run** ended, which are two facts: a root that
 * exits without `run.finish` leaves a run its own server's shutdown has
 * interrupted, and the caller reports that rather than guessing.
 */
export const runHeadless = (
  runtime: Runtime,
  env: Env,
  input: HeadlessInput,
): Promise<HeadlessResult> =>
  replacingLimitedRoots(runtime.clock, input, (launch, unavailable, limitNote) =>
    launchRoot(runtime, env, launch, unavailable, limitNote),
  );

/** One root's launch and how it ended, and the route it ran on. */
export type RootLaunch = (
  input: HeadlessInput,
  unavailable: readonly { readonly harness: string; readonly model: string }[],
  limitNote: string | undefined,
) => Promise<RootEnding>;

/** What one root's launch reports: the result so far, its route and its summary. */
export type RootEnding = Omit<HeadlessResult, "transcripts" | "measurements"> & {
  readonly route: RouteTarget;
  readonly measurementSummaryId: string;
};

/**
 * A root a usage limit stopped, on a run still running, is replaced by one on
 * the next route (D-P8-06, as amended 2026-10-12). It takes over as a runner
 * restart's root does: what the last one had in flight is on the record. Every
 * other ending is the run's, as it always was.
 */
export const replacingLimitedRoots = async (
  clock: Runtime["clock"],
  input: HeadlessInput,
  launchOne: RootLaunch,
): Promise<HeadlessResult> => {
  const routes = createRouteAvailability(clock);
  const transcripts: { agentId: Agent["agentId"]; path: string }[] = [];
  const measurements: { agentId: Agent["agentId"]; measurementSummaryId: string }[] = [];
  let launch: HeadlessInput = input;
  let limitNote: string | undefined;
  for (let relaunch = 0; ; relaunch += 1) {
    const ended = await launchOne(launch, routes.unavailable(), limitNote);
    transcripts.push({ agentId: ended.agentId, path: ended.transcript });
    measurements.push({
      agentId: ended.agentId,
      measurementSummaryId: ended.measurementSummaryId,
    });
    const { exit } = ended;
    if (
      exit.kind !== "failed" ||
      exit.unavailable === undefined ||
      ended.run.status !== "running" ||
      relaunch >= MAX_ROOT_RELAUNCHES
    ) {
      const { route: _route, measurementSummaryId: _summary, ...result } = ended;
      return { ...result, transcripts, measurements };
    }
    routes.markUnavailable(ended.route, unavailableUntil(exit, clock));
    limitNote = rootLimitNote(ended.route.model, exit.unavailable);
    // The human's pin was for the route that is now out: the next root is routed.
    launch = {
      scope: input.scope,
      repoPath: input.repoPath,
      recovering: { generation: input.recovering?.generation ?? 0 },
    };
  }
};

/** What a root that replaces one a usage limit stopped is told first. */
const rootLimitNote = (model: string, reason: string): string =>
  [
    "# The previous orchestrator was stopped by a usage limit",
    "",
    `It ran on ${model} and the provider stopped it (${reason}). You take over on another`,
    "route. Its delegations, and anything it recorded, are on the control plane: read them",
    "before acting, and carry on from there.",
  ].join("\n");

/** The root's recorder: no routing decision, so the summary's `route` is the only record of the choice. */
const rootRecorder = (
  runtime: Runtime,
  outbox: EventOutbox,
  run: Run,
  root: {
    readonly scope: RunScope;
    readonly rootNode: ExecutionNode;
    readonly agent: Agent;
    readonly route: RouteTarget;
  },
) => {
  const price = run.policy?.routingPolicy.prices[root.route.model];
  return createMeasurementRecorder(
    {
      stores: runtime.stores,
      bodies: runtime.bodies,
      clock: runtime.clock,
      ids: runtime.ids,
      paths: runtime.paths,
      outbox,
    },
    {
      scope: root.scope,
      executionNodeId: root.rootNode.executionNodeId,
      agent: root.agent,
      route: root.route,
      routingDecisionId: null,
      ...(price === undefined ? {} : { price }),
    },
  );
};

export const launchRoot = async (
  runtime: Runtime,
  env: Env,
  input: HeadlessInput,
  unavailable: readonly { readonly harness: string; readonly model: string }[],
  limitNote: string | undefined,
): Promise<RootEnding> => {
  const { stores, clock, ids } = runtime;
  const { scope } = input;
  const { program, run, rootNode, planText } = await requireRecords(runtime, scope);
  const resuming = input.recovering !== undefined && run.status === "running";
  if (isSettled(rootNode.status) || (run.status !== "pending" && !resuming)) {
    throw new HeadlessRefusal(
      `run ${scope.runId} is ${run.status}; an unattended run starts a pending one`,
    );
  }
  // What the lost machine was doing is over: nodes and agents in flight there
  // are interrupted on the record, so the root can retry them (T6).
  const orphans = resuming
    ? await interruptOrphans(stores, scope, nowIso(clock), input.recovering?.generation ?? 0)
    : { interrupted: [], preserved: [] };

  // Not persisted: the program node has no Job Contract. It carries the plan to
  // the brief through the one adapter contract every node is started with.
  const brief: JobContract = JobContractSchema.parse({
    schemaVersion: 1,
    ...scope,
    jobContractId: ids.next("job"),
    objective: [
      ...(limitNote === undefined ? [] : [limitNote]),
      ...(resuming ? [recoveryNote(input.recovering?.generation ?? 0, orphans)] : []),
      ...(env.NIGHTSHIFT_REMOTE_WORKSPACE === undefined ? [] : [remoteEnvironmentNote]),
      ...(run.carriedStrands === undefined || run.carriedStrands.length === 0
        ? []
        : [carriedNote(run.carriedStrands)]),
      planText,
    ].join("\n\n"),
    acceptance: ["every strand of the ratified plan has succeeded, or is parked with a reason"],
    dependencies: [],
    risk: program.defaultRisk,
    ambiguity: "medium",
    kind: "orchestrate",
    createdAt: nowIso(clock),
  });
  // The human picks the orchestrator's model when they say one (D-P5-05);
  // otherwise the run's rules place an orchestrator, as for any other (D-P8-04).
  const route = routeJob(run, program, brief, {
    pins: { harness: input.harness, model: input.model },
    unavailable,
  });

  const agent: Agent = {
    schemaVersion: 1,
    ...scope,
    agentId: ids.next("agent"),
    executionNodeId: rootNode.executionNodeId,
    role: "orchestrator",
    harness: route.target.harness,
    provider: route.target.provider,
    model: route.target.model,
    status: "created",
    createdAt: nowIso(clock),
  };
  await stores.agents.put(agent);
  const startupOperation = lifecycleOperationId("startup", rootNode.executionNodeId, "1");
  const workOperation = lifecycleOperationId("work", rootNode.executionNodeId, "1");
  const startupAt = nowIso(clock);

  const base = await revParse(runtime.git, input.repoPath, program.repository.programBranch);
  const worktree = runtime.paths.worktree(scope.runId, rootNode.executionNodeId);
  await mkdir(dirname(worktree), { recursive: true });
  if (resuming) {
    // The checkout came back from the sidecar with the lost root's worktree in
    // it (T6); this root gets a fresh one at the same path.
    await tryGit(runtime.git, ["worktree", "remove", "--force", worktree], { cwd: input.repoPath });
    await rm(worktree, { recursive: true, force: true });
  }
  await pruneWorktrees(runtime.git, input.repoPath);
  await addDetachedWorktree(runtime.git, { repo: input.repoPath, path: worktree, base });
  // The root's temp directory, beside its worktree, like every agent's (scratch.ts).
  const tmpDir = await freshScratch(runtime.paths, worktree);

  const transcript = runtime.paths.transcript(scope.runId, agent.agentId);
  await mkdir(dirname(transcript), { recursive: true });
  const outbox = createEventOutbox({
    events: stores.events,
    scope,
    clock,
    ids,
    // Its own writer, so its keys never collide with the server's (A-30).
    writerId: `${agent.agentId}-launcher`,
  });

  // The root has no routing decision: the human's pin, or the routed choice, is the summary's route.
  const recorder = rootRecorder(runtime, outbox, run, {
    scope,
    rootNode,
    agent,
    route: route.target,
  });
  // Observation only (P20): the root's startup and work, told as any node's are.
  const observe = (
    rest: Omit<Parameters<typeof observeLifecycle>[1], "scope" | "nodeId" | "agentId" | "attempt">,
  ) =>
    observeLifecycle(
      { outbox, clock, ids },
      {
        scope,
        nodeId: rootNode.executionNodeId,
        agentId: agent.agentId,
        attempt: 1,
        ...rest,
      },
    );
  observe({
    operationId: startupOperation,
    phase: "startup",
    transition: "start",
    occurredAt: startupAt,
  });
  let exit: HarnessExit;
  let processStarted = false;
  try {
    const launch = await recorder.startSegment({ resumedSession: false });
    const handle = await runtime.harness.start({
      agent,
      node: rootNode,
      job: brief,
      program,
      worktree,
      tmpDir,
      model: route.target,
      mcp: rootLaunch(env, { repoPath: input.repoPath, agentId: agent.agentId }),
      tools: refusingWorkerTools("the root orchestrator reaches Nightshift through its MCP launch"),
      sink: createHookSink({
        outbox,
        executionNodeId: rootNode.executionNodeId,
        agentId: agent.agentId,
      }),
      transcriptPath: transcript,
      launch,
      measurements: recorder.sink,
    });
    processStarted = true;
    observe({
      operationId: startupOperation,
      phase: "startup",
      transition: "end",
      reason: "process started",
      launch,
      recorder,
    });
    observe({ operationId: workOperation, phase: "work", transition: "start", launch, recorder });
    exit = await handle.exit;
    observe({
      operationId: workOperation,
      phase: "work",
      transition: "end",
      reason: exit.kind,
      launch,
      recorder,
    });
  } catch (error) {
    if (!processStarted) {
      observe({
        operationId: startupOperation,
        phase: "startup",
        transition: "end",
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    await recorder.close({ kind: "failed", exitCode: 127 }).catch(() => {});
    throw error;
  }
  const { summary } = await recorder.close(exit);
  await outbox.flush(5_000).catch(() => {});

  const ended = (await stores.runs.get(scope, scope.runId)) ?? run;
  return {
    exit,
    run: ended,
    agentId: agent.agentId,
    transcript,
    route: route.target,
    measurementSummaryId: summary.measurementSummaryId,
  };
};

export const describeHeadlessEnding = (result: HeadlessResult): string =>
  `${describeExit(result.exit)}; run ${result.run.runId} is ${result.run.status}` +
  (result.run.outcomeReason === undefined ? "" : ` (${result.run.outcomeReason})`);

export type { RunId };
