/**
 * Integration order and sub-program endings (P6, D-P6-03, D-P6-05).
 *
 * Both are questions about a run's tree that more than one process has to answer
 * the same way, so both are pure functions here rather than logic in an engine.
 */
import type { ExecutionNode, ExecutionNodeId, ExecutionNodeStatus } from "@nightshift/contracts";
import { descendantsOf, type ExecutionTree, getNode } from "./execution-tree.js";
import { RETRYABLE_STATUSES, TERMINAL_STATUSES } from "./transitions.js";

/**
 * Statuses in which nothing further happens to a node unless somebody decides
 * it should: the terminal ones, and the retryable ones, which wait for a retry
 * nobody is obliged to make.
 */
export const SETTLED_STATUSES: readonly ExecutionNodeStatus[] = [
  ...TERMINAL_STATUSES,
  ...RETRYABLE_STATUSES,
];

export const isSettled = (status: ExecutionNodeStatus): boolean =>
  SETTLED_STATUSES.includes(status);

/**
 * Settled, **or deferred** (P7, D-P7-10): nothing further happens to the node in
 * this sitting. A deferred node waits on a human, on the run's provisional line,
 * so whoever is waiting for it stops waiting and whoever delegated it may end;
 * it is still not settled, because `nightshift resume` has checks left to run.
 */
export const isDoneForNow = (status: ExecutionNodeStatus): boolean =>
  isSettled(status) || status === "deferred";

/**
 * The next node the merge queue takes (D-P6-05): among **job** nodes that are
 * `implemented`, the one delegated first.
 *
 * Delegation order is the node identifier's own order: identifiers are ULIDs,
 * minted when the node is delegated, so they sort by time and then by a
 * monotonic counter. The answer therefore depends only on *which* nodes are
 * ready, never on the order they were listed in, on when their workers happened
 * to finish, or on any node that is not ready. That is what "integration order
 * is deterministic" means: the queue never waits for unfinished work, and among
 * finished work it never races.
 */
export const nextToIntegrate = (nodes: readonly ExecutionNode[]): ExecutionNode | undefined => {
  let next: ExecutionNode | undefined;
  for (const node of nodes) {
    if (node.kind !== "job" || node.status !== "implemented") continue;
    if (next === undefined || node.executionNodeId < next.executionNodeId) next = node;
  }
  return next;
};

export type ProgramNodeEndingCheck =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly reason: "is_a_job" | "not_running" | "unsettled_descendants";
      readonly unsettled: readonly ExecutionNodeId[];
    };

/**
 * Whether a program or sub-program node may be ended `succeeded` (D-P6-03): it
 * is `running`, and none of its descendants is still in flight. The same rule
 * for the root as for a sub-program, because it is the same mistake in both.
 *
 * The ending is the orchestrator's claim about its objective, and like a
 * worker's it is only a claim: code reached the branch through verification or
 * not at all (A-05). What this rule prevents is an orchestrator walking away
 * from work that is still running under its name.
 */
export const mayEndProgramNode = (
  tree: ExecutionTree,
  nodeId: ExecutionNodeId,
): ProgramNodeEndingCheck => {
  const node = getNode(tree, nodeId);
  if (node.kind === "job") return { allowed: false, reason: "is_a_job", unsettled: [] };
  if (node.status !== "running") return { allowed: false, reason: "not_running", unsettled: [] };
  const unsettled = descendantsOf(tree, nodeId).filter(
    (descendant) => !isDoneForNow(getNode(tree, descendant).status),
  );
  return unsettled.length === 0
    ? { allowed: true }
    : { allowed: false, reason: "unsettled_descendants", unsettled };
};
