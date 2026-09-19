/**
 * The worker-side half of a job (T5 deliverable 7).
 *
 * The four worker operations and the one object that bundles them,
 * {@link createWorkerTools}. They live here rather than in `apps/mcp` so that
 * "what a completed job is" has exactly one implementation. Two callers reach
 * it, and neither knows about the other (A-37): the **worker** role of the MCP
 * server, when a local harness's model calls a tool over stdio; and an adapter
 * whose harness calls back into its own process, through
 * `HarnessStartInput.tools`.
 *
 * ## The seam this module sits on is A-05
 *
 * `implemented ≠ verified`. Everything here is worker-initiated, and **nothing
 * here may move a node past `implemented` or write a `Verification`.** There is
 * deliberately no function in this file that could: the furthest `completeJob`
 * goes is `markImplemented`, which `core` will only apply from `running`, and
 * the `Verification` record's only writer is the execution layer's own
 * verification step (D-P3-06).
 *
 * A worker can therefore claim completion and be wrong, which is the point. What
 * it cannot do is make that claim into a verdict.
 */
import type { Decision, ExecutionNode, JobContract } from "@nightshift/contracts";
import {
  type IdGenerator,
  markImplemented,
  nowIso,
  type ProjectStores,
  transition,
} from "@nightshift/core";
import {
  NoCheckpointError,
  type WorkerCompletion,
  type WorkerDecisionInput,
  type WorkerTools,
} from "@nightshift/harness";
import type { WorkerEnvironment, WorkerIdentity } from "./environment.js";
import { baseRef, changedPaths, revParse, snapshotCommit } from "./git/index.js";
import { checkChangedPaths, describeScopeViolation } from "./scope-check.js";

/** The same shape the adapter contract names, so the two cannot drift. */
export type CompleteJobResult = WorkerCompletion;

const requireNode = async (
  stores: ProjectStores,
  identity: WorkerIdentity,
): Promise<ExecutionNode> => {
  const node = await stores.executionNodes.get(identity.scope, identity.executionNodeId);
  if (node === undefined) {
    throw new Error(`execution node ${identity.executionNodeId} does not exist in this run`);
  }
  return node;
};

const requireJob = async (
  stores: ProjectStores,
  identity: WorkerIdentity,
): Promise<JobContract> => {
  const job = await stores.jobContracts.get(identity.scope, identity.jobContractId);
  if (job === undefined) {
    throw new Error(`job contract ${identity.jobContractId} does not exist in this run`);
  }
  return job;
};

/**
 * The worker's report of progress. Intent, not ground truth (A-30).
 *
 * `source: "mcp"` because the worker chose to say this. A worker that says
 * nothing produces no `node.progress` events at all, and the absence is exactly
 * what makes the hook channel worth having.
 */
export const reportProgress = (
  environment: WorkerEnvironment,
  identity: WorkerIdentity,
  message: string,
  percent?: number,
): void => {
  environment.outbox.emit({
    type: "node.progress",
    source: "mcp",
    payload: percent === undefined ? { message } : { message, percent },
    executionNodeId: identity.executionNodeId,
    agentId: identity.agentId,
  });
};

/**
 * Collects the worker's work into one Nightshift-authored commit and moves the
 * node to `implemented` (D-P3-05).
 *
 * The order is the whole of it:
 *
 * 1. Snapshot the worktree into a single commit on the base, squashing anything
 *    the worker committed along the way.
 * 2. Compare the commit's changed paths against the node's **effective** scope.
 * 3. On a violation, fail the job durably, naming every offending path, and
 *    return — the node never reaches `implemented`, so nothing downstream can
 *    verify or integrate it.
 * 4. Otherwise `markImplemented`, which records the commit on the node.
 *
 * The scope check is after the commit rather than before because the commit is
 * what defines the change set: a check over the working tree would miss a
 * deletion staged and then restored, and this way the thing checked is exactly
 * the thing that would integrate.
 */
export const completeJob = async (
  environment: WorkerEnvironment,
  identity: WorkerIdentity,
  summary: string,
): Promise<CompleteJobResult> => {
  const { stores, git: runner, clock, outbox } = environment;
  const node = await requireNode(stores, identity);
  const job = await requireJob(stores, identity);

  // The commit the worktree was cut from, read from the ref the runner wrote
  // there. Not `HEAD`: the worker may have committed, and the snapshot's parent
  // must be the base, not whatever the worker last did.
  const base = await revParse(runner, identity.worktree, baseRef(identity.executionNodeId));
  const atMs = clock.now();
  const commitSha = await snapshotCommit(runner, {
    worktree: identity.worktree,
    base,
    message: summary,
    trailers: {
      "Nightshift-Run": identity.scope.runId,
      "Nightshift-Node": identity.executionNodeId,
      "Nightshift-Job": identity.jobContractId,
    },
    atMs,
  });

  const paths = await changedPaths(runner, identity.worktree, base, commitSha);
  const check = checkChangedPaths(node.scope, paths);

  if (!check.allowed) {
    const reason = describeScopeViolation(check.offending);
    await failJob(environment, identity, reason);
    return { kind: "scope_violation", offending: check.offending, reason };
  }

  await stores.executionNodes.put(markImplemented(node, commitSha, nowIso(clock)));
  outbox.emit({
    type: "node.implemented",
    source: "mcp",
    payload: {
      commitSha,
      jobContractId: job.jobContractId,
      summary: summary.slice(0, 2_000),
      changedPaths: paths.slice(0, 50),
      changedPathCount: paths.length,
    },
    executionNodeId: identity.executionNodeId,
    agentId: identity.agentId,
  });

  return { kind: "implemented", commitSha, changedPaths: paths };
};

/**
 * Durable failure with the worker's own reason.
 *
 * Called by the worker's `job.fail`, and by `completeJob` when the snapshot
 * strayed outside scope. The node's `outcomeReason` is what a human reads, so
 * the reason is stored before anything else happens and is never summarised
 * away.
 */
export const failJob = async (
  environment: WorkerEnvironment,
  identity: WorkerIdentity,
  reason: string,
): Promise<void> => {
  const { stores, clock, outbox } = environment;
  const node = await requireNode(stores, identity);
  const at = nowIso(clock);

  // A node already terminal — cancelled by the orchestrator while the worker was
  // deciding to fail — is left as it is. The first durable outcome wins.
  if (node.status !== "running") return;

  await stores.executionNodes.put({ ...transition(node, "fail", at), outcomeReason: reason });
  outbox.emit({
    type: "node.failed",
    source: "mcp",
    payload: { reason },
    executionNodeId: identity.executionNodeId,
    agentId: identity.agentId,
  });
};

/**
 * A decision on the worker's own node, against the run's latest checkpoint.
 *
 * On its own node, not the run's root: this is the worker's decision, and the
 * replay cone (P8) is computed from where a decision was made.
 */
export const recordWorkerDecision = async (
  environment: WorkerEnvironment,
  identity: WorkerIdentity,
  ids: IdGenerator,
  input: WorkerDecisionInput,
): Promise<Decision> => {
  const { stores, clock, outbox } = environment;
  const checkpoints = await stores.checkpoints.listByRun(identity.scope);
  const latest = checkpoints.items.at(-1);
  if (latest === undefined) throw new NoCheckpointError();

  const decisionId = ids.next("dec");
  const decision: Decision = {
    schemaVersion: 1,
    ...identity.scope,
    decisionId,
    executionNodeId: identity.executionNodeId,
    agentId: identity.agentId,
    context: input.context,
    alternatives: input.alternatives.map((alternative) =>
      alternative.rejectedBecause === undefined
        ? { summary: alternative.summary }
        : { summary: alternative.summary, rejectedBecause: alternative.rejectedBecause },
    ),
    choice: input.choice,
    rationale: input.rationale,
    reversibility: input.reversibility,
    checkpointBefore: latest.checkpointId,
    affectedNodes: [],
    authority: "agent",
    supersedesDecisionId: null,
    createdAt: nowIso(clock),
  };
  await stores.decisions.put(decision);
  outbox.emit({
    type: "decision.recorded",
    source: "mcp",
    payload: { decisionId, choice: input.choice },
    executionNodeId: identity.executionNodeId,
    agentId: identity.agentId,
  });
  return decision;
};

/** How long an ending waits for its own events to be delivered before returning. */
export const WORKER_FLUSH_DEADLINE_MS = 5_000;

/**
 * The four worker operations as one object (A-37).
 *
 * `complete` and `fail` flush before they return, because whatever called them
 * may be gone the moment they do: a harness kills its process when the model
 * says it is finished, and an unsent `node.implemented` would make a completed
 * job look like a silent one. `progress` and `recordDecision` do not wait; their
 * events ride the outbox in order and are flushed by the ending.
 */
export const createWorkerTools = (
  environment: WorkerEnvironment,
  identity: WorkerIdentity,
  ids: IdGenerator,
): WorkerTools => ({
  progress: async (message, percent) => {
    reportProgress(environment, identity, message, percent);
  },
  complete: async (summary) => {
    const result = await completeJob(environment, identity, summary);
    await environment.outbox.flush(WORKER_FLUSH_DEADLINE_MS);
    return result;
  },
  fail: async (reason) => {
    await failJob(environment, identity, reason);
    await environment.outbox.flush(WORKER_FLUSH_DEADLINE_MS);
  },
  recordDecision: (input) => recordWorkerDecision(environment, identity, ids, input),
});
