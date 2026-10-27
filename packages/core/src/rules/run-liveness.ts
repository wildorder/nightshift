/**
 * When a held run no longer holds its program (D-07, PIP-9).
 *
 * A run authorized and then abandoned stays `pending` forever, and the program's
 * live-run marker with it. The next start settles it, atomically with the start.
 * Pending already means no orchestrator attached (attach moves a run to
 * `running`) and the store refuses reviving a terminal run, so the only other
 * thing that can make a pending run live is a dispatch.
 */
import type { IsoTimestamp, Run } from "@nightshift/contracts";

/** How long a run may sit `pending` before a later start may end it as never started. */
export const NEVER_STARTED_GRACE = 15 * 60 * 1000;

/** The outcome reason a settled never-started run carries. */
export const NEVER_STARTED_REASON = "never started";

export interface NeverStartedContext {
  /** Whether the run has a dispatch. */
  readonly hasDispatch: boolean;
  /** The store's trusted clock now. Never a client-supplied `startedAt`. */
  readonly now: IsoTimestamp;
  /** When the store's trusted clock recorded the holder's claim on the program. */
  readonly claimedAt: IsoTimestamp;
  /** Milliseconds; defaults to {@link NEVER_STARTED_GRACE}. */
  readonly grace?: number;
}

/**
 * Whether `holder` never started: still pending, with no dispatch, and claimed
 * longer ago than the grace by the store's own clock. The decision uses nothing
 * a client wrote, so a skewed `startedAt` can neither settle a holder early nor
 * keep one alive.
 */
export const isNeverStartedRun = (
  holder: Pick<Run, "status">,
  { hasDispatch, now, claimedAt, grace = NEVER_STARTED_GRACE }: NeverStartedContext,
): boolean =>
  holder.status === "pending" && !hasDispatch && Date.parse(now) > Date.parse(claimedAt) + grace;
