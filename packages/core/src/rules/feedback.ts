/**
 * Run feedback rules (D-04). Pure: no clock, no I/O.
 *
 * `buildRunFeedback` is what a client (CLI, Studio) uses to propose a write.
 * `reconcileFeedbackWrite` is the server's rule: it trusts only the proposed
 * verdict and version and builds the canonical record itself, so the actor, the
 * time and the result commit are always the server's own.
 */
import {
  type CommitSha,
  type IsoTimestamp,
  MAX_FEEDBACK_REVISIONS,
  type Run,
  type RunFeedback,
  type RunVerdict,
  type UserPrincipal,
} from "@nightshift/contracts";
import { StaleWriteError } from "../errors.js";
import type { RunScope } from "./ownership.js";
import { isRunTerminal } from "./run-transitions.js";

export interface BuildRunFeedbackInput {
  readonly stored?: RunFeedback;
  readonly scope: RunScope;
  /** Null clears the person's verdict. */
  readonly verdict: RunVerdict | null;
  readonly actor: UserPrincipal;
  readonly at: IsoTimestamp;
  readonly resultCommit?: CommitSha;
}

export const buildRunFeedback = (input: BuildRunFeedbackInput): RunFeedback => {
  const { stored, scope, verdict, actor, at, resultCommit } = input;
  const version = stored === undefined ? 1 : stored.version + 1;
  const revision = {
    version,
    verdict,
    actor,
    recordedAt: at,
    ...(resultCommit === undefined ? {} : { resultCommit }),
  };
  return {
    schemaVersion: stored?.schemaVersion ?? 1,
    projectId: scope.projectId,
    programId: scope.programId,
    runId: scope.runId,
    version,
    verdict,
    actor,
    recordedAt: at,
    ...(resultCommit === undefined ? {} : { resultCommit }),
    revisions: [...(stored?.revisions ?? []), revision].slice(-MAX_FEEDBACK_REVISIONS),
  } as RunFeedback;
};

export type FeedbackWriteOutcome =
  | { readonly outcome: "stored" | "unchanged" | "replayed"; readonly feedback: RunFeedback }
  | { readonly outcome: "nothing_to_clear" };

export interface ReconcileFeedbackInput {
  readonly stored?: RunFeedback;
  readonly proposed: RunFeedback;
  readonly actor: UserPrincipal;
  readonly at: IsoTimestamp;
  readonly resultCommit?: CommitSha;
}

/**
 * Decides a feedback write against the stored record. Every attribution field of
 * `proposed` (actor, recordedAt, resultCommit, revisions) is ignored.
 */
export const reconcileFeedbackWrite = (input: ReconcileFeedbackInput): FeedbackWriteOutcome => {
  const { stored, proposed, actor, at, resultCommit } = input;
  const scope: RunScope = {
    projectId: proposed.projectId,
    programId: proposed.programId,
    runId: proposed.runId,
  };
  const canonical = (verdict: RunVerdict | null, over?: RunFeedback): RunFeedback =>
    buildRunFeedback({
      ...(over === undefined ? {} : { stored: over }),
      scope,
      verdict,
      actor,
      at,
      ...(resultCommit === undefined ? {} : { resultCommit }),
    });
  if (stored === undefined) {
    if (proposed.verdict === null) return { outcome: "nothing_to_clear" };
    if (proposed.version !== 1) {
      throw new StaleWriteError("run feedback", proposed.version - 1, 0);
    }
    return { outcome: "stored", feedback: canonical(proposed.verdict) };
  }
  if (proposed.version === stored.version + 1) {
    if (proposed.verdict === stored.verdict) return { outcome: "unchanged", feedback: stored };
    return { outcome: "stored", feedback: canonical(proposed.verdict, stored) };
  }
  if (
    proposed.version === stored.version &&
    proposed.verdict === stored.verdict &&
    stored.actor.userId === actor.userId
  ) {
    return { outcome: "replayed", feedback: stored };
  }
  throw new StaleWriteError("run feedback", proposed.version - 1, stored.version);
};

/** A run can be rated once it has ended: terminal and with an `endedAt`. */
export const isRunRateable = (run: Run): boolean =>
  isRunTerminal(run.status) && run.endedAt !== undefined;
