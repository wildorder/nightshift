import type { CoverageGap } from "@nightshift/contracts";

/** The most gaps a summary lists. */
export const MAX_GAPS = 64;

const minTime = (a?: string, b?: string): string | undefined =>
  a === undefined ? b : b === undefined ? a : a < b ? a : b;
const maxTime = (a?: string, b?: string): string | undefined =>
  a === undefined ? b : b === undefined ? a : a > b ? a : b;

/**
 * Merges gaps with the same reason and detail by adding counts. Beyond `limit`
 * entries the extras merge into one `other` gap saying how many were coalesced:
 * a gap is never silently dropped.
 */
export const coalesceGaps = (
  gaps: readonly CoverageGap[],
  limit: number = MAX_GAPS,
): CoverageGap[] => {
  const merged = new Map<string, CoverageGap>();
  for (const gap of gaps) {
    const key = JSON.stringify([gap.reason, gap.detail ?? null]);
    const existing = merged.get(key);
    if (existing === undefined) {
      merged.set(key, { ...gap });
      continue;
    }
    const from = minTime(existing.from, gap.from);
    const to = maxTime(existing.to, gap.to);
    merged.set(key, {
      ...existing,
      count: existing.count + gap.count,
      ...(from === undefined ? {} : { from }),
      ...(to === undefined ? {} : { to }),
    });
  }
  const list = [...merged.values()];
  if (list.length <= limit) return list;
  const kept = list.slice(0, Math.max(0, limit - 1));
  const rest = list.slice(kept.length);
  const from = rest.reduce<string | undefined>((acc, gap) => minTime(acc, gap.from), undefined);
  const to = rest.reduce<string | undefined>((acc, gap) => maxTime(acc, gap.to), undefined);
  return [
    ...kept,
    {
      reason: "other",
      detail:
        `${rest.length} further gaps coalesced (reasons: ${[...new Set(rest.map((g) => g.reason))].join(", ")})`.slice(
          0,
          400,
        ),
      ...(from === undefined ? {} : { from }),
      ...(to === undefined ? {} : { to }),
      count: rest.reduce((sum, gap) => sum + gap.count, 0),
    },
  ];
};

/** `gaps` less `remove`, matched on reason and detail, counts subtracted. */
export const subtractGaps = (
  gaps: readonly CoverageGap[],
  remove: readonly CoverageGap[],
): CoverageGap[] => {
  const owed = new Map<string, number>();
  for (const gap of remove) {
    const key = JSON.stringify([gap.reason, gap.detail ?? null]);
    owed.set(key, (owed.get(key) ?? 0) + gap.count);
  }
  const out: CoverageGap[] = [];
  for (const gap of gaps) {
    const key = JSON.stringify([gap.reason, gap.detail ?? null]);
    const due = Math.min(owed.get(key) ?? 0, gap.count);
    owed.set(key, (owed.get(key) ?? 0) - due);
    if (gap.count - due > 0) out.push({ ...gap, count: gap.count - due });
  }
  return out;
};
