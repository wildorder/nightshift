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
import { mkdir } from "node:fs/promises";
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
import { isPlanned, isSettled, nowIso, type RunScope } from "@nightshift/core";
import {
  addDetachedWorktree,
  createEventOutbox,
  createHookSink,
  pruneWorktrees,
  revParse,
} from "@nightshift/execution";
import {
  describeExit,
  type HarnessExit,
  type McpLaunch,
  refusingWorkerTools,
} from "@nightshift/harness";
import { configuredRoute } from "@nightshift/routing";
import type { Runtime } from "./compose.js";
import type { Env } from "./role.js";

/** Set on the root's MCP server so `run.attach` adopts the agent started here instead of inventing one. */
export const ROOT_AGENT_ENV = "NIGHTSHIFT_ROOT_AGENT_ID";
/** The program checkout, which is not the root agent's working directory. */
export const REPO_PATH_ENV = "NIGHTSHIFT_REPO_PATH";

export interface HeadlessInput {
  readonly scope: RunScope;
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
  if (isSettled(rootNode.status) || run.status !== "pending") {
    throw new HeadlessRefusal(
      `run ${scope.runId} is ${run.status}; an unattended run starts a pending one`,
    );
  }

  // Not persisted: the program node has no Job Contract. It carries the plan to
  // the brief through the one adapter contract every node is started with.
  const brief: JobContract = JobContractSchema.parse({
    schemaVersion: 1,
    ...scope,
    jobContractId: ids.next("job"),
    objective: planText,
    scope: { includes: [...program.scope.includes] },
    acceptance: ["every strand of the ratified plan has succeeded, or is parked with a reason"],
    dependencies: [],
    risk: program.defaultRisk,
    ambiguity: program.defaultRisk,
    createdAt: nowIso(clock),
  });
  const route = configuredRoute({
    program,
    job: brief,
    override: { harness: input.harness, model: input.model },
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
  await pruneWorktrees(runtime.git, input.repoPath);
  await addDetachedWorktree(runtime.git, { repo: input.repoPath, path: worktree, base });

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
