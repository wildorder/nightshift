import { describe, expect, it } from "vitest";
import {
  countersToRouteUsage,
  mostFrequent,
  requestCounters,
  requestProvenance,
  resultProvenance,
  sumModelUsage,
} from "./usage.js";

const entry = (i: number, o: number, cr = 0, cw = 0, extra: object = {}) => ({
  inputTokens: i,
  outputTokens: o,
  cacheReadInputTokens: cr,
  cacheCreationInputTokens: cw,
  ...extra,
});

describe("sumModelUsage", () => {
  it("sums over models, takes reasoning from thinkingTokens and the cost as reportedUsd", () => {
    const totals = sumModelUsage(
      {
        a: entry(1, 2, 3, 4, { thinkingTokens: 5, contextWindow: 1000 }),
        b: entry(10, 20, 0, 0, { thinkingTokens: 0 }),
      },
      1.5,
    );
    expect(totals?.counters).toEqual({
      inputTokens: 11,
      outputTokens: 22,
      cacheReadTokens: 3,
      cacheWriteTokens: 4,
      reasoningTokens: 5,
      inputIncludesCache: false,
      reportedUsd: 1.5,
    });
    expect([...(totals?.contextWindows ?? [])]).toEqual([["a", 1000]]);
  });

  it("emits only the counters a model reports", () => {
    const totals = sumModelUsage({ m: { inputTokens: 12 } }, undefined);
    expect(totals?.counters).toEqual({
      inputTokens: 12,
      inputIncludesCache: false,
    });
  });

  it("leaves a counter absent when any model lacks it, summing the others", () => {
    const { outputTokens: _omit, ...noOutput } = entry(5, 0, 2, 3);
    const totals = sumModelUsage({ a: entry(1, 2, 3, 4), b: noOutput }, undefined);
    expect(totals?.counters).toEqual({
      inputTokens: 6,
      cacheReadTokens: 5,
      cacheWriteTokens: 7,
      inputIncludesCache: false,
    });
  });

  it.each([-1, "7", Number.NaN, null])("leaves a counter absent for invalid value %j", (bad) => {
    const totals = sumModelUsage({ a: entry(1, 2), b: { ...entry(1, 2), outputTokens: bad } }, 0);
    expect(totals?.counters).not.toHaveProperty("outputTokens");
    expect(totals?.counters).toMatchObject({ inputTokens: 2 });
  });

  it("leaves reasoningTokens absent when only one of two models reports thinkingTokens", () => {
    const totals = sumModelUsage(
      { a: entry(1, 2, 0, 0, { thinkingTokens: 5 }), b: entry(1, 2) },
      0,
    );
    expect(totals?.counters).not.toHaveProperty("reasoningTokens");
  });

  it("sums all five counters when both models report everything", () => {
    const totals = sumModelUsage(
      {
        a: entry(1, 2, 3, 4, { thinkingTokens: 5 }),
        b: entry(10, 20, 30, 40, { thinkingTokens: 50 }),
      },
      undefined,
    );
    expect(totals?.counters).toEqual({
      inputTokens: 11,
      outputTokens: 22,
      cacheReadTokens: 33,
      cacheWriteTokens: 44,
      reasoningTokens: 55,
      inputIncludesCache: false,
    });
  });

  it("omits reasoning when no model reports thinkingTokens, and a bad cost", () => {
    const totals = sumModelUsage({ a: entry(1, 1) }, -1);
    expect(totals?.counters).not.toHaveProperty("reasoningTokens");
    expect(totals?.counters).not.toHaveProperty("reportedUsd");
  });

  it.each([undefined, null, [], {}, { a: entry(0, 0) }, { a: "x" }])(
    "returns undefined for empty or zeroed modelUsage %#",
    (value) => {
      expect(sumModelUsage(value, 0)).toBeUndefined();
    },
  );
});

describe("requestCounters", () => {
  it("never reads output_tokens", () => {
    const counters = requestCounters({
      input_tokens: 2,
      output_tokens: 99,
      cache_read_input_tokens: 3,
    });
    expect(counters).toEqual({
      inputTokens: 2,
      cacheReadTokens: 3,
      inputIncludesCache: false,
    });
  });
  it("is undefined without a usable counter", () => {
    expect(requestCounters({ output_tokens: 4 })).toBeUndefined();
    expect(requestCounters("x")).toBeUndefined();
  });
});

describe("helpers", () => {
  it("maps counters to route usage", () => {
    expect(countersToRouteUsage({ inputTokens: 1, reportedUsd: 2 }, 5)).toEqual({
      inputTokens: 1,
      inputIncludesCache: false,
      actualCostUsd: 2,
      latencyMs: 5,
    });
  });
  it("keeps notes within the contract's 400 characters", () => {
    expect(resultProvenance("2.1.286").note?.length).toBeLessThanOrEqual(400);
    expect(requestProvenance(undefined).note?.length).toBeLessThanOrEqual(400);
    expect(requestProvenance(undefined)).not.toHaveProperty("version");
  });
  it("picks the most frequent key, first seen on a tie", () => {
    expect(
      mostFrequent(
        new Map([
          ["a", 1],
          ["b", 2],
        ]),
      ),
    ).toBe("b");
    expect(
      mostFrequent(
        new Map([
          ["a", 1],
          ["b", 1],
        ]),
      ),
    ).toBe("a");
    expect(mostFrequent(new Map())).toBeUndefined();
  });
});
