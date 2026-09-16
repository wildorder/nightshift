/**
 * Run state transitions (T2, D-P3-13).
 *
 * The same shape as the execution-node table in `transitions.ts`: one exported
 * table that is the whole state machine, so a test can enumerate the full
 * cartesian product and assert that everything outside it fails.
 *
 * Two invariants live here rather than in the API, because they are properties of
 * a run rather than of HTTP:
 *
 * - A terminal run carries `endedAt`. A run that ended at no particular time is
 *   not a record anyone can reason about.
 * - A terminal run that did not succeed carries `outcomeReason`. Killing a worker
 *   must leave durable state, never silence (architecture §4); a run that failed
 *   for no recorded reason is exactly that silence.
 */
import type { IsoTimestamp, Run, RunStatus } from "@nightshift/contracts";
import { IllegalTransitionError, OutcomeReasonRequiredError } from "../errors.js";

export type RunTransitionEvent = "start" | "succeed" | "fail" | "cancel" | "interrupt";

export const RUN_TRANSITION_EVENTS: readonly RunTransitionEvent[] = [
  "start",
  "succeed",
  "fail",
  "cancel",
  "interrupt",
];

export const RUN_STATUSES: readonly RunStatus[] = [
  "pending",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
];

/** Nothing leaves these. A run that reaches one of them is settled for good. */
export const RUN_TERMINAL_STATUSES: readonly RunStatus[] = [
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
];

export const isRunTerminal = (status: RunStatus): boolean => RUN_TERMINAL_STATUSES.includes(status);

type RunTransitionTable = {
  readonly [S in RunStatus]: Readonly<Partial<Record<RunTransitionEvent, RunStatus>>>;
};

/**
 * The complete table. A pair absent from it is illegal.
 *
 * A `pending` run can be cancelled or interrupted without ever running: the
 * operator authorized it with `nightshift run` and then closed the laptop, and
 * that has to end somewhere other than `pending` forever.
 */
export const RUN_TRANSITIONS: RunTransitionTable = {
  pending: { start: "running", cancel: "cancelled", interrupt: "interrupted" },
  running: {
    succeed: "succeeded",
    fail: "failed",
    cancel: "cancelled",
    interrupt: "interrupted",
  },
  succeeded: {},
  failed: {},
  cancelled: {},
  interrupted: {},
};

export const nextRunStatus = (from: RunStatus, event: RunTransitionEvent): RunStatus | undefined =>
  RUN_TRANSITIONS[from][event];

export const canTransitionRun = (from: RunStatus, event: RunTransitionEvent): boolean =>
  nextRunStatus(from, event) !== undefined;

/** Every event legal from `from`. */
export const legalRunEventsFrom = (from: RunStatus): readonly RunTransitionEvent[] =>
  RUN_TRANSITION_EVENTS.filter((event) => canTransitionRun(from, event));

/**
 * The event that moves a run from `from` to `to`, or `undefined` when no single
 * event does. Each target is reachable by at most one event from a given status,
 * which is what lets the API derive the event from a submitted record.
 */
export const runEventFor = (from: RunStatus, to: RunStatus): RunTransitionEvent | undefined =>
  legalRunEventsFrom(from).find((event) => nextRunStatus(from, event) === to);

export interface RunOutcome {
  readonly endedAt: IsoTimestamp;
  /** Required for every terminal status but `succeeded`. */
  readonly outcomeReason?: string;
}

/**
 * Applies `event` to `run`, returning a new run.
 *
 * Pure: `outcome` carries the timestamp rather than a clock being read, so the
 * same inputs always produce the same output.
 */
export const transitionRun = (run: Run, event: RunTransitionEvent, outcome: RunOutcome): Run => {
  const next = nextRunStatus(run.status, event);
  if (next === undefined) throw new IllegalTransitionError(run.status, event);

  if (!isRunTerminal(next)) {
    // Only a terminal status ends a run, so nothing else touches the ending fields.
    return { ...run, status: next };
  }
  if (next !== "succeeded" && outcome.outcomeReason === undefined) {
    throw new OutcomeReasonRequiredError("run", next);
  }
  return {
    ...run,
    status: next,
    endedAt: outcome.endedAt,
    ...(outcome.outcomeReason === undefined ? {} : { outcomeReason: outcome.outcomeReason }),
  };
};

/**
 * Fields fixed when a run is created.
 *
 * A run that changed its root would detach every node from its tree; one that
 * changed location would claim to have run somewhere it did not; one that moved
 * its start time would reorder a run's history after the fact.
 */
export const IMMUTABLE_RUN_FIELDS = ["rootNodeId", "location", "startedAt"] as const;

/**
 * Immutability violations in moving `existing` to `next`, ignoring the status.
 *
 * Kept apart from {@link explainRunEnding} because the two are different
 * refusals: this one conflicts with what is already stored, that one is an
 * incomplete record. A caller needs to tell them apart, and so does the API's
 * status mapping.
 */
export const explainRunUpdate = (existing: Run, next: Run): readonly string[] =>
  IMMUTABLE_RUN_FIELDS.filter((field) => existing[field] !== next[field]).map(
    (field) => `${field} cannot change once a run exists`,
  );

/**
 * Every way `run`'s ending fields disagree with its status.
 *
 * A terminal run carries `endedAt`, a non-successful one also carries
 * `outcomeReason`, and a live one carries neither. Applies to a freshly created
 * run as much as to an updated one, which is why it takes one record.
 */
export const explainRunEnding = (run: Run): readonly string[] => {
  const reasons: string[] = [];
  if (isRunTerminal(run.status)) {
    if (run.endedAt === undefined) reasons.push(`a ${run.status} run must carry endedAt`);
    if (run.status !== "succeeded" && run.outcomeReason === undefined) {
      reasons.push(`a ${run.status} run must carry outcomeReason`);
    }
  } else {
    if (run.endedAt !== undefined) {
      reasons.push(`a ${run.status} run has not ended, so it must not carry endedAt`);
    }
    if (run.outcomeReason !== undefined) {
      reasons.push(`a ${run.status} run has not ended, so it must not carry outcomeReason`);
    }
  }
  return reasons;
};
