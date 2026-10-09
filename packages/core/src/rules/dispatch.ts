/**
 * The dispatch's lifecycle, lease and fence (P10, D-P10-18, D-P10-19).
 *
 * Pure rules over a `Dispatch` record. The API applies them before it writes;
 * the reconciler (T6) applies them on a schedule; the fault battery drives them
 * offline. Nothing here reads a clock or a store: the caller supplies `now`.
 *
 * ## Generations
 *
 * A runner's every write carries the generation it was minted under, and
 * `authorize` refuses one that is not the dispatch's current generation. A
 * replacement increments it before launching, so the old runner is fenced by
 * the API rather than asked to stop. `nextGeneration` is the one place the
 * number moves.
 */
import type {
  ComputeCeilings,
  ComputeTier,
  Dispatch,
  DispatchStatus,
  GitHubInstallation,
  PublicationIntent,
  RunnerFailure,
} from "@nightshift/contracts";
import { computeTierRank, MAX_RESOLVED_INTENTS } from "@nightshift/contracts";
import { IllegalTransitionError } from "../errors.js";

export type DispatchTransitionEvent =
  /** The dispatch Lambda took it: a volume and an instance are being created. */
  | "provision"
  /** The runner has the workspace mounted, the checkout at the SHA and setup green. */
  | "ready"
  /** The root orchestrator's agent started. */
  | "start"
  /** Cancellation, a ceiling, or the run ending: the runner is to stop. */
  | "stop"
  /** The machine is gone and the volume is dealt with. */
  | "stopped"
  /** The lease was lost and a replacement is being launched (generation + 1). */
  | "recover"
  /** A human resumes a settled dispatch from its retained snapshot (generation + 1). */
  | "resume"
  /** Provisioning or recovery cannot continue. */
  | "fail";

export const DISPATCH_TRANSITION_EVENTS: readonly DispatchTransitionEvent[] = [
  "provision",
  "ready",
  "start",
  "stop",
  "stopped",
  "recover",
  "resume",
  "fail",
];

export const DISPATCH_STATUSES: readonly DispatchStatus[] = [
  "requested",
  "provisioning",
  "ready",
  "running",
  "stopping",
  "stopped",
  "failed",
];

/**
 * Settled: no machine, nothing live, the volume snapshotted or gone. The one way
 * out is a human's `resume`, within the snapshot's retention (D-P10-05).
 */
export const DISPATCH_TERMINAL_STATUSES: readonly DispatchStatus[] = ["stopped", "failed"];

export const isDispatchTerminal = (status: DispatchStatus): boolean =>
  DISPATCH_TERMINAL_STATUSES.includes(status);

/** How long a settled dispatch's snapshot is kept, and so how long `resume` is possible. */
export const SNAPSHOT_RETENTION_DAYS = 7;

type DispatchTransitionTable = {
  readonly [S in DispatchStatus]: Readonly<
    Partial<Record<DispatchTransitionEvent, DispatchStatus>>
  >;
};

/**
 * The table (D-P10-18). `recover` returns a live dispatch to `provisioning`
 * because that is what a replacement is: a machine being created for a run that
 * is still running. `stop` is legal from every live status so a cancel always
 * has somewhere to go; `fail` likewise, so a failure is never unrecordable.
 * `stopped` is legal from `ready` and `running` as well as `stopping`: a root
 * that finishes its program ends the dispatch itself, and the first live run
 * found that a machine whose runner had said so was left `running` for good.
 */
export const DISPATCH_TRANSITIONS: DispatchTransitionTable = {
  requested: { provision: "provisioning", stop: "stopping", fail: "failed" },
  provisioning: { ready: "ready", recover: "provisioning", stop: "stopping", fail: "failed" },
  ready: {
    start: "running",
    recover: "provisioning",
    stop: "stopping",
    stopped: "stopped",
    fail: "failed",
  },
  running: { recover: "provisioning", stop: "stopping", stopped: "stopped", fail: "failed" },
  stopping: { stopped: "stopped", fail: "failed" },
  stopped: { resume: "provisioning" },
  failed: { resume: "provisioning" },
};

export const nextDispatchStatus = (
  from: DispatchStatus,
  event: DispatchTransitionEvent,
): DispatchStatus | undefined => DISPATCH_TRANSITIONS[from][event];

export const canTransitionDispatch = (
  from: DispatchStatus,
  event: DispatchTransitionEvent,
): boolean => nextDispatchStatus(from, event) !== undefined;

/** Applies one event, or throws `IllegalTransitionError` naming the pair. */
export const transitionDispatch = (
  dispatch: Dispatch,
  event: DispatchTransitionEvent,
  at: string,
): Dispatch => {
  const to = nextDispatchStatus(dispatch.status, event);
  if (to === undefined) {
    throw new IllegalTransitionError(dispatch.status, event);
  }
  return { ...dispatch, status: to, updatedAt: at };
};

/** Where a runner's own failure is heard: a machine the runner holds, not yet told to stop. */
export const RUNNER_FAILABLE_STATUSES: readonly DispatchStatus[] = [
  "provisioning",
  "ready",
  "running",
];

/**
 * The runner's `stopped`, as its heartbeat reports it (D-P10-18, P16 SC-07).
 *
 * With a failure, from `provisioning`, `ready` or `running`, the dispatch is
 * `failed` with it: a workspace that could not be prepared, or an environment
 * fault, ends the dispatch with its cause instead of waiting for the reconciler
 * to give up on the lease. Without one, from `stopping`, `ready` or `running`,
 * the dispatch is `stopped`, as it always was. A `stopping` dispatch was told
 * to stop by the plane, whose reason it keeps; a failure reported then only
 * settles it `stopped`. Anywhere else the report changes nothing.
 */
export const runnerStopped = (
  dispatch: Dispatch,
  failure: RunnerFailure | undefined,
  at: string,
): Dispatch => {
  if (failure !== undefined && RUNNER_FAILABLE_STATUSES.includes(dispatch.status)) {
    return transitionDispatch({ ...dispatch, failure }, "fail", at);
  }
  if (
    dispatch.status === "stopping" ||
    dispatch.status === "running" ||
    dispatch.status === "ready"
  ) {
    return transitionDispatch(dispatch, "stopped", at);
  }
  return dispatch;
};

/** How often the runner heartbeats (D-P10-18). */
export const HEARTBEAT_INTERVAL_SECONDS = 20;
/** How many heartbeats may be missed before the lease is lost. */
export const LEASE_MISSES = 3;
/** The lease a heartbeat buys: the interval times the misses. */
export const LEASE_SECONDS = HEARTBEAT_INTERVAL_SECONDS * LEASE_MISSES;
/** How many machines a run may go through, the first included (D-P10-05). */
export const MAX_DISPATCH_ATTEMPTS = 3;
/** An engine token's life (D-P10-20); renewed on every heartbeat. */
export const ENGINE_TOKEN_SECONDS = 3600;

/** When a lease taken at `nowMs` expires. */
export const leaseExpiryFrom = (nowMs: number): string =>
  new Date(nowMs + LEASE_SECONDS * 1000).toISOString();

/**
 * Whether the runner has gone quiet: the lease has expired on a dispatch that is
 * live and has a machine to lose. A `requested` dispatch has no lease yet; a
 * terminal one has nothing to lose.
 */
export const leaseLost = (dispatch: Dispatch, nowMs: number): boolean => {
  if (dispatch.status === "requested" || isDispatchTerminal(dispatch.status)) return false;
  if (dispatch.status === "stopping") return false;
  if (dispatch.leaseExpiresAt === undefined) return false;
  return Date.parse(dispatch.leaseExpiresAt) <= nowMs;
};

/** The attempts are spent: there has been a machine `MAX_DISPATCH_ATTEMPTS` times already. */
export const attemptsExhausted = (
  dispatch: Dispatch,
  max: number = MAX_DISPATCH_ATTEMPTS,
): boolean => dispatch.attempts.length >= max;

/** The generation a replacement is launched under. Never anything but plus one. */
export const nextGeneration = (dispatch: Dispatch): number => dispatch.generation + 1;

/** Whether a runner's claimed generation is the dispatch's current one. */
export const isCurrentGeneration = (dispatch: Dispatch, claimed: number | undefined): boolean =>
  claimed !== undefined && claimed === dispatch.generation;

/**
 * Begins a replacement (D-P10-18): the generation moves, the attempt is recorded
 * with its reason, and the dispatch is `provisioning` again on the same volume.
 */
export const beginReplacement = (
  dispatch: Dispatch,
  reason: "lease_lost" | "resume",
  at: string,
): Dispatch => {
  const generation = nextGeneration(dispatch);
  const attempts = dispatch.attempts.map((attempt, index) =>
    index === dispatch.attempts.length - 1 && attempt.endedAt === undefined
      ? { ...attempt, endedAt: at }
      : attempt,
  );
  const { instanceId: _instanceId, leaseExpiresAt: _lease, failure: _failure, ...rest } = dispatch;
  return transitionDispatch(
    {
      ...rest,
      generation,
      attempts: [...attempts, { generation, reason, startedAt: at }],
    },
    reason === "resume" ? "resume" : "recover",
    at,
  );
};

/** Whether a settled dispatch can still be resumed: it has a snapshot inside its retention. */
export const mayResume = (
  dispatch: Dispatch,
  nowMs: number,
): { readonly ok: true } | { readonly ok: false; readonly reason: string } => {
  if (!isDispatchTerminal(dispatch.status)) {
    return { ok: false, reason: `the dispatch is ${dispatch.status}, not settled` };
  }
  if (dispatch.cleanup.snapshotId === undefined) {
    return { ok: false, reason: "no snapshot was retained for this run" };
  }
  const takenAt = dispatch.cleanup.snapshotTakenAt ?? dispatch.updatedAt;
  const deadline = Date.parse(takenAt) + SNAPSHOT_RETENTION_DAYS * 24 * 3600 * 1000;
  if (deadline <= nowMs) {
    return {
      ok: false,
      reason: `the snapshot's ${SNAPSHOT_RETENTION_DAYS}-day retention ended on ${new Date(deadline).toISOString()}`,
    };
  }
  return { ok: true };
};

export type DispatchRefusal =
  | { readonly reason: "tier_over_ceiling"; readonly detail: string }
  | { readonly reason: "concurrency_over_ceiling"; readonly detail: string }
  | { readonly reason: "hours_over_ceiling"; readonly detail: string }
  | { readonly reason: "run_over_cap"; readonly detail: string }
  | { readonly reason: "month_over_cap"; readonly detail: string };

export interface MayDispatchInput {
  readonly ceilings: ComputeCeilings;
  readonly tier: ComputeTier;
  /** The run's wall-clock ceiling in hours, as the contract's `maxWallClockSeconds` says, else the org's. */
  readonly runHours: number | undefined;
  /** What this run would cost at its ceiling. */
  readonly estimatedUsd: number;
  /** The org's metered compute spend so far this month, before this run. */
  readonly monthSpentUsd: number;
  /** The org's dispatches that are not terminal, before this one. */
  readonly concurrentRuns: number;
}

/**
 * Whether a dispatch may be accepted under the org's ceilings (D-P10-19). The
 * first refusal found is the answer; a caller wanting them all can ask again.
 */
/**
 * The installation among an org's that grants `repository` (D-P10-02,
 * D-P10-28): the one dispatch verifies against, the heartbeat mints the clone's
 * read token from, and the publisher mints its write token from. An org installs
 * the App once per GitHub account, and no two of its installations can grant the
 * same repository, so the first match is the match.
 */
export const installationGranting = (
  installations: readonly GitHubInstallation[],
  repository: string,
): GitHubInstallation | undefined =>
  installations.find((installation) => installation.repositories.includes(repository));

export const mayDispatch = (input: MayDispatchInput): DispatchRefusal | undefined => {
  const { ceilings } = input;
  if (computeTierRank(input.tier) > computeTierRank(ceilings.maxTier)) {
    return {
      reason: "tier_over_ceiling",
      detail: `the org's ceiling is ${ceilings.maxTier}; ${input.tier} is above it`,
    };
  }
  if (input.concurrentRuns >= ceilings.maxConcurrentRuns) {
    return {
      reason: "concurrency_over_ceiling",
      detail: `${input.concurrentRuns} remote run(s) are already live; the org's ceiling is ${ceilings.maxConcurrentRuns}`,
    };
  }
  const hours = input.runHours ?? ceilings.maxRunHours;
  if (hours > ceilings.maxRunHours) {
    return {
      reason: "hours_over_ceiling",
      detail: `the run's wall clock is ${hours} hours; the org's ceiling is ${ceilings.maxRunHours}`,
    };
  }
  if (input.estimatedUsd > ceilings.maxUsdPerRun) {
    return {
      reason: "run_over_cap",
      detail: `the run could cost $${input.estimatedUsd.toFixed(2)} at its ceiling; the cap per run is $${ceilings.maxUsdPerRun.toFixed(2)}`,
    };
  }
  if (input.monthSpentUsd + input.estimatedUsd > ceilings.maxUsdPerMonth) {
    return {
      reason: "month_over_cap",
      detail: `$${input.monthSpentUsd.toFixed(2)} spent this month plus $${input.estimatedUsd.toFixed(2)} would cross the $${ceilings.maxUsdPerMonth.toFixed(2)} monthly cap`,
    };
  }
  return undefined;
};

/** The effective wall clock of a run in hours: the contract's, capped by the org's. */
export const runHoursOf = (
  maxWallClockSeconds: number | undefined,
  ceilings: Pick<ComputeCeilings, "maxRunHours">,
): number =>
  maxWallClockSeconds === undefined
    ? ceilings.maxRunHours
    : Math.min(maxWallClockSeconds / 3600, ceilings.maxRunHours);

/**
 * Records a publication intent (D-P10-22): one pending intent per branch head,
 * and a second request for a head already pending or published is the same
 * intent. Resolved intents past `MAX_RESOLVED_INTENTS` are dropped, newest kept.
 */
export const recordIntent = (
  dispatch: Dispatch,
  intent: Pick<PublicationIntent, "head" | "expectedPredecessor" | "bundleKey">,
  at: string,
): { readonly dispatch: Dispatch; readonly created: boolean } => {
  const existing = dispatch.publication.intents.find((candidate) => candidate.head === intent.head);
  if (existing !== undefined) return { dispatch, created: false };
  const pending: PublicationIntent = { ...intent, status: "pending", requestedAt: at };
  const resolved = dispatch.publication.intents.filter(
    (candidate) => candidate.status !== "pending",
  );
  const unresolved = dispatch.publication.intents.filter(
    (candidate) => candidate.status === "pending",
  );
  const kept = resolved.slice(Math.max(0, resolved.length - MAX_RESOLVED_INTENTS));
  return {
    created: true,
    dispatch: {
      ...dispatch,
      publication: {
        ...dispatch.publication,
        lastIntentAt: at,
        intents: [...kept, ...unresolved, pending],
      },
      updatedAt: at,
    },
  };
};

/** Whether a dispatch holds an intent the publisher has not resolved. */
export const hasPendingIntent = (dispatch: Dispatch): boolean =>
  dispatch.publication.intents.some((intent) => intent.status === "pending");

/**
 * Resolves a publication intent (D-P10-22): the publisher's word on one head.
 * `published` moves the record's branch head to the intent's; `conflict`,
 * `protected` and `error` block publication with the detail, which the report
 * carries. Resolved intents past `MAX_RESOLVED_INTENTS` are dropped, newest
 * kept, pending ones always kept.
 */
export const resolveIntent = (
  dispatch: Dispatch,
  head: PublicationIntent["head"],
  status: Exclude<PublicationIntent["status"], "pending">,
  detail: string | undefined,
  at: string,
): Dispatch => {
  const intents = dispatch.publication.intents.map((intent) =>
    intent.head === head
      ? { ...intent, status, resolvedAt: at, ...(detail === undefined ? {} : { detail }) }
      : intent,
  );
  const resolved = intents.filter((intent) => intent.status !== "pending");
  const pending = intents.filter((intent) => intent.status === "pending");
  const kept = resolved.slice(Math.max(0, resolved.length - MAX_RESOLVED_INTENTS));
  return {
    ...dispatch,
    publication: {
      ...dispatch.publication,
      ...(status === "published" ? { head } : {}),
      ...(status === "published" ? {} : { blocked: detail ?? `${status} at ${head}` }),
      intents: [...kept, ...pending],
    },
    updatedAt: at,
  };
};

/** The oldest pending intent, which is the one the publisher resolves next. */
export const nextPendingIntent = (dispatch: Dispatch): PublicationIntent | undefined =>
  dispatch.publication.intents.find((intent) => intent.status === "pending");
