/** Who examines and who arbitrates, over the default ladders (D-P8-10, D-P8-13, SC-P8-09). */
import { DEFAULT_ROUTING_POLICY, type ModelPolicy } from "@nightshift/contracts";
import { describe, expect, it } from "vitest";
import { RoutingRefusedError } from "./errors.js";
import { arbiterRoute, arbiterSharesModelWith, examinerRoute } from "./examiners.js";

const BOTH: ModelPolicy = {
  allowedProviders: ["anthropic", "openai"],
  allowedModels: [],
  forbiddenModels: [],
};
const base = { policy: DEFAULT_ROUTING_POLICY, policyVersion: 1, modelPolicy: BOTH };
const SONNET = { harness: "claude", provider: "anthropic", model: "claude-sonnet-5" };
const ASTRA = { harness: "codex", provider: "openai", model: "gpt-6-astra" };

describe("examinerRoute (D-P8-10)", () => {
  it("examines high risk by the other provider's frontier model", () => {
    const route = examinerRoute({
      ...base,
      job: { risk: "high" },
      implementer: SONNET,
      mustDifferModel: true,
      mustDifferProvider: true,
    });
    expect(route.target).toMatchObject({ provider: "openai", model: "gpt-6-astra" });
    expect(route.rung?.tier).toBe("frontier");
  });

  it("examines medium risk by a different model at the standard tier", () => {
    const route = examinerRoute({
      ...base,
      job: { risk: "medium" },
      implementer: SONNET,
      mustDifferModel: true,
      mustDifferProvider: false,
    });
    expect(route.target.model).not.toBe(SONNET.model);
    expect(route.rung?.tier).toBe("standard");
  });

  it("refuses when the program permits nothing independent enough", () => {
    expect(() =>
      examinerRoute({
        ...base,
        modelPolicy: { ...BOTH, allowedProviders: ["anthropic"] },
        job: { risk: "high" },
        implementer: SONNET,
        mustDifferModel: true,
        mustDifferProvider: true,
      }),
    ).toThrow(RoutingRefusedError);
  });
});

describe("arbiterRoute (D-P8-13)", () => {
  it("is a frontier model neither side used", () => {
    const route = arbiterRoute({ ...base, implementer: SONNET, examiner: ASTRA });
    expect(route.target.model).toBe("claude-opus-5-5");
    expect(route.rung?.tier).toBe("frontier");
  });

  it("never goes below frontier: with both frontier models taken, it reuses the examiner's, fresh (as amended 2026-09-26)", () => {
    const opus = { harness: "claude", provider: "anthropic", model: "claude-opus-5-5" };
    const route = arbiterRoute({ ...base, implementer: opus, examiner: ASTRA });
    expect(route.target.model).toBe(ASTRA.model);
    expect(route.rung?.tier).toBe("frontier");
    expect(arbiterSharesModelWith(route.target, { implementer: opus, examiner: ASTRA })).toBe(
      "examiner",
    );
  });

  it("takes the implementer's frontier model only when the examiner's cannot run", () => {
    const opus = { harness: "claude", provider: "anthropic", model: "claude-opus-5-5" };
    const route = arbiterRoute({
      ...base,
      implementer: opus,
      examiner: ASTRA,
      unavailable: [{ harness: "codex", model: ASTRA.model }],
    });
    expect(route.target.model).toBe(opus.model);
  });
});
