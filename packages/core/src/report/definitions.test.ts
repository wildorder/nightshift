import { describe, expect, it } from "vitest";
import { METRIC_DEFINITIONS } from "./definitions.js";

describe("METRIC_DEFINITIONS", () => {
  const entries = Object.entries(METRIC_DEFINITIONS);

  it("keys each definition by its own unique id", () => {
    for (const [key, definition] of entries) expect(definition.id).toBe(key);
    expect(new Set(entries.map(([, definition]) => definition.id)).size).toBe(entries.length);
  });

  it("fills every field", () => {
    for (const [, d] of entries) {
      expect(d.label.trim()).not.toBe("");
      expect(d.definition.trim()).not.toBe("");
      expect(d.denominator.trim()).not.toBe("");
      expect(d.unit).toMatch(/^(tokens|usd|ms|count|ratio)$/);
      expect(d.evidence.length).toBeGreaterThan(0);
    }
  });

  it("says summed work time is not elapsed time, and the estimate is not a bill", () => {
    expect(METRIC_DEFINITIONS.summed_work_time.definition).toContain("not elapsed time");
    expect(METRIC_DEFINITIONS.api_equivalent_estimate.definition).toContain("not a bill");
  });
});
