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
import type { ExecutionNode, ExecutionNodeStatus, IsoTimestamp } from "@nightshift/contracts";
import { IllegalTransitionError } from "../errors.js";

export type TransitionEvent =
  | "enqueue"
  | "start"
  | "report_implemented"
  | "begin_verification"
  | "verification_passed"
  | "verification_failed"
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
  "verified",
  "verification_failed",
  "examining",
  "examination_failed",
  "sealed",
  "integrated",
  "failed",
  "cancelled",
  "interrupted",
];

/** Nothing leaves these. A run that reaches one of them is settled. */
export const TERMINAL_STATUSES: readonly ExecutionNodeStatus[] = ["integrated", "cancelled"];

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
    interrupt: "interrupted",
    cancel: "cancelled",
  },
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
