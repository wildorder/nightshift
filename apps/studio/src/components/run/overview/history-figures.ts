/**
 * Text for the history-wide delivery, rework, review and bottleneck blocks of a
 * CompletionReport (D-04, D-05). A block whose coverage is 0 of m members is
 * absent from the report and reads "not observed", never 0.
 */
import type {
  CompletionMemberOperations,
  CompletionMemberReport,
  CompletionReport,
  EvidenceCoverage,
} from "@nightshift/core";
import { NOT_OBSERVED, spanText } from "../../../lib/overview.js";

export const memberKey = (member: { programId: string; runId: string }): string =>
  `${member.programId}/${member.runId}`;

/** "across 2 of 3 member runs" */
export const acrossText = (history: CompletionReport, coverage: EvidenceCoverage | undefined) =>
  `across ${coverage?.withEvidence ?? 0} of ${history.members.length} member runs`;

export const IDENTITY_RULE =
  "A work item is counted once across the member runs: a strand carried into a later run is not counted again, and its attempts stay with the run that made them.";

/** Members with no evidence, named with the reason a read failed when there is one. */
export const missingMembers = (
  history: CompletionReport,
  coverage: EvidenceCoverage | undefined,
): { readonly key: string; readonly why: string }[] => {
  const withoutRuns = history.members
    .filter((m) => m.unreadable === true)
    .map((m) => ({ key: memberKey(m), why: "the run is not in the records read" }));
  const named = new Set(withoutRuns.map((m) => m.key));
  const unavailable = (coverage?.unavailable ?? [])
    .filter((key) => !named.has(key))
    .map((key) => ({ key, why: coverage?.reasons?.[key] ?? "no evidence could be read" }));
  return [...withoutRuns, ...unavailable];
};

export const memberOperations = (
  history: CompletionReport,
  member: CompletionMemberReport,
): CompletionMemberOperations | undefined =>
  history.current.operations?.members.find((m) => memberKey(m) === memberKey(member));

/**
 * A member with lifecycle observations has some summed work or a union above zero; one with
 * all of them at zero left no observations, so its unions are "not observed", not 0.
 */
export const hasObservedTime = (ops: CompletionMemberOperations | undefined): boolean =>
  ops !== undefined &&
  (ops.summedWorkMs > 0 ||
    ops.unions.wait > 0 ||
    ops.unions.queue > 0 ||
    ops.unions.integration > 0 ||
    ops.unions.examination > 0);

/** The unions of a member as table cells' text. */
export const unionText = (
  ops: CompletionMemberOperations | undefined,
  kind: "wait" | "queue" | "integration" | "examination",
): string => (hasObservedTime(ops) ? spanText(ops?.unions[kind]) : NOT_OBSERVED);

const dayText = (ms: number | undefined): string =>
  ms === undefined ? NOT_OBSERVED : spanText(ms);

/** One member's time figures as a sentence, the text equivalent of its table row. */
export const memberTimeText = (
  history: CompletionReport,
  member: CompletionMemberReport,
): string => {
  const ops = memberOperations(history, member);
  if (ops === undefined) return `elapsed ${NOT_OBSERVED}; no timing evidence`;
  if (!hasObservedTime(ops)) {
    return `elapsed ${dayText(ops.elapsedMs)}; waiting, queue, integration and examination ${NOT_OBSERVED} (no lifecycle observations)`;
  }
  return `elapsed ${ops.elapsedMs === undefined && ops.endedAt === undefined ? "so far, the run is still running" : dayText(ops.elapsedMs)}; waiting ${dayText(ops.unions.wait)}, queue ${dayText(ops.unions.queue)}, integration ${dayText(ops.unions.integration)}, examination ${dayText(ops.unions.examination)}`;
};
