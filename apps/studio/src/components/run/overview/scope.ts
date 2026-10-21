/**
 * Which scope the Overview shows (D-05): this run, or one completion history
 * that contains it. The choice lives in the URL as `?scope=run` or
 * `?scope=history:<completionHistoryId>`, so a link, a reload, a tab change and
 * the live poll all keep it. An id that is not one of this run's histories falls
 * back to the run, and says so.
 */
import type { CompletionReport, RunReport } from "@nightshift/core";

export type OverviewScope =
  | { readonly kind: "run"; readonly note?: string }
  | { readonly kind: "history"; readonly history: CompletionReport };

const HISTORY_PREFIX = "history:";

export const scopeParam = (scope: OverviewScope): string =>
  scope.kind === "run" ? "run" : `${HISTORY_PREFIX}${scope.history.completionHistoryId}`;

export const resolveScope = (param: string | null, report: RunReport): OverviewScope => {
  if (param === null || param === "run") return { kind: "run" };
  const id = param.startsWith(HISTORY_PREFIX) ? param.slice(HISTORY_PREFIX.length) : "";
  const history = report.completions.find((c) => c.completionHistoryId === id);
  if (history !== undefined) return { kind: "history", history };
  return {
    kind: "run",
    note: `“${param}” is not a completion history of this run, so the Overview shows this run.`,
  };
};

export const ROLE_WORDS = {
  anchor: "anchor",
  contributing: "contributing",
  correction: "correction",
} as const;

/** "3 runs: 1 anchor, 1 contributing, 1 correction". */
export const memberCountsText = (history: CompletionReport): string => {
  const counts = new Map<string, number>();
  for (const member of history.members) counts.set(member.role, (counts.get(member.role) ?? 0) + 1);
  const parts = (Object.keys(ROLE_WORDS) as (keyof typeof ROLE_WORDS)[])
    .filter((role) => (counts.get(role) ?? 0) > 0)
    .map((role) => `${counts.get(role)} ${ROLE_WORDS[role]}`);
  const total = history.members.length;
  return `${total} run${total === 1 ? "" : "s"}${parts.length === 0 ? "" : `: ${parts.join(", ")}`}`;
};
