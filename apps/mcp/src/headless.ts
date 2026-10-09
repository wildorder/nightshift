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
  type ProgramContract,
  type Run,
  type RunId,
} from "@nightshift/contracts";
import {
  canTransition,
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
  freshScratch,
  pruneWorktrees,
  revParse,
  tryGit,
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
}

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
    "NIGHTSHIFT_WORKER_USERS",
    "NIGHTSHIFT_WORKER_CREDENTIAL_DIR",
    // The project environment's file (P16 S-01): the engine takes it as its own.
    "NIGHTSHIFT_PROJECT_ENV_FILE",
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
  /** Interrupted: were running, verifying or examining; `job_retry` takes them up from their kept work. */
  readonly interrupted: readonly string[];
  /** Failed: were implemented and awaiting verification that never ran; `job_retry` reruns them. */
  readonly failed: readonly string[];
  /** Cancelled: were queued in an engine that is gone; their strands are delegated again. */
  readonly cancelled: readonly string[];
}

/**
 * The nodes and agents the lost machine left in flight, settled on the record
 * so the root can take them up (T6). The transition table decides what each
 * becomes: a node that was running, verifying or examining is `interrupted`
 * (retryable); one implemented but not yet verified is `failed` (retryable);
 * one queued in the dead engine is `cancelled`, and its strand is delegated
 * anew. Started agents of all of them, and the lost machine's root, are
 * interrupted.
 */
export const interruptOrphans = async (
  stores: Pick<NightshiftStores, "executionNodes" | "agents">,
  scope: RunScope,
  at: string,
  generation: number,
): Promise<Orphans> => {
  const reason = `the machine running this was lost; the run resumed on a replacement at generation ${generation}`;
  const interrupted: string[] = [];
  const failed: string[] = [];
  const cancelled: string[] = [];
  const nodes = (await stores.executionNodes.listByRun(scope, { limit: 500 })).items;
  const interruptAgentsOf = async (nodeId: ExecutionNode["executionNodeId"]) => {
    for (const agent of await stores.agents.listByNode(scope, nodeId)) {
      if (!canTransitionAgent(agent.status, "interrupt")) continue;
      await stores.agents.put(transitionAgent(agent, "interrupt", { at, outcomeReason: reason }));
    }
  };
  for (const node of nodes) {
    if (node.kind === "program") {
      // The lost machine's root: this process starts its own.
      await interruptAgentsOf(node.executionNodeId);
      continue;
    }
    const event = canTransition(node.status, "interrupt")
      ? "interrupt"
      : node.status === "implemented"
        ? "fail"
        : node.status === "queued"
          ? "cancel"
          : undefined;
    if (event === undefined) continue;
    await stores.executionNodes.put({ ...transition(node, event, at), outcomeReason: reason });
    (event === "interrupt" ? interrupted : event === "fail" ? failed : cancelled).push(
      node.executionNodeId,
    );
    await interruptAgentsOf(node.executionNodeId);
  }
  return { interrupted, failed, cancelled };
};

/** What a resuming root is told before the plan. */
export const recoveryNote = (generation: number, orphans: Orphans): string => {
  const lines = [
    `# This run is resuming after a machine failure (replacement machine, generation ${generation})`,
    "",
    "The machine running this run was lost and this is its replacement. The run's record on the",
    "control plane is complete: strands already integrated stay integrated, and nothing lands",
    "twice. Attach to this run with `run.attach`, then read the state of every strand.",
  ];
  if (orphans.interrupted.length + orphans.failed.length + orphans.cancelled.length === 0) {
    lines.push("No job was in flight when the machine was lost.");
  }
  if (orphans.interrupted.length > 0) {
    lines.push(
      `${orphans.interrupted.length} job(s) were in flight and are marked interrupted (${orphans.interrupted.join(", ")}); their worktrees, with whatever work was done, were restored from the sidecar. Retry each with job_retry: the retry starts from the kept work.`,
    );
  }
  if (orphans.failed.length > 0) {
    lines.push(
      `${orphans.failed.length} job(s) had been implemented but never verified and are marked failed (${orphans.failed.join(", ")}). Retry each with job_retry.`,
    );
  }
  if (orphans.cancelled.length > 0) {
    lines.push(
      `${orphans.cancelled.length} job(s) were queued and never started and are marked cancelled (${orphans.cancelled.join(", ")}). Delegate their strands again.`,
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

/**
 * Starts the root orchestrator and waits for it to go. Resolves with how the
 * process ended and how the **run** ended, which are two facts: a root that
 * exits without `run.finish` leaves a run its own server's shutdown has
 * interrupted, and the caller reports that rather than guessing.
 */
export const runHeadless = async (
  runtime: Runtime,
  env: Env,
  input: HeadlessInput,
): Promise<HeadlessResult> => {
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
    : { interrupted: [], failed: [], cancelled: [] };

  // Not persisted: the program node has no Job Contract. It carries the plan to
  // the brief through the one adapter contract every node is started with.
  const brief: JobContract = JobContractSchema.parse({
    schemaVersion: 1,
    ...scope,
    jobContractId: ids.next("job"),
    objective: [
      ...(resuming ? [recoveryNote(input.recovering?.generation ?? 0, orphans)] : []),
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
    unavailable: [],
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
  });
  const exit = await handle.exit;
  await outbox.flush(5_000).catch(() => {});

  const ended = (await stores.runs.get(scope, scope.runId)) ?? run;
  return { exit, run: ended, agentId: agent.agentId, transcript };
};

export const describeHeadlessEnding = (result: HeadlessResult): string =>
  `${describeExit(result.exit)}; run ${result.run.runId} is ${result.run.status}` +
  (result.run.outcomeReason === undefined ? "" : ` (${result.run.outcomeReason})`);

export type { RunId };
