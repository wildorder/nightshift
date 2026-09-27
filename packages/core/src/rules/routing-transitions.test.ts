import type { RouteOutcome, RoutingDecision } from "@nightshift/contracts";
import { describe, expect, it } from "vitest";
import { createFixtures, FIXTURE_TIMESTAMP } from "../testing/factories.js";
import {
  canUpdateRouting,
  explainRoutingUpdate,
  IMMUTABLE_ROUTING_FIELDS,
  ROUTE_TERMINAL_OUTCOMES,
  routeOutcomeForNodeStatus,
} from "./routing-transitions.js";
import { EXECUTION_NODE_STATUSES } from "./transitions.js";

const fixtures = createFixtures();
const recorded = (overrides: Partial<RoutingDecision> = {}): RoutingDecision => ({
  schemaVersion: 1,
  ...fixtures.scope,
  routingDecisionId: fixtures.ids.next("route"),
  executionNodeId: fixtures.rootNodeId,
  attempt: 1,
  eligibleOptions: [
    { target: { harness: "claude", provider: "anthropic", model: "m" }, eligible: true },
  ],
  chosen: { harness: "claude", provider: "anthropic", model: "m" },
  ruleId: "p5-configured",
  wasOverride: false,
  usage: {},
  outcome: "pending",
  previousRouteId: null,
  createdAt: FIXTURE_TIMESTAMP,
  ...overrides,
});

describe("routing decision updates (D-P5-06)", () => {
  it("accepts an identical record: a retry is not a change", () => {
    const decision = recorded();
    expect(explainRoutingUpdate(decision, { ...decision })).toEqual([]);
  });

  it("lets usage be set once, from empty, together with the ending", () => {
    const decision = recorded();
    const finished = {
      ...decision,
      usage: { inputTokens: 10, wallClockMs: 5 },
      outcome: "verified" as const,
    };
    expect(canUpdateRouting(decision, finished)).toBe(true);
    // Confirming it again is a retry.
    expect(canUpdateRouting(finished, { ...finished })).toBe(true);
  });

  it("refuses a second, different usage", () => {
    const decision = recorded({ usage: { inputTokens: 10 }, outcome: "verified" });
    expect(explainRoutingUpdate(decision, { ...decision, usage: { inputTokens: 11 } })).toEqual([
      "usage is already recorded; it may be set once, from empty",
    ]);
    expect(canUpdateRouting(decision, { ...decision, usage: {} })).toBe(false);
  });

  it("moves outcome from pending to every ending, and from no ending anywhere", () => {
    for (const ending of ROUTE_TERMINAL_OUTCOMES) {
      const decision = recorded();
      expect(canUpdateRouting(decision, { ...decision, outcome: ending }), ending).toBe(true);
      for (const next of ["pending", ...ROUTE_TERMINAL_OUTCOMES] as RouteOutcome[]) {
        if (next === ending) continue;
        const ended = { ...decision, outcome: ending };
        expect(canUpdateRouting(ended, { ...ended, outcome: next }), `${ending}→${next}`).toBe(
          false,
        );
      }
    }
  });

  it("holds every other field immutable, and says which", () => {
    const decision: RoutingDecision = {
      ...recorded(),
      ladder: "claude",
      rung: { tier: "standard", index: 1 },
      classification: { risk: "low", ambiguity: "low", testability: "weak" },
      policyVersion: 1,
      purpose: "examine",
    };
    const changes: Partial<RoutingDecision> = {
      attempt: 2,
      chosen: { harness: "codex", provider: "openai", model: "x" },
      ruleId: "other",
      wasOverride: true,
      executionNodeId: fixtures.ids.next("node"),
      createdAt: "2027-01-01T00:00:00.000Z" as never,
      eligibleOptions: [],
    };
    for (const [field, value] of Object.entries(changes)) {
      const problems = explainRoutingUpdate(decision, { ...decision, [field]: value });
      expect(problems, field).toEqual([
        `${field} is immutable once a routing decision is recorded`,
      ]);
    }
    // The list names every field but the two that may change.
    expect([...IMMUTABLE_ROUTING_FIELDS, "usage", "outcome"].sort()).toEqual(
      Object.keys(decision).sort(),
    );
  });

  it("gives every settled node status an ending, and only those", () => {
    // `deferred` (P7, D-P7-10) is a check waiting on a human, not an ending.
    const unsettled = ["validated", "queued", "running", "implemented", "verifying", "deferred"];
    for (const status of EXECUTION_NODE_STATUSES) {
      const outcome = routeOutcomeForNodeStatus(status);
      expect(outcome === "pending", status).toBe(unsettled.includes(status));
    }
    expect(routeOutcomeForNodeStatus("integrated")).toBe("verified");
    // A sub-program's orchestrator is never verified: it produced no commit.
    expect(routeOutcomeForNodeStatus("succeeded")).toBe("succeeded");
    expect(routeOutcomeForNodeStatus("interrupted")).toBe("failed");
  });
});
