/** Who examines and who arbitrates, from their roles' lists (D-P8-10, D-P8-13, D-RR-01). */
import { DEFAULT_ROUTING_POLICY, type ModelPolicy } from "@nightshift/contracts";
import { describe, expect, it } from "vitest";
import { RoutingRefusedError } from "./errors.js";
import {
  arbiterRoute,
  arbiterSharesModelWith,
  examinerRoute,
  strongestExaminerRoute,
} from "./examiners.js";

const BOTH: ModelPolicy = {
  allowedProviders: ["anthropic", "openai"],
  allowedModels: [],
  forbiddenModels: [],
};
// The default examiner list: Astra, Opus, Sol, Sonnet. The arbiter's: Opus, Astra.
const base = { policy: DEFAULT_ROUTING_POLICY, policyVersion: 1, modelPolicy: BOTH };
const SONNET = { harness: "claude", provider: "anthropic", model: "claude-sonnet-5" };
const OPUS = { harness: "claude", provider: "anthropic", model: "claude-opus-5-5" };
const ASTRA = { harness: "codex", provider: "openai", model: "gpt-6-astra" };

describe("examinerRoute (D-P8-10)", () => {
  it("is the first route on the examiner's list", () => {
    const route = examinerRoute({
      ...base,
      implementer: SONNET,
      mustDifferModel: true,
      mustDifferProvider: true,
    });
    expect(route.target).toMatchObject({ provider: "openai", model: "gpt-6-astra" });
    expect(route).toMatchObject({ role: "examiner", position: 0, ruleId: "examiner" });
  });

  it("passes over a route as independent as the policy asks", () => {
    const route = examinerRoute({
      ...base,
      implementer: ASTRA,
      mustDifferModel: true,
      mustDifferProvider: false,
    });
    expect(route.target.model).toBe(OPUS.model);
  });

  it("passes over a limited route to the next independent one", () => {
    const route = examinerRoute({
      ...base,
      implementer: SONNET,
      mustDifferModel: true,
      mustDifferProvider: true,
      unavailable: [{ harness: "codex", model: "gpt-6-astra" }],
    });
    expect(route.target.model).toBe("gpt-6-sol");
  });

  it("refuses when the program permits nothing independent enough", () => {
    expect(() =>
      examinerRoute({
        ...base,
        modelPolicy: { ...BOTH, allowedProviders: ["anthropic"] },
        implementer: SONNET,
        mustDifferModel: true,
        mustDifferProvider: true,
      }),
    ).toThrow(RoutingRefusedError);
  });
});

describe("strongestExaminerRoute (D-P8-10, as amended 2026-10-12)", () => {
  it("is the first route on the examiner's list that can run, whatever built the work", () => {
    const route = strongestExaminerRoute({
      ...base,
      implementer: OPUS,
      unavailable: [{ harness: "codex", model: "gpt-6-astra" }],
    });
    expect(route.target.model).toBe(OPUS.model);
    expect(route.ruleId).toBe("examiner-strongest");
  });
});

describe("arbiterRoute (D-P8-13)", () => {
  it("is the first route on the arbiter's list neither side used", () => {
    const route = arbiterRoute({ ...base, implementer: OPUS, examiner: SONNET });
    expect(route.target.model).toBe(ASTRA.model);
  });

  it("takes a side's model, fresh, when every route on the list is a side's", () => {
    const route = arbiterRoute({ ...base, implementer: OPUS, examiner: ASTRA });
    expect(route.target.model).toBe(OPUS.model);
    expect(arbiterSharesModelWith(route.target, { implementer: OPUS, examiner: ASTRA })).toBe(
      "implementer",
    );
  });

  it("takes the other side's model when the first cannot run", () => {
    const route = arbiterRoute({
      ...base,
      implementer: OPUS,
      examiner: ASTRA,
      unavailable: [{ harness: "claude", model: OPUS.model }],
    });
    expect(route.target.model).toBe(ASTRA.model);
  });
});
