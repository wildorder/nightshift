import type { ModelPolicy, ProgramContract } from "@nightshift/contracts";
import { createFixtures, makeJobContract, makeProgramContract } from "@nightshift/core";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODEL,
  FIXED_RULE_ID,
  fixedRoute,
  P3_HARNESS,
  P3_PROVIDER,
  RoutingRefusedError,
} from "./fixed.js";

const f = createFixtures();
const job = makeJobContract(f);

const programWith = (policy: Partial<ModelPolicy>): ProgramContract =>
  makeProgramContract(f, {
    modelPolicy: {
      allowedProviders: [P3_PROVIDER],
      allowedModels: [],
      forbiddenModels: [],
      ...policy,
    },
  });

describe("choosing", () => {
  it("chooses the Claude adapter and the first model the policy allows", () => {
    const choice = fixedRoute({
      program: programWith({ allowedModels: ["claude-opus-5", "claude-sonnet-5"] }),
      job,
    });
    expect(choice.target).toEqual({
      harness: P3_HARNESS,
      provider: P3_PROVIDER,
      model: "claude-opus-5",
    });
    expect(choice.ruleId).toBe(FIXED_RULE_ID);
    expect(choice.wasOverride).toBe(false);
  });

  it("falls back to the documented default when the policy names no model", () => {
    // An empty `allowedModels` means "any model this provider offers", which is
    // a policy statement rather than a choice; something still has to pick one.
    const choice = fixedRoute({ program: programWith({ allowedModels: [] }), job });
    expect(choice.target.model).toBe(DEFAULT_MODEL);
  });

  it("skips a forbidden model and takes the next allowed one", () => {
    const choice = fixedRoute({
      program: programWith({
        allowedModels: ["claude-opus-5", "claude-sonnet-5"],
        forbiddenModels: ["claude-opus-5"],
      }),
      job,
    });
    expect(choice.target.model).toBe("claude-sonnet-5");
  });
});

describe("the record it leaves (A-13)", () => {
  it("lists every option considered, eligible or not, with a reason for each refusal", () => {
    const choice = fixedRoute({
      program: programWith({
        allowedModels: ["claude-opus-5", "claude-sonnet-5"],
        forbiddenModels: ["claude-opus-5"],
      }),
      job,
    });
    expect(choice.eligibleOptions).toHaveLength(2);
    const [first, second] = choice.eligibleOptions;
    expect(first?.eligible).toBe(false);
    expect(first?.reason).toContain("forbids");
    expect(second?.eligible).toBe(true);
    expect(second?.reason).toBeUndefined();
  });

  /** The contract refuses an ineligible option that does not say why. */
  it("never leaves an ineligible option without a reason", () => {
    const choice = fixedRoute({
      program: programWith({ allowedModels: ["a", "b"], forbiddenModels: ["a"] }),
      job,
    });
    for (const option of choice.eligibleOptions) {
      expect(option.eligible || option.reason !== undefined).toBe(true);
    }
  });
});

describe("an orchestrator's override", () => {
  it("is honoured when the policy allows it, and recorded as an override", () => {
    const choice = fixedRoute({
      program: programWith({ allowedModels: ["claude-opus-5", "claude-sonnet-5"] }),
      job,
      override: "claude-sonnet-5",
    });
    expect(choice.target.model).toBe("claude-sonnet-5");
    expect(choice.wasOverride).toBe(true);
  });

  it("is honoured against an open policy", () => {
    const choice = fixedRoute({
      program: programWith({ allowedModels: [] }),
      job,
      override: "claude-haiku-4-5-20251001",
    });
    expect(choice.target.model).toBe("claude-haiku-4-5-20251001");
    expect(choice.wasOverride).toBe(true);
  });

  /**
   * Refused, not silently replaced. An orchestrator that asked for something
   * specific is entitled to know it was unavailable, rather than discovering
   * afterwards that something else ran.
   */
  it("is refused when the policy forbids it, and the refusal explains itself", () => {
    const attempt = () =>
      fixedRoute({
        program: programWith({ forbiddenModels: ["claude-opus-5"] }),
        job,
        override: "claude-opus-5",
      });
    expect(attempt).toThrow(RoutingRefusedError);
    const failure = (() => {
      try {
        attempt();
        return undefined;
      } catch (error) {
        return error as RoutingRefusedError;
      }
    })();
    expect(failure?.code).toBe("model_forbidden");
    expect(failure?.message).toContain("claude-opus-5");
    // The considered options come with the refusal, so it is self-explaining.
    expect(failure?.eligibleOptions.some((o) => o.target.model === "claude-opus-5")).toBe(true);
  });

  it("is refused when the policy allows only other models", () => {
    expect(() =>
      fixedRoute({
        program: programWith({ allowedModels: ["claude-sonnet-5"] }),
        job,
        override: "some-other-model",
      }),
    ).toThrow(RoutingRefusedError);
  });
});

describe("policies P3 cannot serve", () => {
  it("refuses a program whose providers P3 has no adapter for, and names P5", () => {
    const failure = (() => {
      try {
        fixedRoute({ program: programWith({ allowedProviders: ["openai"] }), job });
        return undefined;
      } catch (error) {
        return error as RoutingRefusedError;
      }
    })();
    expect(failure?.code).toBe("provider_not_allowed");
    expect(failure?.message).toContain("openai");
    expect(failure?.message).toContain("P5");
  });

  it("refuses a policy that forbids everything it allows", () => {
    const failure = (() => {
      try {
        fixedRoute({
          program: programWith({ allowedModels: ["only"], forbiddenModels: ["only"] }),
          job,
        });
        return undefined;
      } catch (error) {
        return error as RoutingRefusedError;
      }
    })();
    expect(failure?.code).toBe("no_eligible_model");
    expect(failure?.eligibleOptions.every((option) => !option.eligible)).toBe(true);
  });
});
