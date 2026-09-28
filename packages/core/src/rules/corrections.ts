/**
 * Decisions after the fact, and corrections of them (P9, D-P9-01, D-P9-04,
 * D-P9-05).
 *
 * A recorded decision never changes, with two exceptions, each made once: the
 * checkpoint after the work it governs landed, and the commits that work
 * produced. A correction is a program that names the decisions it corrects;
 * each must exist and be superseded by a human decision. Reversing a decision
 * whose effects reach outside the repository needs the owner's confirmation
 * before the correction runs.
 */
import type { CorrectionTarget, Decision, Reversibility } from "@nightshift/contracts";

/**
 * Why `next` is not a stamp of `existing`: the only change a recorded decision
 * accepts is `checkpointAfter` and `produced` set where they were absent. Empty
 * when it is one. Identical records are not stamps; they are a confirmation.
 */
export const explainDecisionStamp = (existing: Decision, next: Decision): readonly string[] => {
  const problems: string[] = [];
  if (existing.checkpointAfter !== undefined && next.checkpointAfter !== existing.checkpointAfter) {
    problems.push("checkpointAfter is set once, and it is already set");
  }
  if (
    existing.produced !== undefined &&
    JSON.stringify(next.produced) !== JSON.stringify(existing.produced)
  ) {
    problems.push("produced is set once, and it is already set");
  }
  const { checkpointAfter: _a, produced: _b, ...before } = existing;
  const { checkpointAfter: _c, produced: _d, ...after } = next;
  if (JSON.stringify(sorted(before)) !== JSON.stringify(sorted(after))) {
    problems.push("a recorded decision changes only by gaining checkpointAfter and produced");
  }
  return problems;
};

/** Whether `next` adds a stamp to `existing` and changes nothing else. */
export const isDecisionStamp = (existing: Decision, next: Decision): boolean =>
  explainDecisionStamp(existing, next).length === 0 &&
  ((existing.checkpointAfter === undefined && next.checkpointAfter !== undefined) ||
    (existing.produced === undefined && next.produced !== undefined));

const sorted = (record: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));

/** What the control plane found for one `corrects` entry. */
export interface CorrectionFound {
  readonly target: CorrectionTarget;
  /** The decision corrected, when the named run holds it. */
  readonly decision?: Decision | undefined;
  /** The decision named as reversing it, when the named run holds it. */
  readonly reversal?: Decision | undefined;
}

/**
 * Why a correction may not name `found` (D-P9-04). Empty when it may: the
 * decision exists, and a human decision in the same run supersedes it.
 */
export const explainCorrection = (found: CorrectionFound): readonly string[] => {
  const { target, decision, reversal } = found;
  if (decision === undefined) {
    return [`${target.decisionId} is not a decision of run ${target.runId}`];
  }
  if (reversal === undefined) {
    return [`${target.reversedBy} is not a decision of run ${target.runId}`];
  }
  const problems: string[] = [];
  if (reversal.authority !== "human") {
    problems.push(`${target.reversedBy} is not a human decision: only the owner reverses`);
  }
  if (reversal.supersedesDecisionId !== decision.decisionId) {
    problems.push(`${target.reversedBy} does not supersede ${target.decisionId}`);
  }
  return problems;
};

/** The classes whose reversal the owner confirms before a correction runs (D-P9-05). */
export const CONFIRMED_CLASSES: readonly Reversibility[] = ["irreversible", "compensatable"];

/** Opens the context of the owner's confirmation, so it is found again by what it confirms. */
export const IRREVERSIBLE_CONFIRMATION_PREFIX = "Confirmed the correction of decision";

/** The context of the owner's confirmation that a correction of `decisionId` may run. */
export const irreversibleConfirmationContext = (decisionId: string): string =>
  `${IRREVERSIBLE_CONFIRMATION_PREFIX} ${decisionId}, whose effects reach outside the repository.`;

/**
 * The corrected decisions still waiting on the owner's confirmation: those of a
 * confirmed class with no human decision in `recorded` confirming them.
 */
export const unconfirmedCorrections = (
  corrected: readonly Decision[],
  recorded: readonly Decision[],
): readonly Decision[] =>
  corrected.filter(
    (decision) =>
      CONFIRMED_CLASSES.includes(decision.reversibility) &&
      !recorded.some(
        (confirmation) =>
          confirmation.authority === "human" &&
          confirmation.context === irreversibleConfirmationContext(decision.decisionId),
      ),
  );
