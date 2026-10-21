import type {
  MeasurementCounters,
  MeasurementObservation,
  MeasurementSummary,
  ModelPrice,
  ModelPriceTier,
  RequestObservation,
  ValuationCompleteness,
  ValuationComponent,
  ValuationRequests,
} from "@nightshift/contracts";
import { COUNTER_KEYS } from "./counters.js";
import { foldObservation } from "./fold.js";

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
    return {
      source: "reported",
      usd: reportedUsd,
      reportedUsd,
      basis: "reported by the harness",
    };
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

// --- Per-request valuation ----------------------------------------------------------

/** Prices by model: a table, or a lookup. */
export type PriceTable =
  | Readonly<Record<string, ModelPrice>>
  | ((model: string) => ModelPrice | undefined);

export const priceOf = (prices: PriceTable | undefined, model: string): ModelPrice | undefined => {
  if (prices === undefined) return undefined;
  if (typeof prices === "function") return prices(model);
  return Object.hasOwn(prices, model) ? prices[model] : undefined;
};

/** A lookup that also knows the route's single price, as the recorder is handed one. */
export const priceTableFor = (
  table: Readonly<Record<string, ModelPrice>> | undefined,
  route: { readonly model: string },
  routePrice: ModelPrice | undefined,
): PriceTable => {
  return (model) =>
    model === route.model && routePrice !== undefined ? routePrice : priceOf(table, model);
};

type Category = ValuationComponent["category"];
type Rates = Readonly<Record<Category, number>>;

/** The tier a request of this normalized input is priced at, and that tier's per-MTok rates. */
const ratesAt = (price: ModelPrice, normalizedInput: number): { tier: number; rates: Rates } => {
  let chosen: ModelPrice | ModelPriceTier = price;
  let tier = 0;
  (price.tiers ?? []).forEach((candidate, index) => {
    if (normalizedInput > candidate.aboveInputTokens) {
      chosen = candidate;
      tier = index + 1;
    }
  });
  return {
    tier,
    rates: {
      input: chosen.inputPerMTok,
      output: chosen.outputPerMTok,
      cacheRead: chosen.cacheReadPerMTok ?? chosen.inputPerMTok,
      cacheWrite: chosen.cacheWritePerMTok ?? chosen.inputPerMTok,
    },
  };
};

interface NetTokens {
  /** Cache-exclusive input. */
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  /** The request's input including cache tokens: what selects a tier. */
  readonly normalizedInput: number;
}

const netOf = (counters: MeasurementCounters): NetTokens => {
  const reads = counters.cacheReadTokens ?? 0;
  const writes = counters.cacheWriteTokens ?? 0;
  const raw = counters.inputTokens ?? 0;
  const inclusive = counters.inputIncludesCache === true;
  return {
    input: inclusive ? Math.max(0, raw - reads - writes) : raw,
    output: counters.outputTokens ?? 0,
    cacheRead: reads,
    cacheWrite: writes,
    normalizedInput: inclusive ? raw : raw + reads + writes,
  };
};

const CATEGORIES: readonly Category[] = ["input", "output", "cacheRead", "cacheWrite"];
const MAX_COMPONENTS = 64;
const MAX_REASONS = 8;

const mergeComponent = (
  components: ValuationComponent[],
  model: string,
  tier: number,
  category: Category,
  tokens: number,
  perMTok: number,
): boolean => {
  if (tokens === 0) return true;
  const existing = components.find(
    (c) => c.model === model && c.tier === tier && c.category === category,
  );
  if (existing !== undefined) {
    const merged = existing.tokens + tokens;
    components[components.indexOf(existing)] = {
      ...existing,
      tokens: merged,
      usd: (perMTok * merged) / 1_000_000,
    };
    return true;
  }
  if (components.length >= MAX_COMPONENTS) return false;
  components.push({
    model,
    tier,
    category,
    tokens,
    usd: (perMTok * tokens) / 1_000_000,
    perMTok,
  });
  return true;
};

const addReason = (reasons: readonly string[], reason: string): string[] =>
  reasons.includes(reason) || reasons.length >= MAX_REASONS ? [...reasons] : [...reasons, reason];

const emptyRequests = (): ValuationRequests => ({
  counters: { inputIncludesCache: false },
  components: [],
  valuedRequests: 0,
  unvaluedRequests: 0,
  reasons: [],
});

const addNet = (counters: MeasurementCounters, net: NetTokens): MeasurementCounters => ({
  inputTokens: (counters.inputTokens ?? 0) + net.input,
  outputTokens: (counters.outputTokens ?? 0) + net.output,
  cacheReadTokens: (counters.cacheReadTokens ?? 0) + net.cacheRead,
  cacheWriteTokens: (counters.cacheWriteTokens ?? 0) + net.cacheWrite,
  inputIncludesCache: false,
});

const hasBilled = (counters: MeasurementCounters): boolean =>
  COUNTER_KEYS.filter((key) => key !== "reasoningTokens").some(
    (key) => counters[key] !== undefined,
  );

/**
 * Folds one request observation into the summary's per-request valuation: the
 * tier is chosen by this request's own normalized input and each category is
 * valued at that tier. Call it once per newly folded request (the fold's own
 * cursor makes a replay exact); it never touches the totals. A request that
 * cannot be valued is counted as such, with a reason, and never becomes zero.
 */
export const accumulateRequest = (
  summary: MeasurementSummary,
  observation: RequestObservation,
  prices: PriceTable | undefined,
): MeasurementSummary => {
  const acc = summary.valuation.requests ?? emptyRequests();
  const model =
    observation.model ??
    (summary.observedModels.length === 1 ? summary.observedModels[0] : undefined);
  const unvalued = (reason: string, counters: MeasurementCounters): MeasurementSummary => ({
    ...summary,
    valuation: {
      ...summary.valuation,
      requests: {
        ...acc,
        counters: hasBilled(counters) ? addNet(acc.counters, netOf(counters)) : acc.counters,
        unvaluedRequests: acc.unvaluedRequests + 1,
        reasons: addReason(acc.reasons, reason),
      },
    },
  });
  if (!hasBilled(observation.counters)) return unvalued("request without token counters", {});
  if (model === undefined) return unvalued("request without a model", observation.counters);
  const price = priceOf(prices, model);
  if (price === undefined) return unvalued(`no price for ${model}`, observation.counters);

  const net = netOf(observation.counters);
  const { tier, rates } = ratesAt(price, net.normalizedInput);
  const components = [...acc.components];
  for (const category of CATEGORIES) {
    if (!mergeComponent(components, model, tier, category, net[category], rates[category])) {
      return unvalued("component limit reached", observation.counters);
    }
  }
  return {
    ...summary,
    valuation: {
      ...summary.valuation,
      requests: {
        ...acc,
        counters: addNet(acc.counters, net),
        components,
        valuedRequests: acc.valuedRequests + 1,
        ...(acc.priceSource === undefined && price.source !== undefined
          ? { priceSource: price.source }
          : {}),
        ...(acc.priceVersion === undefined && price.version !== undefined
          ? { priceVersion: price.version }
          : {}),
      },
    },
  };
};

const cleanUndefined = <T extends object>(value: T): T =>
  Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;

/**
 * The summary's valuation, derived from its per-request accumulation and its
 * totals. Totals beyond what the observed requests cover are a remainder,
 * valued at the base tier of the route's model. Reported dollars stay
 * `reportedUsd` and are never added to `estimatedUsd`.
 */
export const valuationOf = (
  summary: MeasurementSummary,
  prices: PriceTable | undefined,
): MeasurementSummary["valuation"] => {
  const acc = summary.valuation.requests ?? emptyRequests();
  const totals = summary.totals;
  const reportedUsd = totals.reportedUsd;
  const components = [...acc.components];
  let reasons = [...acc.reasons];
  let priceSource = acc.priceSource;
  let priceVersion = acc.priceVersion;

  const tot = netOf(totals);
  const seen = netOf(acc.counters);
  const remainder = {
    input: Math.max(0, tot.input - seen.input),
    output: Math.max(0, tot.output - seen.output),
    cacheRead: Math.max(0, tot.cacheRead - seen.cacheRead),
    cacheWrite: Math.max(0, tot.cacheWrite - seen.cacheWrite),
  };
  const remainderTokens = CATEGORIES.reduce((sum, category) => sum + remainder[category], 0);
  let remainderValued = true;
  if (remainderTokens > 0) {
    const model = summary.route.model;
    const price = priceOf(prices, model);
    if (price === undefined) {
      remainderValued = false;
      reasons = addReason(reasons, `no price for ${model}`);
    } else {
      const { rates } = ratesAt(price, 0);
      for (const category of CATEGORIES) {
        if (!mergeComponent(components, model, 0, category, remainder[category], rates[category])) {
          remainderValued = false;
          reasons = addReason(reasons, "component limit reached");
        }
      }
      priceSource ??= price.source;
      priceVersion ??= price.version;
    }
  }

  const evidence = acc.valuedRequests + acc.unvaluedRequests > 0 || remainderTokens > 0;
  const estimatedUsd =
    components.length > 0 ? components.reduce((sum, c) => sum + c.usd, 0) : undefined;
  const incomplete = acc.unvaluedRequests > 0 || !remainderValued;
  const completeness: ValuationCompleteness | undefined = evidence
    ? {
        valuedRequests: acc.valuedRequests,
        unvaluedRequests: acc.unvaluedRequests,
        remainderTokens,
        remainderValued,
        reasons,
      }
    : undefined;
  const detail = {
    ...(priceSource === undefined ? {} : { priceSource }),
    ...(priceVersion === undefined ? {} : { priceVersion }),
    ...(components.length === 0 ? {} : { components }),
    ...(completeness === undefined ? {} : { completeness }),
    ...(summary.valuation.requests === undefined ? {} : { requests: summary.valuation.requests }),
  };
  const estimateBasis = incomplete
    ? "estimated from the price table for part of the usage; some usage could not be valued"
    : "estimated per request from the price table, each request at its own price tier";
  if (reportedUsd !== undefined) {
    return cleanUndefined({
      source: "reported" as const,
      usd: reportedUsd,
      reportedUsd,
      estimatedUsd,
      basis: "reported by the harness",
      ...detail,
    });
  }
  if (estimatedUsd !== undefined) {
    return cleanUndefined({
      source: "estimated" as const,
      usd: estimatedUsd,
      estimatedUsd,
      basis: estimateBasis,
      ...detail,
    });
  }
  const noPrice = reasons.find((reason) => reason.startsWith("no price"));
  return cleanUndefined({
    source: "unknown" as const,
    basis: noPrice
      ? "no price for the model"
      : evidence
        ? "no usage could be valued"
        : "no token counters were reported",
    ...detail,
  });
};

/** `foldObservation`, then the request's per-request valuation when the fold took it. */
export const foldObservationPriced = (
  summary: MeasurementSummary,
  observation: MeasurementObservation,
  sequence: number,
  at: string,
  prices: PriceTable | undefined,
): MeasurementSummary => {
  const folded = foldObservation(summary, observation, sequence, at);
  return folded !== summary && observation.kind === "request"
    ? accumulateRequest(folded, observation, prices)
    : folded;
};
