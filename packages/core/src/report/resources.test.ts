import type { MeasurementSummary, RoutingDecision } from "@nightshift/contracts";
import { describe, expect, it } from "vitest";
import { createFixtures, FIXTURE_TIMESTAMP } from "../testing/factories.js";
import { type AttemptResources, resourcesOf, sumResources } from "./resources.js";

const fixtures = createFixtures();
const route = (usage: RoutingDecision["usage"] = {}): RoutingDecision => ({
  schemaVersion: 1,
  ...fixtures.scope,
  routingDecisionId: fixtures.ids.next("route"),
  executionNodeId: fixtures.rootNodeId,
  attempt: 1,
  eligibleOptions: [
    { target: { harness: "claude", provider: "anthropic", model: "m" }, eligible: true },
  ],
  chosen: { harness: "claude", provider: "anthropic", model: "m" },
  ruleId: "r",
  wasOverride: false,
  usage,
  outcome: "verified",
  previousRouteId: null,
  createdAt: FIXTURE_TIMESTAMP,
});

const summaryFor = (
  decision: RoutingDecision,
  over: Partial<MeasurementSummary>,
): MeasurementSummary =>
  ({
    measurementVersion: 1,
    ...fixtures.scope,
    measurementSummaryId: fixtures.ids.next("meas"),
    executionNodeId: decision.executionNodeId,
    agentId: fixtures.ids.next("agent"),
    role: "worker",
    routingDecisionId: decision.routingDecisionId,
    route: decision.chosen,
    observedModels: [],
    segments: [],
    totals: {},
    coverage: "complete",
    gaps: [],
    ledger: { chunks: 0, artifactIds: [], observationCount: 0, publishedCount: 0 },
    valuation: { source: "unknown" },
    createdAt: FIXTURE_TIMESTAMP,
    updatedAt: FIXTURE_TIMESTAMP,
    ...over,
  }) as MeasurementSummary;

describe("resourcesOf", () => {
  it("prefers the matching summary, newest first, over route usage", () => {
    const decision = route({ inputTokens: 1, outputTokens: 1 });
    const older = summaryFor(decision, {
      totals: { inputTokens: 5, inputIncludesCache: true },
      updatedAt: "2026-01-01T00:00:00Z",
    });
    const newer = summaryFor(decision, {
      totals: { inputTokens: 50, outputTokens: 7, reasoningTokens: 2, inputIncludesCache: true },
      updatedAt: "2026-02-01T00:00:00Z",
      coverage: "partial",
    });
    const other = summaryFor(route(), { totals: { inputTokens: 999, inputIncludesCache: true } });
    const result = resourcesOf(decision, [older, other, newer]);
    expect(result.tokens).toEqual({
      input: 50,
      output: 7,
      reasoning: 2,
      inputConvention: "inclusive",
    });
    expect(result.coverage).toBe("partial");
  });

  it("normalizes exclusive input to inclusive", () => {
    const decision = route();
    const result = resourcesOf(decision, [
      summaryFor(decision, {
        totals: {
          inputTokens: 10,
          cacheReadTokens: 100,
          cacheWriteTokens: 5,
          inputIncludesCache: false,
        },
      }),
    ]);
    expect(result.tokens.input).toBe(115);
    expect(result.tokens.cacheRead).toBe(100);
    expect(result.tokens.inputConvention).toBe("inclusive");
  });

  it("reports an unknown convention and passes input raw", () => {
    const decision = route();
    const result = resourcesOf(decision, [
      summaryFor(decision, { totals: { inputTokens: 10, cacheReadTokens: 100 } }),
    ]);
    expect(result.tokens.input).toBe(10);
    expect(result.tokens.inputConvention).toBe("unknown");
  });

  it("falls back to legacy route usage, and to missing", () => {
    const legacy = resourcesOf(route({ inputTokens: 3, outputTokens: 4 }), []);
    expect(legacy.coverage).toBe("legacy");
    expect(legacy.tokens.input).toBe(3);
    expect(legacy.tokens.output).toBe(4);
    const missing = resourcesOf(route(), []);
    expect(missing.coverage).toBe("missing");
    expect(missing.tokens.input).toBeUndefined();
    expect(missing.usd.source).toBe("none");
  });

  it("prefers the summary's valuation and carries its price provenance", () => {
    const decision = route({ estimatedCostUsd: 99, actualCostUsd: 98, costSource: "reported" });
    const valued = summaryFor(decision, {
      totals: { inputTokens: 10, inputIncludesCache: false },
      valuation: {
        source: "reported",
        usd: 5,
        reportedUsd: 5,
        estimatedUsd: 2.5,
        priceSource: "anthropic-list",
        priceVersion: "2026-10-01",
        components: [{ model: "m", tier: 0, category: "input", tokens: 10, usd: 2.5, perMTok: 3 }],
        completeness: {
          valuedRequests: 1,
          unvaluedRequests: 1,
          remainderTokens: 0,
          remainderValued: true,
          reasons: ["no price for x"],
        },
      },
    });
    const result = resourcesOf(decision, [valued]);
    expect(result.usd).toEqual({ estimated: 2.5, reported: 5, source: "reported" });
    expect(result.priceBases).toEqual([
      { source: "anthropic-list", version: "2026-10-01", model: "m", incomplete: true },
    ]);
    expect(result.estimateIncomplete).toBe(true);

    const total = sumResources([
      result,
      resourcesOf(decision, [valued]),
      resourcesOf(route({ actualCostUsd: 1 }), []),
    ]);
    expect(total.usd).toEqual({ estimated: 5, reported: 11 });
    expect(total.priceBases).toHaveLength(1);
    expect(total.estimateIncomplete).toBe(2);
  });

  it("keeps route-usage dollars for a route without a summary or with an unvalued one", () => {
    const decision = route({ actualCostUsd: 3, costSource: "reported" });
    const none = resourcesOf(decision, []);
    expect(none.usd).toEqual({ reported: 3, source: "reported" });
    expect(none.coverage).toBe("legacy");
    const legacy = resourcesOf(route({ inputTokens: 1, actualCostUsd: 3 }), []);
    expect(legacy.coverage).toBe("legacy");
    expect(legacy.usd.reported).toBe(3);
    expect(legacy.priceBases).toBeUndefined();
    const unknown = resourcesOf(decision, [summaryFor(decision, { totals: { outputTokens: 1 } })]);
    expect(unknown.usd.reported).toBe(3);
  });

  it("keeps estimated and reported dollars apart", () => {
    const result = resourcesOf(
      route({ estimatedCostUsd: 0.5, actualCostUsd: 0.75, costSource: "reported" }),
      [],
    );
    expect(result.usd).toEqual({ estimated: 0.5, reported: 0.75, source: "reported" });
  });
});

describe("sumResources", () => {
  const item = (over: Partial<AttemptResources>): AttemptResources => ({
    tokens: { inputConvention: "inclusive" },
    usd: { source: "none" },
    coverage: "complete",
    ...over,
  });

  it("sums tokens, tallies coverage and keeps dollars apart", () => {
    const total = sumResources([
      item({
        tokens: { input: 10, output: 2, inputConvention: "inclusive" },
        usd: { reported: 1, source: "reported" },
      }),
      item({
        tokens: { input: 5, inputConvention: "unknown" },
        coverage: "legacy",
        usd: { estimated: 2, source: "estimated" },
      }),
      item({ coverage: "missing" }),
    ]);
    expect(total.tokens).toEqual({ input: 15, output: 2, inputConventionUnknown: 1 });
    expect(total.usd).toEqual({ estimated: 2, reported: 1 });
    expect(total.unpriced).toBe(1);
    expect(total.coverage).toEqual({ complete: 1, partial: 0, unknown: 0, legacy: 1, missing: 1 });
    expect(total.tokenCoverage).toBe("partial");
  });

  it("is complete only when every item is", () => {
    expect(sumResources([item({}), item({})]).tokenCoverage).toBe("complete");
    expect(sumResources([]).tokenCoverage).toBe("complete");
  });
});
