import type { ModelPolicy, ProgramContract } from "@nightshift/contracts";
import { createFixtures, makeJobContract, makeProgramContract } from "@nightshift/core";
import { describe, expect, it } from "vitest";
import { compatiblePairs, HARNESS_COMPATIBILITY, matchesModelPattern } from "./compatibility.js";
import { CONFIGURED_RULE_ID, configuredRoute, RoutingRefusedError } from "./configured.js";

const f = createFixtures();
const job = makeJobContract(f);

const programWith = (policy: Partial<ModelPolicy>): ProgramContract =>
  makeProgramContract(f, {
    modelPolicy: {
      allowedProviders: ["anthropic"],
      allowedModels: [],
      forbiddenModels: [],
      ...policy,
    },
  });

const refused = (run: () => unknown): RoutingRefusedError => {
  try {
    run();
  } catch (error) {
    if (error instanceof RoutingRefusedError) return error;
    throw error;
  }
  throw new Error("expected a routing refusal");
};

describe("the compatibility table (D-P5-04)", () => {
  it("is not a 1:1 map: one harness runs more than one provider, and one provider more than one harness", () => {
    const claude = HARNESS_COMPATIBILITY.find((row) => row.harness === "claude");
    expect(claude?.providers.map((pair) => pair.provider)).toEqual(["anthropic", "bedrock"]);
    const bedrock = compatiblePairs().filter((pair) => pair.provider === "bedrock");
    expect(bedrock.map((pair) => pair.harness)).toEqual(["claude", "agentcore"]);
  });

  it("holds the agentcore row's shape for P10, and marks it not yet routable", () => {
    const row = HARNESS_COMPATIBILITY.find((candidate) => candidate.harness === "agentcore");
    expect(row?.providers).toEqual([
      { provider: "bedrock", models: ["*"], authentication: "instance-role", availableFrom: "P10" },
    ]);
  });

  it("says how every pair authenticates, and never with a secret", () => {
    for (const pair of compatiblePairs()) {
      expect(["operator-login", "instance-role"]).toContain(pair.authentication);
    }
  });

  it("matches literals and wildcards", () => {
    expect(matchesModelPattern("claude-*", "claude-sonnet-5")).toBe(true);
    expect(matchesModelPattern("claude-*", "gpt-5.5")).toBe(false);
    expect(matchesModelPattern("sonnet", "sonnet")).toBe(true);
    expect(matchesModelPattern("sonnet", "sonnet-x")).toBe(false);
    expect(matchesModelPattern("*.anthropic.*", "us.anthropic.claude-haiku-4-5")).toBe(true);
    expect(matchesModelPattern("*", "anything")).toBe(true);
  });
});

describe("choosing", () => {
  it("chooses the Claude adapter and the first model the policy allows", () => {
    const choice = configuredRoute({
      program: programWith({ allowedModels: ["claude-opus-5", "claude-sonnet-5"] }),
      job,
    });
    expect(choice.target).toEqual({
      harness: "claude",
      provider: "anthropic",
      model: "claude-opus-5",
    });
    expect(choice.ruleId).toBe(CONFIGURED_RULE_ID);
    expect(choice.wasOverride).toBe(false);
  });

  it("falls back to the pair's documented default when the policy names no model", () => {
    expect(configuredRoute({ program: programWith({}), job }).target.model).toBe("claude-sonnet-5");
    expect(
      configuredRoute({ program: programWith({ allowedProviders: ["openai"] }), job }).target,
    ).toEqual({ harness: "codex", provider: "openai", model: "gpt-5.5" });
  });

  it("skips a forbidden model and takes the next allowed one", () => {
    const choice = configuredRoute({
      program: programWith({
        allowedModels: ["claude-opus-5", "claude-sonnet-5"],
        forbiddenModels: ["claude-opus-5"],
      }),
      job,
    });
    expect(choice.target.model).toBe("claude-sonnet-5");
  });

  it("changes adapter when the policy's provider order changes, with no code change (SC-P5-16)", () => {
    const models = ["claude-sonnet-5", "gpt-5.5"];
    const anthropicFirst = configuredRoute({
      program: programWith({ allowedProviders: ["anthropic", "openai"], allowedModels: models }),
      job,
    });
    const openaiFirst = configuredRoute({
      program: programWith({ allowedProviders: ["openai", "anthropic"], allowedModels: models }),
      job,
    });
    expect(anthropicFirst.target.harness).toBe("claude");
    expect(openaiFirst.target).toEqual({ harness: "codex", provider: "openai", model: "gpt-5.5" });
    // Both considered both, and said so.
    expect(openaiFirst.eligibleOptions.map((option) => option.target.harness)).toEqual([
      "codex",
      "claude",
    ]);
  });

  it("pairs a model only with a harness that can run it", () => {
    const choice = configuredRoute({
      program: programWith({
        allowedProviders: ["openai", "anthropic"],
        allowedModels: ["claude-sonnet-5"],
      }),
      job,
    });
    // openai is preferred, but nothing it offers is allowed; codex is never
    // offered a Claude model.
    expect(choice.target).toEqual({
      harness: "claude",
      provider: "anthropic",
      model: "claude-sonnet-5",
    });
    expect(choice.eligibleOptions).toHaveLength(1);
  });
});

describe("the record it leaves (A-13)", () => {
  it("lists every option considered, eligible or not, with a reason for each refusal", () => {
    const choice = configuredRoute({
      program: programWith({
        allowedProviders: ["anthropic", "bedrock"],
        allowedModels: ["claude-opus-5", "claude-sonnet-5", "anthropic.claude-sonnet-5"],
        forbiddenModels: ["claude-opus-5"],
      }),
      job,
    });
    expect(choice.eligibleOptions.map((option) => [option.target.model, option.eligible])).toEqual([
      ["claude-opus-5", false],
      ["claude-sonnet-5", true],
      // claude on bedrock, then agentcore, whose row runs anything bedrock offers.
      ["anthropic.claude-sonnet-5", false],
      ["claude-opus-5", false],
      ["claude-sonnet-5", false],
      ["anthropic.claude-sonnet-5", false],
    ]);
    for (const option of choice.eligibleOptions) {
      if (!option.eligible) expect(option.reason).toBeTruthy();
    }
    expect(choice.eligibleOptions.at(-1)?.reason).toContain("P10");
  });
});

describe("an orchestrator's pin", () => {
  const open = programWith({ allowedProviders: ["anthropic", "openai"] });

  it("honours a pinned model the policy allows, and records the override", () => {
    const choice = configuredRoute({
      program: programWith({ allowedModels: ["claude-opus-5", "claude-sonnet-5"] }),
      job,
      override: { model: "claude-sonnet-5" },
    });
    expect(choice.target.model).toBe("claude-sonnet-5");
    expect(choice.wasOverride).toBe(true);
    expect(choice.eligibleOptions[0]).toMatchObject({ eligible: false });
    expect(choice.eligibleOptions[0]?.reason).toContain("pinned");
  });

  it("honours a pinned model against an open policy, on whichever harness runs it", () => {
    const choice = configuredRoute({ program: open, job, override: { model: "gpt-6-astra" } });
    expect(choice.target).toEqual({ harness: "codex", provider: "openai", model: "gpt-6-astra" });
    expect(choice.wasOverride).toBe(true);
  });

  it("honours a pinned harness, and says why the others were passed over", () => {
    const choice = configuredRoute({ program: open, job, override: { harness: "codex" } });
    expect(choice.target.harness).toBe("codex");
    expect(choice.wasOverride).toBe(true);
    const claude = choice.eligibleOptions.find((option) => option.target.harness === "claude");
    expect(claude).toMatchObject({ eligible: false });
    expect(claude?.reason).toContain("pinned the codex harness");
  });

  it("refuses a model the policy forbids, and the refusal explains itself", () => {
    const error = refused(() =>
      configuredRoute({
        program: programWith({ forbiddenModels: ["claude-opus-5"] }),
        job,
        override: { model: "claude-opus-5" },
      }),
    );
    expect(error.code).toBe("model_forbidden");
    expect(error.message).toContain("forbids");
    expect(error.eligibleOptions[0]).toMatchObject({ eligible: false });
  });

  it("refuses a model the policy does not list", () => {
    const error = refused(() =>
      configuredRoute({
        program: programWith({ allowedModels: ["claude-sonnet-5"] }),
        job,
        override: { model: "claude-opus-5" },
      }),
    );
    expect(error.code).toBe("model_forbidden");
  });

  it("refuses a harness the table does not know", () => {
    const error = refused(() =>
      configuredRoute({ program: open, job, override: { harness: "gemini" } }),
    );
    expect(error.code).toBe("harness_unknown");
    expect(error.message).toContain("claude, codex, agentcore");
  });

  it("refuses a harness whose providers the program does not allow", () => {
    const error = refused(() =>
      configuredRoute({ program: programWith({}), job, override: { harness: "codex" } }),
    );
    expect(error.code).toBe("provider_not_allowed");
  });

  it("refuses a harness and model the table says are incompatible", () => {
    const error = refused(() =>
      configuredRoute({
        program: open,
        job,
        override: { harness: "codex", model: "claude-sonnet-5" },
      }),
    );
    expect(error.code).toBe("harness_model_incompatible");
    expect(error.message).toContain("cannot run");

    const byPolicy = refused(() =>
      configuredRoute({
        program: programWith({
          allowedProviders: ["anthropic", "openai"],
          allowedModels: ["claude-sonnet-5"],
        }),
        job,
        override: { harness: "codex" },
      }),
    );
    expect(byPolicy.code).toBe("harness_model_incompatible");
  });
});

describe("programs nothing can route", () => {
  it("refuses a program whose providers no harness runs", () => {
    const error = refused(() =>
      configuredRoute({ program: programWith({ allowedProviders: ["mistral"] }), job }),
    );
    expect(error.code).toBe("provider_not_allowed");
  });

  it("refuses a bedrock-only program by naming the program that brings it", () => {
    const error = refused(() =>
      configuredRoute({
        program: programWith({
          allowedProviders: ["bedrock"],
          allowedModels: ["anthropic.claude-sonnet-5"],
        }),
        job,
      }),
    );
    expect(error.code).toBe("route_not_yet_available");
    expect(error.message).toContain("P10");
  });

  it("refuses a policy that forbids everything it allows", () => {
    const error = refused(() =>
      configuredRoute({
        program: programWith({
          allowedModels: ["claude-sonnet-5"],
          forbiddenModels: ["claude-sonnet-5"],
        }),
        job,
      }),
    );
    expect(error.code).toBe("no_eligible_route");
  });
});
