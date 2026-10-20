import type { MeasurementCounters, RouteUsage } from "@nightshift/contracts";

/** A route's usage as counters: the four counts 1:1, the convention only if it was stated. */
export const countersFromRouteUsage = (usage: RouteUsage): MeasurementCounters => ({
  ...(usage.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
  ...(usage.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
  ...(usage.cacheReadTokens === undefined ? {} : { cacheReadTokens: usage.cacheReadTokens }),
  ...(usage.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: usage.cacheWriteTokens }),
  ...(usage.inputIncludesCache === undefined
    ? {}
    : { inputIncludesCache: usage.inputIncludesCache }),
});

/**
 * Counters as the EXCLUSIVE-input usage `estimateCost` prices. Inclusive input
 * has its cache tokens taken out and says so; anything else passes through.
 */
export const routeUsageFromCounters = (
  counters: MeasurementCounters,
  extra: { reportedUsd?: number; latencyMs?: number; wallClockMs?: number } = {},
): RouteUsage => {
  const inclusive = counters.inputIncludesCache === true;
  const input =
    inclusive && counters.inputTokens !== undefined
      ? Math.max(
          0,
          counters.inputTokens - (counters.cacheReadTokens ?? 0) - (counters.cacheWriteTokens ?? 0),
        )
      : counters.inputTokens;
  return {
    ...(input === undefined ? {} : { inputTokens: input }),
    ...(counters.outputTokens === undefined ? {} : { outputTokens: counters.outputTokens }),
    ...(counters.cacheReadTokens === undefined
      ? {}
      : { cacheReadTokens: counters.cacheReadTokens }),
    ...(counters.cacheWriteTokens === undefined
      ? {}
      : { cacheWriteTokens: counters.cacheWriteTokens }),
    ...(inclusive
      ? { inputIncludesCache: false }
      : counters.inputIncludesCache === undefined
        ? {}
        : { inputIncludesCache: counters.inputIncludesCache }),
    ...(extra.reportedUsd === undefined ? {} : { actualCostUsd: extra.reportedUsd }),
    ...(extra.latencyMs === undefined ? {} : { latencyMs: extra.latencyMs }),
    ...(extra.wallClockMs === undefined ? {} : { wallClockMs: extra.wallClockMs }),
  };
};
