/**
 * `ruleRoute`, table by table (SC-P8-01 … SC-P8-06). The org's default policy:
 * Claude haiku → sonnet → opus, Codex luna → sol → astra.
 */
import {
  type Classification,
  DEFAULT_ROUTING_POLICY,
  type ModelPolicy,
  type RoutingPolicy,
} from "@nightshift/contracts";
import { describe, expect, it } from "vitest";
import { RoutingRefusedError } from "./errors.js";
import { type RuleRouteInput, ruleRoute } from "./rules.js";

const BOTH: ModelPolicy = {
  allowedProviders: ["anthropic", "openai"],
  allowedModels: [],
  forbiddenModels: [],
};
const BOUNDED: Classification = { risk: "low", ambiguity: "low", testability: "strong" };
const UNSAID: Classification = { risk: "low", ambiguity: "low", testability: "weak" };

const route = (overrides: Partial<RuleRouteInput> = {}) =>
  ruleRoute({
    policy: DEFAULT_ROUTING_POLICY,
    policyVersion: 4,
    modelPolicy: BOTH,
    classification: BOUNDED,
    ...overrides,
  });

describe("the first matching rule says where a job starts (D-P8-04)", () => {
  const cases: readonly [string, Classification, string, string][] = [
    ["bounded, clear and strongly tested", BOUNDED, "R-bounded", "claude-haiku-4-5-20251001"],
    ["unclassified testability", UNSAID, "R-default", "claude-sonnet-5"],
    ["high risk", { ...BOUNDED, risk: "high" }, "R-high", "claude-opus-5-5"],
    ["an orchestrator", { ...UNSAID, kind: "orchestrate" }, "R-orchestrate", "claude-opus-5-5"],
    ["ambiguous", { ...BOUNDED, ambiguity: "medium" }, "R-default", "claude-sonnet-5"],
  ];
  it.each(cases)("%s → %s on %s", (_name, classification, ruleId, model) => {
    const choice = route({ classification });
    expect(choice.ruleId).toBe(ruleId);
    expect(choice.target.model).toBe(model);
    expect(choice.target.provider).toBe("anthropic");
    expect(choice.policyVersion).toBe(4);
    expect(choice.classification).toEqual(classification);
  });

  it("records where on the ladders the route sits", () => {
    expect(route()).toMatchObject({ ladder: "claude", rung: { tier: "cheap", index: 0 } });
  });

  it("is deterministic: the same inputs, the same route and the same record", () => {
    expect(route({ classification: UNSAID })).toEqual(route({ classification: UNSAID }));
  });
});

describe("the program's model policy intersects everything", () => {
  it("skips a rung the policy forbids and climbs, recording why", () => {
    const choice = route({
      modelPolicy: { ...BOTH, forbiddenModels: ["claude-haiku-4-5-20251001", "gpt-6-luna"] },
    });
    expect(choice.target.model).toBe("claude-sonnet-5");
    expect(
      choice.eligibleOptions.filter((option) => !option.eligible).map((option) => option.reason),
    ).toEqual([
      'the program\'s modelPolicy forbids "claude-haiku-4-5-20251001"',
      'the program\'s modelPolicy forbids "gpt-6-luna"',
    ]);
  });

  it("never chooses a provider the program does not allow", () => {
    const choice = route({ modelPolicy: { ...BOTH, allowedProviders: ["openai"] } });
    expect(choice.target).toMatchObject({
      harness: "codex",
      provider: "openai",
      model: "gpt-6-luna",
    });
  });
});

describe("fallback is sideways, then across, then up; never down (D-P8-06, SC-P8-05)", () => {
  it("tries the other provider at the same tier before climbing", () => {
    const choice = route({
      unavailable: [{ harness: "claude", model: "claude-haiku-4-5-20251001" }],
    });
    expect(choice.target.model).toBe("gpt-6-luna");
    expect(choice.ladder).toBe("codex");
  });

  it("climbs when the whole tier is unavailable", () => {
    const choice = route({
      unavailable: [
        { harness: "claude", model: "claude-haiku-4-5-20251001" },
        { harness: "codex", model: "gpt-6-luna" },
      ],
    });
    expect(choice.target.model).toBe("claude-sonnet-5");
  });

  it("honours the org's own unavailable list", () => {
    const policy: RoutingPolicy = {
      ...DEFAULT_ROUTING_POLICY,
      unavailable: [{ harness: "claude", model: "claude-haiku-4-5-20251001" }],
    };
    expect(route({ policy }).target.model).toBe("gpt-6-luna");
  });

  it("never falls to a cheaper rung than the rule starts on", () => {
    const choice = route({
      classification: UNSAID,
      unavailable: [
        { harness: "claude", model: "claude-sonnet-5" },
        { harness: "codex", model: "gpt-6-sol" },
      ],
    });
    expect(choice.target.model).toBe("claude-opus-5-5");
    expect(choice.eligibleOptions.map((option) => option.target.model)).not.toContain(
      "claude-haiku-4-5-20251001",
    );
  });

  it("refuses, with every option considered, when nothing is left", () => {
    const everything = Object.values(DEFAULT_ROUTING_POLICY.ladders).flatMap((ladder) =>
      ladder.flatMap((rung) => rung.routes.map(({ harness, model }) => ({ harness, model }))),
    );
    expect(() => route({ unavailable: everything })).toThrow(RoutingRefusedError);
  });
});

describe("a retry climbs one rung after a failure of the model, and not otherwise (D-P8-07)", () => {
  const cheap = route();

  it("climbs after a real failure", () => {
    const next = route({
      previous: { target: cheap.target, ladder: "claude", rungIndex: 0, climb: true },
    });
    expect(next.target.model).toBe("claude-sonnet-5");
    expect(next.rung).toEqual({ tier: "standard", index: 1 });
  });

  it("stays at the top once there", () => {
    const next = route({
      previous: {
        target: { harness: "claude", provider: "anthropic", model: "claude-opus-5-5" },
        ladder: "claude",
        rungIndex: 2,
        climb: true,
      },
    });
    expect(next.target.model).toBe("claude-opus-5-5");
  });

  it("keeps the route after a failure that is not the model's", () => {
    const sonnet = route({ classification: UNSAID });
    const next = route({
      classification: UNSAID,
      previous: { target: sonnet.target, ladder: "claude", rungIndex: 1, climb: false },
    });
    expect(next.target.model).toBe("claude-sonnet-5");
  });
});

describe("an orchestrator's pins (D-P8-05, SC-P8-04)", () => {
  it("honours a pinned model within policy, as an override", () => {
    const choice = route({ pins: { model: "gpt-6-astra" } });
    expect(choice).toMatchObject({
      wasOverride: true,
      target: { model: "gpt-6-astra" },
      ladder: "codex",
    });
  });

  it("honours a pinned ladder and tier", () => {
    const choice = route({ pins: { ladder: "codex", tier: "standard" } });
    expect(choice.target.model).toBe("gpt-6-sol");
  });

  it("refuses a pinned model the policy's ladders do not have", () => {
    expect(() => route({ pins: { model: "gpt-5.5" } })).toThrow(RoutingRefusedError);
  });

  it("refuses a pinned model the program forbids", () => {
    expect(() =>
      route({
        pins: { model: "gpt-6-astra" },
        modelPolicy: { ...BOTH, forbiddenModels: ["gpt-6-astra"] },
      }),
    ).toThrow(RoutingRefusedError);
  });

  it("carries a pinned effort onto the target, else the rung's", () => {
    expect(route({ pins: { effort: "high" } }).target.effort).toBe("high");
    const policy: RoutingPolicy = {
      ...DEFAULT_ROUTING_POLICY,
      ladders: {
        ...DEFAULT_ROUTING_POLICY.ladders,
        claude: [
          {
            tier: "cheap",
            routes: [{ harness: "claude", model: "claude-haiku-4-5-20251001", effort: "low" }],
          },
        ],
      },
    };
    expect(route({ policy }).target.effort).toBe("low");
  });
});

describe("a program that caps the ladder lowers its ceiling (D-P8-03, D-P8-06)", () => {
  const SONNET_ONLY: ModelPolicy = {
    allowedProviders: ["anthropic"],
    allowedModels: ["claude-sonnet-5"],
    forbiddenModels: [],
  };

  it("routes an orchestrator to the highest rung the program permits", () => {
    const choice = route({
      classification: { ...UNSAID, kind: "orchestrate" },
      modelPolicy: SONNET_ONLY,
    });
    expect(choice.target.model).toBe("claude-sonnet-5");
  });

  it("still never goes down for a route that is merely unavailable", () => {
    expect(() =>
      route({
        classification: { ...UNSAID, risk: "high" },
        unavailable: [
          { harness: "claude", model: "claude-opus-5-5" },
          { harness: "codex", model: "gpt-6-astra" },
        ],
      }),
    ).toThrow(RoutingRefusedError);
  });
});
