/**
 * Graceful shutdown (T5 deliverable 9, contract §4.3).
 *
 * The orchestrator's MCP server dies when its session does — that is the cost
 * D-P3-04 states plainly in exchange for having no local daemon. What this
 * module buys is that the death is *tidy*: a running worker is cancelled, the
 * node and agent end `interrupted` with a reason, the run ends `interrupted`,
 * and whatever the outbox could not deliver is spilled to a spool file the next
 * server for that run replays.
 *
 * ## What this is not
 *
 * It is not recovery. A **hard** kill — SIGKILL, power loss — is explicitly out
 * of scope (contract §5): the worker process is orphaned, the node stays
 * `running`, and the next server does not reconcile it. That non-guarantee is
 * stated in the contract so nobody mistakes graceful shutdown for durability
 * against anything.
 *
 * Idempotent, because the two ways a server stops — stdin closing and a signal —
 * can both arrive.
 */

import type { ExecutionNodeId, RunStatus } from "@nightshift/contracts";
import { finishRun, nowIso, transition, transitionAgent } from "@nightshift/core";
import type { ExecutionEnvironment, RunSession } from "./environment.js";
import type { StartedJob } from "./runner.js";

export interface ShutdownInput {
  readonly session: RunSession;
  /** The job in flight, if there is one. */
  readonly job?: StartedJob | undefined;
  readonly reason: string;
  /** How long to wait for the outbox to drain before spilling what is left. */
  readonly flushDeadlineMs?: number;
}

export interface ShutdownResult {
  readonly cancelledJob: ExecutionNodeId | undefined;
  readonly eventsSpilled: number;
  readonly spoolPath: string;
}

/** Long enough for a healthy connection to drain a queue, short enough not to hang an exit. */
export const DEFAULT_FLUSH_DEADLINE_MS = 5_000;

export const shutdown = async (
  environment: ExecutionEnvironment,
  input: ShutdownInput,
): Promise<ShutdownResult> => {
  const { stores, clock, outbox } = environment;
  const at = nowIso(clock);
  let cancelledJob: ExecutionNodeId | undefined;

  // --- The worker in flight ------------------------------------------------------
  if (input.job !== undefined) {
    cancelledJob = input.job.nodeId;
    try {
      // `interrupted`, not `cancelled`: a human did not decide to stop this
      // work, a session ended underneath it (contract §4.3). The distinction is
      // what tells a reader later whether to retry — `interrupted` is in
      // `RETRYABLE_STATUSES`, `cancelled` is terminal. The lifecycle records
      // both the node and the agent as it settles.
      await input.job.stop("interrupted");
    } catch {
      // The adapter could not stop it, or the lifecycle failed on its way out.
      // The fallback below still writes the records: a node left `running`
      // because a kill failed is the worst of both worlds.
    }
    await interrupt(environment, input, input.job);
  }

  // --- The run -------------------------------------------------------------------
  const run = await stores.runs.get(input.session.scope, input.session.scope.runId);
  if (run !== undefined && run.status === "running") {
    await stores.runs.put({
      ...run,
      status: "interrupted",
      endedAt: at,
      outcomeReason: input.reason,
    });
    outbox.emit({
      type: "run.interrupted",
      source: "control-plane",
      payload: { reason: input.reason },
      executionNodeId: input.session.rootNodeId,
    });
    await endProgramNode(environment, input.session, "interrupted", input.reason);
  }

  // --- The events ----------------------------------------------------------------
  // Drain what can be drained, then spill the rest. The spool is a buffer, not a
  // store (A-06): nothing reads it to answer a question about run state.
  await outbox.flush(input.flushDeadlineMs ?? DEFAULT_FLUSH_DEADLINE_MS);
  const spoolPath = environment.paths.spool(input.session.scope.runId);
  const eventsSpilled = await outbox.spill(spoolPath);

  return { cancelledJob, eventsSpilled, spoolPath };
};

/**
 * The program node's ending, from its run's (D-P5-06): `core`'s `finishRun`,
 * applied. A root node that is not `running` is left alone, and a failure to
 * write it never stops a run from ending.
 */
export const endProgramNode = async (
  environment: Pick<ExecutionEnvironment, "stores" | "clock">,
  session: RunSession,
  runStatus: RunStatus,
  reason?: string,
): Promise<void> => {
  const { stores, clock } = environment;
  try {
    const root = await stores.executionNodes.get(session.scope, session.rootNodeId);
    if (root === undefined) return;
    const ended = finishRun(root, runStatus, nowIso(clock), reason);
    if (ended !== root) await stores.executionNodes.put(ended);
  } catch {
    // The run's own record is the authority on how the run ended.
  }
};

/**
 * The fallback for a node or agent the lifecycle did not settle.
 *
 * Normally `stop("interrupted")` has already written both, and this finds
 * nothing to do — which is the intended case, and why every branch here checks
 * the status first. It exists for the one that is not intended: a `stop` that
 * threw, or a worker that never started.
 */
const interrupt = async (
  environment: ExecutionEnvironment,
  input: ShutdownInput,
  job: StartedJob,
): Promise<void> => {
  const { stores, clock, outbox } = environment;
  const at = nowIso(clock);
  const reason = `the run was interrupted: ${input.reason}`;

  const agent = await stores.agents.get(input.session.scope, job.agentId);
  if (agent !== undefined && (agent.status === "started" || agent.status === "created")) {
    await stores.agents.put(
      transitionAgent(agent, agent.status === "created" ? "cancel" : "interrupt", {
        at,
        outcomeReason: reason,
      }),
    );
    outbox.emit({
      type: agent.status === "created" ? "agent.cancelled" : "agent.interrupted",
      source: "control-plane",
      payload: { reason },
      executionNodeId: job.nodeId,
      agentId: job.agentId,
    });
  }

  const node = await stores.executionNodes.get(input.session.scope, job.nodeId);
  if (node === undefined) return;
  // Already terminal — the worker reported, or `cancel` above got there first.
  // The first durable outcome wins; shutdown does not overwrite it.
  if (node.status !== "running" && node.status !== "queued") return;

  await stores.executionNodes.put({
    ...transition(node, node.status === "queued" ? "cancel" : "interrupt", at),
    outcomeReason: reason,
  });
  outbox.emit({
    type: node.status === "queued" ? "node.cancelled" : "node.interrupted",
    source: "control-plane",
    payload: { reason, worktree: job.worktree },
    executionNodeId: job.nodeId,
    agentId: job.agentId,
  });
};
