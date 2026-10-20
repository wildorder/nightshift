import type { MeasurementCounters, MeasurementSummary, ModelPrice } from "@nightshift/contracts";
import { COUNTER_KEYS } from "./counters.js";

const perToken = (perMillion: number | undefined, tokens: number | undefined): number =>
  ((perMillion ?? 0) * (tokens ?? 0)) / 1_000_000;

/**
 * Dollars for counters. Reported dollars (`counters.reportedUsd`) win. Otherwise a price and at least one
 * of the four billed counters give an estimate, with inclusive input priced net
 * of the cache tokens so cached input is charged once; exclusive or unstated
 * input is priced as `estimateCost` prices it. Anything else is unknown.
 */
export const valueCounters = (
  counters: MeasurementCounters,
  price: ModelPrice | undefined,
): MeasurementSummary["valuation"] => {
  const reportedUsd = counters.reportedUsd;
  if (reportedUsd !== undefined) {
    return { source: "reported", usd: reportedUsd, reportedUsd, basis: "reported by the harness" };
  }
  const billed = COUNTER_KEYS.filter((key) => key !== "reasoningTokens").some(
    (key) => counters[key] !== undefined,
  );
  if (price === undefined) return { source: "unknown", basis: "no price for the model" };
  if (!billed) return { source: "unknown", basis: "no token counters were reported" };

  const reads = counters.cacheReadTokens ?? 0;
  const writes = counters.cacheWriteTokens ?? 0;
  const inclusive = counters.inputIncludesCache === true;
  const input = inclusive
    ? Math.max(0, (counters.inputTokens ?? 0) - reads - writes)
    : (counters.inputTokens ?? 0);
  const usd =
    perToken(price.inputPerMTok, input) +
    perToken(price.outputPerMTok, counters.outputTokens) +
    perToken(price.cacheReadPerMTok ?? price.inputPerMTok, reads) +
    perToken(price.cacheWritePerMTok ?? price.inputPerMTok, writes);
  return {
    source: "estimated",
    usd,
    basis: inclusive
      ? "estimated from the price table; input includes cache tokens, which are priced separately"
      : counters.inputIncludesCache === false
        ? "estimated from the price table; input excludes cache tokens"
        : "estimated from the price table; input convention unstated, input and cache priced as separate counts",
  };
};
