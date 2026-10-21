/**
 * What an attempt consumed, as the report reads it (P20). Pure: a routing
 * decision and the measurement summaries recorded for the run.
 *
 * Tokens are normalized to one input convention where it is known and say so
 * where it is not. Dollars keep estimated and reported apart; they are never
 * summed into one number.
 */
import type {
  CostSource,
  MeasurementCounters,
  MeasurementCoverage,
  MeasurementSummary,
  MeasurementValuation,
  RoutingDecision,
} from "@nightshift/contracts";
import { hasAnyCounters } from "../measurement/counters.js";
import { countersFromRouteUsage } from "../measurement/normalize.js";

export type ResourceCoverage = MeasurementCoverage | "missing";

export interface ResourceTokens {
  /** Inclusive of cache reads and writes when `inputConvention` is `inclusive`. */
  readonly input?: number;
  readonly output?: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
  readonly reasoning?: number;
  /** `unknown`: the provider's convention was not stated, so `input` is the raw figure. */
  readonly inputConvention: "inclusive" | "unknown";
}

export interface ResourceDollars {
  readonly estimated?: number;
  readonly reported?: number;
  readonly source: CostSource | "none";
}

/** The price list an estimate was valued from, per model. */
export interface PriceBasis {
  readonly source?: string;
  readonly version?: string;
  readonly model: string;
  /** Some usage of the attempt could not be valued, so the estimate understates. */
  readonly incomplete: boolean;
}

export interface AttemptResources {
  readonly tokens: ResourceTokens;
  readonly usd: ResourceDollars;
  readonly coverage: ResourceCoverage;
  readonly priceBases?: readonly PriceBasis[];
  /** The estimate leaves some usage unvalued. */
  readonly estimateIncomplete?: boolean;
}

export interface ResourceTotals {
  readonly tokens: {
    readonly input?: number;
    readonly output?: number;
    readonly cacheRead?: number;
    readonly cacheWrite?: number;
    readonly reasoning?: number;
    /** Items whose input convention was not known; their raw input is included as reported. */
    readonly inputConventionUnknown: number;
  };
  readonly usd: { readonly estimated: number; readonly reported: number };
  /** Items with neither an estimated nor a reported dollar figure. */
  readonly unpriced: number;
  readonly coverage: Record<ResourceCoverage, number>;
  readonly tokenCoverage: "complete" | "partial";
  /** Distinct price lists the estimates came from. */
  readonly priceBases?: readonly PriceBasis[];
  /** Attempts whose estimate leaves some usage unvalued. */
  readonly estimateIncomplete?: number;
  /** Attempts that carried a provider-reported dollar figure (an observed $0 counts). */
  readonly reportedAttempts?: number;
  /** Attempts that carried an API-equivalent estimate (an observed $0 counts). */
  readonly estimatedAttempts?: number;
}

const present = <K extends string>(key: K, value: number | undefined) =>
  value === undefined ? {} : ({ [key]: value } as { [P in K]: number });

export const tokensOf = (counters: MeasurementCounters): ResourceTokens => {
  const convention = counters.inputIncludesCache;
  const input =
    counters.inputTokens === undefined
      ? undefined
      : convention === false
        ? counters.inputTokens + (counters.cacheReadTokens ?? 0) + (counters.cacheWriteTokens ?? 0)
        : counters.inputTokens;
  return {
    ...present("input", input),
    ...present("output", counters.outputTokens),
    ...present("cacheRead", counters.cacheReadTokens),
    ...present("cacheWrite", counters.cacheWriteTokens),
    ...present("reasoning", counters.reasoningTokens),
    inputConvention: convention === undefined ? "unknown" : "inclusive",
  };
};

const valuationIncomplete = (valuation: MeasurementValuation): boolean =>
  valuation.completeness !== undefined &&
  (valuation.completeness.unvaluedRequests > 0 || !valuation.completeness.remainderValued);

const priceBasesOf = (valuation: MeasurementValuation, incomplete: boolean): PriceBasis[] =>
  [...new Set((valuation.components ?? []).map((component) => component.model))].map((model) => ({
    ...(valuation.priceSource === undefined ? {} : { source: valuation.priceSource }),
    ...(valuation.priceVersion === undefined ? {} : { version: valuation.priceVersion }),
    model,
    incomplete,
  }));

/** The resources one routing decision's attempt used, preferring its measurement summary. */
export const resourcesOf = (
  route: RoutingDecision,
  summaries: readonly MeasurementSummary[],
): AttemptResources => {
  const matching = summaries
    .filter((summary) => summary.routingDecisionId === route.routingDecisionId)
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  const summary = matching[0];
  const fromRoute = countersFromRouteUsage(route.usage);
  const counters = summary?.totals ?? fromRoute;
  const coverage: ResourceCoverage =
    summary !== undefined ? summary.coverage : hasAnyCounters(fromRoute) ? "legacy" : "missing";
  const valuation = summary?.valuation;
  if (
    summary !== undefined &&
    valuation !== undefined &&
    (valuation.estimatedUsd !== undefined || valuation.reportedUsd !== undefined)
  ) {
    const incomplete = valuationIncomplete(valuation);
    return {
      tokens: tokensOf(counters),
      usd: {
        ...present("estimated", valuation.estimatedUsd),
        ...present("reported", valuation.reportedUsd),
        source: valuation.source === "unknown" ? "none" : valuation.source,
      },
      coverage,
      priceBases: priceBasesOf(valuation, incomplete),
      estimateIncomplete: valuation.estimatedUsd !== undefined && incomplete,
    };
  }
  const { estimatedCostUsd, actualCostUsd, costSource } = route.usage;
  return {
    tokens: tokensOf(counters),
    usd: {
      ...present("estimated", estimatedCostUsd),
      ...present("reported", actualCostUsd),
      source: costSource ?? "none",
    },
    coverage,
  };
};

/** The resources of a summary with no routing decision (the root launch): its totals and valuation alone. */
export const resourcesOfSummary = (summary: MeasurementSummary): AttemptResources => ({
  tokens: tokensOf(summary.totals),
  usd: {
    ...present("estimated", summary.valuation.usd),
    ...present("reported", summary.valuation.reportedUsd),
    source: summary.valuation.source,
  },
  coverage: summary.coverage,
  priceBases: priceBasesOf(summary.valuation, valuationIncomplete(summary.valuation)),
});

const add = (total: number | undefined, value: number | undefined): number | undefined =>
  value === undefined ? total : (total ?? 0) + value;

/** Sums attempts' resources; an absent counter adds nothing, and dollars stay estimated vs reported. */
export const sumResources = (items: readonly AttemptResources[]): ResourceTotals => {
  const coverage: Record<ResourceCoverage, number> = {
    complete: 0,
    partial: 0,
    unknown: 0,
    legacy: 0,
    missing: 0,
  };
  let input: number | undefined;
  let output: number | undefined;
  let cacheRead: number | undefined;
  let cacheWrite: number | undefined;
  let reasoning: number | undefined;
  let inputConventionUnknown = 0;
  let estimated = 0;
  let reported = 0;
  let unpriced = 0;
  let estimateIncomplete = 0;
  let reportedAttempts = 0;
  let estimatedAttempts = 0;
  const priceBases: PriceBasis[] = [];
  for (const item of items) {
    if (item.usd.reported !== undefined) reportedAttempts += 1;
    if (item.usd.estimated !== undefined) estimatedAttempts += 1;
    if (item.estimateIncomplete === true) estimateIncomplete += 1;
    for (const basis of item.priceBases ?? []) {
      const same = priceBases.findIndex(
        (seen) =>
          seen.model === basis.model &&
          seen.source === basis.source &&
          seen.version === basis.version,
      );
      const seen = priceBases[same];
      if (seen === undefined) priceBases.push(basis);
      else if (basis.incomplete && !seen.incomplete) priceBases[same] = basis;
    }
    coverage[item.coverage] += 1;
    input = add(input, item.tokens.input);
    output = add(output, item.tokens.output);
    cacheRead = add(cacheRead, item.tokens.cacheRead);
    cacheWrite = add(cacheWrite, item.tokens.cacheWrite);
    reasoning = add(reasoning, item.tokens.reasoning);
    if (item.tokens.input !== undefined && item.tokens.inputConvention === "unknown") {
      inputConventionUnknown += 1;
    }
    estimated += item.usd.estimated ?? 0;
    reported += item.usd.reported ?? 0;
    if (item.usd.estimated === undefined && item.usd.reported === undefined) unpriced += 1;
  }
  return {
    tokens: {
      ...present("input", input),
      ...present("output", output),
      ...present("cacheRead", cacheRead),
      ...present("cacheWrite", cacheWrite),
      ...present("reasoning", reasoning),
      inputConventionUnknown,
    },
    usd: { estimated, reported },
    unpriced,
    coverage,
    tokenCoverage: items.every((item) => item.coverage === "complete") ? "complete" : "partial",
    priceBases,
    estimateIncomplete,
    reportedAttempts,
    estimatedAttempts,
  };
};
