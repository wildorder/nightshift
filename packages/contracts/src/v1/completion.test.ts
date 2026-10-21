import { describe, expect, it } from "vitest";
import { CompletionMeasurementSchema } from "./completion.js";

const base = {
  measuredTo: "2026-10-01T00:10:00.000Z",
  readableMembers: 2,
  measuredMembers: 2,
  unmeasuredMembers: 0,
  activeSeconds: 10,
  recordedAt: "2026-10-01T00:10:00.000Z",
};
const combined = {
  usd: 3,
  model: 2,
  infrastructure: 1,
  coverage: {
    measuredMembers: 2,
    unmeasuredMembers: 0,
    estimateIncomplete: 0,
    membersWithoutMachine: 0,
  },
  lowerBound: false,
  priceBases: [],
};
const infrastructure = { usd: 1, members: 2, withoutMachine: 0 };

describe("a completion measurement's combined estimate", () => {
  it("accepts model plus machine", () => {
    expect(
      CompletionMeasurementSchema.safeParse({ ...base, infrastructure, combined }).success,
    ).toBe(true);
  });

  it("is optional: absent when neither component exists", () => {
    expect(CompletionMeasurementSchema.safeParse({ ...base }).success).toBe(true);
  });

  it("refuses a combined estimate with neither component", () => {
    const { model: _m, infrastructure: _i, ...neither } = combined;
    expect(
      CompletionMeasurementSchema.safeParse({ ...base, combined: { ...neither, usd: 0 } }).success,
    ).toBe(false);
  });

  it("refuses a model estimate when no member was measured", () => {
    expect(
      CompletionMeasurementSchema.safeParse({
        ...base,
        measuredMembers: 0,
        unmeasuredMembers: 2,
        infrastructure,
        combined,
      }).success,
    ).toBe(false);
  });

  it("refuses a machine estimate without an infrastructure report, and a usd that is not the sum", () => {
    expect(CompletionMeasurementSchema.safeParse({ ...base, combined }).success).toBe(false);
    expect(
      CompletionMeasurementSchema.safeParse({
        ...base,
        infrastructure,
        combined: { ...combined, usd: 99 },
      }).success,
    ).toBe(false);
  });
});
