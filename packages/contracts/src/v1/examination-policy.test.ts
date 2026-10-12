/** What a narrower policy may say about a limited examiner (D-P8-03, D-P8-10 as amended 2026-10-12). */
import { describe, expect, it } from "vitest";
import { DEFAULT_EXAMINATION_POLICY } from "./org-config.js";
import {
  type ExaminationPolicy,
  type IndependenceFallback,
  stricterExaminationPolicy,
} from "./program-contract.js";

const withHigh = (fallback: IndependenceFallback | undefined): ExaminationPolicy => ({
  ...DEFAULT_EXAMINATION_POLICY,
  high: {
    ...DEFAULT_EXAMINATION_POLICY.high,
    ...(fallback === undefined ? {} : { whenIndependentUnavailable: fallback }),
  },
});

const highOf = (
  org: IndependenceFallback | undefined,
  narrower: IndependenceFallback | undefined,
) => stricterExaminationPolicy(withHigh(org), withHigh(narrower)).high.whenIndependentUnavailable;

describe("whenIndependentUnavailable, narrowed", () => {
  it("keeps the org's strongest unless the narrower says wait", () => {
    expect(highOf("strongest", undefined)).toBe("strongest");
    expect(highOf("strongest", "strongest")).toBe("strongest");
    expect(highOf("strongest", "wait")).toBe("wait");
  });

  it("never loosens an org that waits, or says nothing", () => {
    expect(highOf("wait", "strongest")).toBe("wait");
    expect(highOf(undefined, "strongest")).toBeUndefined();
  });

  it("leaves a policy that never mentions it as it was", () => {
    expect(
      stricterExaminationPolicy(DEFAULT_EXAMINATION_POLICY, DEFAULT_EXAMINATION_POLICY),
    ).toEqual(DEFAULT_EXAMINATION_POLICY);
  });
});
