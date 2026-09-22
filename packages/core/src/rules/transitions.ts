/**
 * Execution-node state transitions (SC-P1-13, SC-P1-15).
 *
 * The table below is the whole state machine. It is exported so tests can
 * enumerate the full cartesian product of states and events and assert that
 * everything outside the table fails — a sampled test would let an illegal pair
 * slip through.
 *
 * The property that matters most: there is no path from `implemented` to
 * `sealed` or `integrated` that skips `verified` (A-05). `implemented` is what a
 * worker may claim. `verified` is what only Nightshift may assert.
 */
import type {
  ExecutionNode,
  ExecutionNodeStatus,
  IsoTimestamp,
  RunStatus,
} from "@nightshift/contracts";
import { IllegalTransitionError } from "../errors.js";

export type TransitionEvent =
  | "enqueue"
  | "start"
  | "report_implemented"
  | "begin_verification"
  | "verification_passed"
  | "verification_failed"
  | "defer"
  | "resume_verification"
  | "begin_examination"
  | "examination_passed"
  | "examination_failed"
  | "seal"
  | "integrate"
  | "fail"
  | "cancel"
  | "interrupt"
  | "retry";

export const TRANSITION_EVENTS: readonly TransitionEvent[] = [
  "enqueue",
  "start",
  "report_implemented",
  "begin_verification",
  "verification_passed",
  "verification_failed",
  "defer",
  "resume_verification",
  "begin_examination",
  "examination_passed",
  "examination_failed",
  "seal",
  "integrate",
  "fail",
  "cancel",
  "interrupt",
  "retry",
];

export const EXECUTION_NODE_STATUSES: readonly ExecutionNodeStatus[] = [
  "validated",
  "queued",
  "running",
  "implemented",
  "verifying",
  "deferred",
  "verified",
  "verification_failed",
  "examining",
  "examination_failed",
  "sealed",
  "integrated",
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
];

/** Nothing leaves these. A run that reaches one of them is settled. */
export const TERMINAL_STATUSES: readonly ExecutionNodeStatus[] = [
  "integrated",
  "succeeded",
  "cancelled",
];

/**
 * Statuses from which work can be re-queued. `interrupted` is included because
 * killing a worker must leave durable, recoverable state rather than silence
 * (architecture §4).
 */
export const RETRYABLE_STATUSES: readonly ExecutionNodeStatus[] = [
  "verification_failed",
  "examination_failed",
  "failed",
  "interrupted",
];

/**
 * Statuses that occupy a concurrency slot. `queued` does not: a queued node is
 * waiting for a slot, not holding one.
 */
export const OCCUPIES_CONCURRENCY_SLOT: readonly ExecutionNodeStatus[] = [
  "running",
  "verifying",
  "examining",
];

type TransitionTable = {
  readonly [S in ExecutionNodeStatus]: Readonly<
    Partial<Record<TransitionEvent, ExecutionNodeStatus>>
  >;
};

/**
 * The complete transition table. A pair absent from it is illegal, full stop.
 *
 * `cancel` is legal from every non-terminal status, because a human may always
 * stop work in flight. It is deliberately not legal from a terminal one.
 */
export const TRANSITIONS: TransitionTable = {
  validated: { enqueue: "queued", cancel: "cancelled" },
  queued: { start: "running", cancel: "cancelled" },
  running: {
    report_implemented: "implemented",
    fail: "failed",
    interrupt: "interrupted",
    cancel: "cancelled",
  },
  implemented: { begin_verification: "verifying", fail: "failed", cancel: "cancelled" },
  verifying: {
    verification_passed: "verified",
    verification_failed: "verification_failed",
    // A step could not run for an unmet human prerequisite (P7, D-P7-10).
    defer: "deferred",
    interrupt: "interrupted",
    cancel: "cancelled",
  },
  // Not a verdict, so it leads nowhere but back: the checks run when the human
  // returns, and only `verification_passed` from `verifying` reaches `verified`
  // (A-05). `cancel` is the table's law for every non-terminal status.
  deferred: { resume_verification: "verifying", cancel: "cancelled" },
  // The only two ways out of `verified` both lead through examination policy.
  verified: { begin_examination: "examining", seal: "sealed", cancel: "cancelled" },
  verification_failed: { retry: "queued", fail: "failed", cancel: "cancelled" },
  examining: {
    examination_passed: "sealed",
    examination_failed: "examination_failed",
    interrupt: "interrupted",
    cancel: "cancelled",
  },
  examination_failed: { retry: "queued", fail: "failed", cancel: "cancelled" },
  sealed: { integrate: "integrated", cancel: "cancelled" },
  integrated: {},
  // No event leads here and none leaves: `finishRun` is the only way in.
  succeeded: {},
  failed: { retry: "queued", cancel: "cancelled" },
  cancelled: {},
  interrupted: { retry: "queued", fail: "failed", cancel: "cancelled" },
};

/** The status `event` leads to from `from`, or `undefined` when illegal. */
export const nextStatus = (
  from: ExecutionNodeStatus,
  event: TransitionEvent,
): ExecutionNodeStatus | undefined => TRANSITIONS[from][event];

export const canTransition = (from: ExecutionNodeStatus, event: TransitionEvent): boolean =>
  nextStatus(from, event) !== undefined;

export const isTerminal = (status: ExecutionNodeStatus): boolean =>
  TERMINAL_STATUSES.includes(status);

/** Every event legal from `from`. */
export const legalEventsFrom = (from: ExecutionNodeStatus): readonly TransitionEvent[] =>
  TRANSITION_EVENTS.filter((event) => canTransition(from, event));

/**
 * Applies `event` to `node`, returning a new node.
 *
 * Pure: the timestamp is a parameter rather than read from a clock, so the same
 * inputs always produce the same output.
 */
export const transition = (
  node: ExecutionNode,
  event: TransitionEvent,
  at: IsoTimestamp,
): ExecutionNode => {
  const next = nextStatus(node.status, event);
  if (next === undefined) throw new IllegalTransitionError(node.status, event);
  return { ...node, status: next, updatedAt: at };
};

/**
 * Whether `node` may end `succeeded` (P5, D-P5-06).
 *
 * A program node does no work of its own: it has no commit, nothing to verify
 * and nothing to integrate, so none of the job lifecycle's endings describe a
 * finished one. `succeeded` is its ending, and it is **not a job's**. A job that
 * worked is `integrated`, reachable only through `verified` (A-05), and a second
 * way to call a job done is exactly what that invariant exists to prevent.
 *
 * So `succeeded` is **not in the table above at all**: no event leads to it, and
 * `transition` can never produce it, for any kind of node. The job lifecycle is
 * what P1 proved it to be, its legality still depends on status and event alone
 * (SC-P1-15), and this one rule, beside it, is the only way in.
 */
export const maySucceed = (node: Pick<ExecutionNode, "kind" | "status">): boolean =>
  node.kind !== "job" && node.status === "running";

/**
 * The program node's ending, from its run's (P5, D-P5-06).
 *
 * `succeeded` is this function's alone. `failed` and `cancelled` are the table's
 * own edges. A run that was `cancelled` or `interrupted` leaves its program node
 * `cancelled`: a run's ending is terminal either way, and `interrupted` on a
 * node means "retry me", which nothing can do to the root of a run that is over.
 *
 * A node that is not `running` is returned as it is. The first durable outcome
 * wins, and a run still `pending` or `running` has no ending to apply.
 */
export const finishRun = (
  programNode: ExecutionNode,
  runStatus: RunStatus,
  at: IsoTimestamp,
  outcomeReason?: string,
): ExecutionNode => {
  if (programNode.kind === "job") {
    throw new IllegalTransitionError(programNode.status, "finish a run on a job node");
  }
  if (programNode.status !== "running") return programNode;
  switch (runStatus) {
    case "succeeded":
      return { ...programNode, status: "succeeded", updatedAt: at };
    case "failed":
      return withReason(transition(programNode, "fail", at), outcomeReason);
    case "cancelled":
    case "interrupted":
      return withReason(transition(programNode, "cancel", at), outcomeReason);
    default:
      return programNode;
  }
};

const withReason = (node: ExecutionNode, outcomeReason: string | undefined): ExecutionNode =>
  outcomeReason === undefined ? node : { ...node, outcomeReason };

/**
 * Statuses that can only be reached by passing through `verified` (A-05).
 * `examination_failed` belongs here: the work was verified, then examination
 * found something that blocks it.
 */
export const POST_VERIFICATION_STATUSES: readonly ExecutionNodeStatus[] = [
  "verified",
  "examining",
  "examination_failed",
  "sealed",
  "integrated",
];

/** Whether reaching `status` necessarily required passing through `verified`. */
export const isPostVerification = (status: ExecutionNodeStatus): boolean =>
  POST_VERIFICATION_STATUSES.includes(status);

/**
 * The only status from which integration is legal. Unverified work never
 * integrates, and `sealed` is only reachable through `verified`.
 */
export const MAY_INTEGRATE: ExecutionNodeStatus = "sealed";
