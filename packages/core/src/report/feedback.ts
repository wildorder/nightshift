/**
 * Run feedback as the report reads it (D-04). Pure.
 *
 * A verdict is a person saying a run worked or did not. It is neither a
 * verification nor a cause, and an unrated run is absence of a record, never a
 * negative vote.
 */
import type { CommitSha, IsoTimestamp, Run, RunFeedback } from "@nightshift/contracts";
import { isRunRateable } from "../rules/feedback.js";

/**
 * Population: runs that have ended (`isRunRateable`), each counted once by run
 * id. Denominator of `positiveShare`: rated runs only, never eligible runs, so
 * an unrated run neither helps nor hurts it. Missing data: a run without a
 * record, or with a cleared verdict, is unrated.
 */
export interface FeedbackCoverage {
  readonly eligible: number;
  readonly rated: number;
  readonly positive: number;
  readonly negative: number;
  /** positive / rated; absent when nothing is rated. */
  readonly positiveShare?: number;
  readonly unrated: number;
}

export const feedbackCoverageOf = (
  runs: readonly Run[],
  feedback: readonly RunFeedback[],
): FeedbackCoverage => {
  const verdictOf = new Map<string, RunFeedback["verdict"]>();
  for (const record of feedback) verdictOf.set(record.runId, record.verdict);
  const seen = new Set<string>();
  let eligible = 0;
  let positive = 0;
  let negative = 0;
  for (const run of runs) {
    if (seen.has(run.runId)) continue;
    seen.add(run.runId);
    if (!isRunRateable(run)) continue;
    eligible += 1;
    const verdict = verdictOf.get(run.runId);
    if (verdict === "worked") positive += 1;
    else if (verdict === "did_not_work") negative += 1;
  }
  const rated = positive + negative;
  return {
    eligible,
    rated,
    positive,
    negative,
    ...(rated === 0 ? {} : { positiveShare: positive / rated }),
    unrated: eligible - rated,
  };
};

export interface RunFeedbackReport {
  readonly verdict: "worked" | "did_not_work" | "not_rated";
  readonly recordedAt?: IsoTimestamp;
  /** The user id who gave the verdict. */
  readonly by?: string;
  readonly resultCommit?: CommitSha;
  /**
   * Seconds from the run's end to the verdict. A calendar delay between two
   * moments, never work time: nobody is claimed to have spent it reviewing.
   */
  readonly ratingDelaySeconds?: number;
  /** How many times the record was written; history, not extra votes. */
  readonly revisions: number;
}

export const runFeedbackOf = (run: Run, feedback?: RunFeedback): RunFeedbackReport => {
  if (feedback === undefined) return { verdict: "not_rated", revisions: 0 };
  if (feedback.verdict === null) {
    return { verdict: "not_rated", revisions: feedback.revisions.length };
  }
  const delayMs =
    run.endedAt === undefined
      ? undefined
      : Date.parse(feedback.recordedAt) - Date.parse(run.endedAt);
  return {
    verdict: feedback.verdict,
    recordedAt: feedback.recordedAt,
    by: feedback.actor.userId,
    ...(feedback.resultCommit === undefined ? {} : { resultCommit: feedback.resultCommit }),
    ...(delayMs === undefined ? {} : { ratingDelaySeconds: Math.max(0, delayMs / 1000) }),
    revisions: feedback.revisions.length,
  };
};
