import type { MeasurementCounters } from "@nightshift/contracts";

/** The five numeric counters; `inputIncludesCache` is a convention, not a count. */
export const COUNTER_KEYS = [
  "inputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "outputTokens",
  "reasoningTokens",
] as const;
export type CounterKey = (typeof COUNTER_KEYS)[number];

/** True when at least one TOKEN counter was reported. Dollars alone are not token evidence. An empty set of counters is "nothing", not zeros. */
export const hasCounters = (counters: MeasurementCounters | undefined): boolean =>
  counters !== undefined && COUNTER_KEYS.some((key) => counters[key] !== undefined);

/** True when any counter, tokens or reported dollars, was reported. */
export const hasAnyCounters = (counters: MeasurementCounters | undefined): boolean =>
  hasCounters(counters) || counters?.reportedUsd !== undefined;

/**
 * The combined convention of the counters that carry anything: true if all say
 * true, false if all say false, else unknown.
 */
export const mergeInputConvention = (
  parts: readonly (MeasurementCounters | undefined)[],
): boolean | undefined => {
  const contributing = parts.filter(hasCounters);
  if (contributing.length === 0) return undefined;
  if (contributing.every((part) => part?.inputIncludesCache === true)) return true;
  if (contributing.every((part) => part?.inputIncludesCache === false)) return false;
  return undefined;
};

/** Counters rebuilt without absent keys, so equal evidence is deep-equal. */
export const cleanCounters = (counters: MeasurementCounters): MeasurementCounters => {
  const out: MeasurementCounters = {};
  for (const key of COUNTER_KEYS) {
    const value = counters[key];
    if (value !== undefined) out[key] = value;
  }
  if (counters.reportedUsd !== undefined) out.reportedUsd = counters.reportedUsd;
  if (counters.inputIncludesCache !== undefined)
    out.inputIncludesCache = counters.inputIncludesCache;
  return out;
};

/** Per-counter sum; absent plus absent stays absent. */
export const addCounters = (
  a: MeasurementCounters,
  b: MeasurementCounters,
): MeasurementCounters => {
  const out: MeasurementCounters = {};
  for (const key of COUNTER_KEYS) {
    if (a[key] !== undefined || b[key] !== undefined) out[key] = (a[key] ?? 0) + (b[key] ?? 0);
  }
  if (a.reportedUsd !== undefined || b.reportedUsd !== undefined)
    out.reportedUsd = (a.reportedUsd ?? 0) + (b.reportedUsd ?? 0);
  const convention = mergeInputConvention([a, b]);
  if (convention !== undefined) out.inputIncludesCache = convention;
  return out;
};

export const sumCounters = (parts: readonly MeasurementCounters[]): MeasurementCounters =>
  parts.reduce<MeasurementCounters>((total, part) => addCounters(total, part), {});

/** What orders two aggregate sources: source time, then receipt time, then identifier. */
export interface SourceKey {
  readonly occurredAt?: string | undefined;
  readonly receivedAt: string;
  readonly observationId: string;
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export const compareSourceKeys = (a: SourceKey, b: SourceKey): number =>
  cmp(a.occurredAt ?? "", b.occurredAt ?? "") ||
  cmp(a.receivedAt, b.receivedAt) ||
  cmp(a.observationId, b.observationId);

export const sourceKeyOf = (key: SourceKey): SourceKey => ({
  ...(key.occurredAt === undefined ? {} : { occurredAt: key.occurredAt }),
  receivedAt: key.receivedAt,
  observationId: key.observationId,
});
