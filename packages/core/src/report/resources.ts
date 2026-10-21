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

export interface AttemptResources {
  readonly tokens: ResourceTokens;
  readonly usd: ResourceDollars;
  readonly coverage: ResourceCoverage;
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
}

const present = <K extends string>(key: K, value: number | undefined) =>
  value === undefined ? {} : ({ [key]: value } as { [P in K]: number });

const tokensOf = (counters: MeasurementCounters): ResourceTokens => {
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
  for (const item of items) {
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
  };
};
