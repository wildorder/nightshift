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
  /** The new run's `startedAt`. */
  readonly at: IsoTimestamp;
  /** Milliseconds; defaults to {@link NEVER_STARTED_GRACE}. */
  readonly grace?: number;
}

export const isNeverStartedRun = (
  holder: Pick<Run, "status" | "startedAt">,
  { hasDispatch, at, grace = NEVER_STARTED_GRACE }: NeverStartedContext,
): boolean =>
  holder.status === "pending" &&
  !hasDispatch &&
  Date.parse(at) > Date.parse(holder.startedAt) + grace;
