/** Routing by role (D-RR-01): the first eligible route on the role's list, a retry one place down. */
import {
  type ModelPolicy,
  type RouteTarget,
  type RoutingPolicy,
  RoutingPolicySchema,
} from "@nightshift/contracts";
import { describe, expect, it } from "vitest";
import { RoutingRefusedError } from "./errors.js";
import { roleRoute } from "./roles.js";

const BOTH: ModelPolicy = {
  allowedProviders: ["anthropic", "openai"],
  allowedModels: [],
  forbiddenModels: [],
};

const route = (harness: string, model: string) => ({ harness, model });
const SONNET = route("claude", "claude-sonnet-5-5");
const SOL = route("codex", "gpt-6-sol");
const OPUS = route("claude", "claude-opus-5-5");
const ASTRA = route("codex", "gpt-6-astra");

const POLICY: RoutingPolicy = {
  roles: {
    orchestrator: [route("claude", "claude-fable-5-1"), ASTRA],
    implementer: [SONNET, SOL, OPUS, ASTRA],
    examiner: [ASTRA, route("claude", "claude-fable-5-1")],
    arbiter: [route("claude", "claude-fable-5-1"), ASTRA],
  },
  unavailable: [],
  prices: {},
};

const base = { policy: POLICY, policyVersion: 3, modelPolicy: BOTH, role: "implementer" as const };
const target = (spec: { harness: string; model: string }): RouteTarget => ({
  ...spec,
  provider: spec.harness === "claude" ? "anthropic" : "openai",
});

describe("roleRoute (D-RR-01)", () => {
  it("is the first route on the role's list, and says where it came from", () => {
    const choice = roleRoute(base);
    expect(choice.target.model).toBe(SONNET.model);
    expect(choice).toMatchObject({ role: "implementer", position: 0, ruleId: "implementer" });
    expect(roleRoute({ ...base, role: "orchestrator" }).target.model).toBe("claude-fable-5-1");
  });

  it("passes over a route that cannot serve now, to the next on the list", () => {
    const choice = roleRoute({ ...base, unavailable: [SONNET] });
    expect(choice.target.model).toBe(SOL.model);
    expect(choice.position).toBe(1);
    expect(choice.eligibleOptions[0]).toMatchObject({ eligible: false });
  });

  it("moves one place down the list on each retry after the work failed, and stays at the last", () => {
    const after = (failed: typeof SONNET, position: number) =>
      roleRoute({ ...base, previous: { target: target(failed), position, climb: true } }).target
        .model;
    expect(after(SONNET, 0)).toBe(SOL.model);
    expect(after(SOL, 1)).toBe(OPUS.model);
    expect(after(OPUS, 2)).toBe(ASTRA.model);
    expect(after(ASTRA, 3)).toBe(ASTRA.model);
  });

  it("finds a failed attempt's place by its route when the record has none", () => {
    const choice = roleRoute({ ...base, previous: { target: target(SOL), climb: true } });
    expect(choice.target.model).toBe(OPUS.model);
  });

  it("falls back above the start rather than stopping when everything below is out", () => {
    const choice = roleRoute({
      ...base,
      previous: { target: target(OPUS), position: 2, climb: true },
      unavailable: [ASTRA],
    });
    // Nearest above first: the failed Opus again, not back to the top of the list.
    expect(choice.target.model).toBe(OPUS.model);
  });

  it("retries the same route first after a failure that says nothing about the model", () => {
    const choice = roleRoute({
      ...base,
      previous: { target: target(OPUS), position: 2, climb: false },
    });
    expect(choice.target.model).toBe(OPUS.model);
  });

  it("holds to the program's model policy", () => {
    const choice = roleRoute({ ...base, modelPolicy: { ...BOTH, allowedProviders: ["openai"] } });
    expect(choice.target.model).toBe(SOL.model);
  });

  it("runs on what the program allows when it permits nothing on the role's list", () => {
    const choice = roleRoute({
      ...base,
      role: "orchestrator",
      modelPolicy: { ...BOTH, allowedModels: [SONNET.model] },
    });
    expect(choice.target.model).toBe(SONNET.model);
    expect(choice.position).toBeUndefined();
  });

  it("does not leave the role's list because its routes are only limited", () => {
    expect(() =>
      roleRoute({ ...base, role: "orchestrator", unavailable: POLICY.roles.orchestrator }),
    ).toThrow(RoutingRefusedError);
  });

  it("takes a pinned route from any role's list, as an override", () => {
    const choice = roleRoute({ ...base, pins: { model: "claude-fable-5-1" } });
    expect(choice.target.model).toBe("claude-fable-5-1");
    expect(choice.wasOverride).toBe(true);
    expect(choice.position).toBeUndefined();
  });

  it("refuses, with every option, when nothing on the list can run", () => {
    expect(() => roleRoute({ ...base, unavailable: [SONNET, SOL, OPUS, ASTRA] })).toThrow(
      RoutingRefusedError,
    );
  });
});

describe("a ladder configuration, read as role lists", () => {
  // The owner's org as it stood on 2026-10-12: a Codex ladder, a Claude ladder
  // added beside it, and the seeded rules.
  const ladders = {
    ladders: {
      codex: [
        { tier: "cheap", routes: [route("codex", "gpt-6-luna")] },
        { tier: "standard", routes: [SOL] },
        { tier: "frontier", routes: [ASTRA] },
      ],
      claude: [
        { tier: "cheap", routes: [route("claude", "claude-haiku-5-5")] },
        { tier: "standard", routes: [SONNET] },
        { tier: "frontier", routes: [route("claude", "claude-fable-5-1"), OPUS] },
      ],
    },
    rules: [
      {
        id: "R-orchestrate",
        when: { kind: ["orchestrate"] },
        start: { ladder: "codex", tier: "frontier" },
      },
      { id: "R-high", when: { risk: ["high"] }, start: { ladder: "codex", tier: "frontier" } },
      { id: "R-default", when: {}, start: { ladder: "codex", tier: "standard" } },
    ],
    unavailable: [],
    prices: {},
  };

  it("keeps what each role was routed to, and in what order it fell back", () => {
    const { roles } = RoutingPolicySchema.parse(ladders);
    const models = (list: readonly { model: string }[]) => list.map((spec) => spec.model);
    expect(models(roles.orchestrator)).toEqual([
      "gpt-6-astra",
      "claude-fable-5-1",
      "claude-opus-5-5",
    ]);
    expect(models(roles.implementer)).toEqual([
      "gpt-6-sol",
      "claude-sonnet-5-5",
      "gpt-6-astra",
      "claude-fable-5-1",
      "claude-opus-5-5",
    ]);
    expect(models(roles.examiner).slice(0, 3)).toEqual([
      "gpt-6-astra",
      "claude-fable-5-1",
      "claude-opus-5-5",
    ]);
  });

  it("parses a role policy as it is", () => {
    expect(RoutingPolicySchema.parse(POLICY)).toEqual(POLICY);
  });
});
