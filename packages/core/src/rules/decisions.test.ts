import type { Reversibility } from "@nightshift/contracts";
import { describe, expect, it } from "vitest";
import {
  DecisionAuthorityError,
  OwnershipViolationError,
  ReversibilitySoftenedError,
} from "../errors.js";
import {
  createFixturePair,
  createFixtures,
  FIXTURE_TIMESTAMP,
  makeDecision,
  makeRootNode,
} from "../testing/factories.js";
import {
  assertReversibilityNotSoftened,
  buildReversal,
  effectiveDecision,
  isSuperseded,
  outranks,
  overrideDecision,
  recordDecision,
  reversibilitySeverity,
  whyNotReversible,
} from "./decisions.js";

const [f, other] = createFixturePair();
const root = makeRootNode(f);
const nodeId = root.executionNodeId;

describe("recordDecision", () => {
  it("accepts a fresh decision", () => {
    const decision = makeDecision(f, nodeId);
    expect(recordDecision(decision)).toBe(decision);
  });

  it("refuses a decision that claims to supersede another", () => {
    const original = makeDecision(f, nodeId);
    const sneaky = makeDecision(f, nodeId, { supersedesDecisionId: original.decisionId });
    expect(() => recordDecision(sneaky)).toThrow(DecisionAuthorityError);
  });
});

describe("authority", () => {
  it("ranks human above agent and nothing above human", () => {
    expect(outranks("human", "agent")).toBe(true);
    expect(outranks("agent", "human")).toBe(false);
    expect(outranks("human", "human")).toBe(false);
    expect(outranks("agent", "agent")).toBe(false);
  });

  it("lets a human override an agent decision", () => {
    const original = makeDecision(f, nodeId, { authority: "agent" });
    const override = makeDecision(f, nodeId, { authority: "human" });
    const result = overrideDecision(original, override, FIXTURE_TIMESTAMP);
    expect(result.supersedesDecisionId).toBe(original.decisionId);
    expect(result.authority).toBe("human");
  });

  it("lets a human override an earlier human decision", () => {
    const original = makeDecision(f, nodeId, { authority: "human" });
    const override = makeDecision(f, nodeId, { authority: "human" });
    expect(() => overrideDecision(original, override, FIXTURE_TIMESTAMP)).not.toThrow();
  });

  it("refuses an agent overriding a human decision", () => {
    const original = makeDecision(f, nodeId, { authority: "human" });
    const override = makeDecision(f, nodeId, { authority: "agent" });
    expect(() => overrideDecision(original, override, FIXTURE_TIMESTAMP)).toThrow(
      DecisionAuthorityError,
    );
  });

  it("refuses a decision overriding itself", () => {
    const original = makeDecision(f, nodeId);
    expect(() => overrideDecision(original, original, FIXTURE_TIMESTAMP)).toThrow(
      DecisionAuthorityError,
    );
  });

  it("refuses an override from another ownership chain", () => {
    const original = makeDecision(f, nodeId);
    const foreign = makeDecision(other, nodeId);
    expect(() => overrideDecision(original, foreign, FIXTURE_TIMESTAMP)).toThrow(
      OwnershipViolationError,
    );
  });

  it("never mutates the original", () => {
    const original = makeDecision(f, nodeId, { authority: "agent" });
    const snapshot = { ...original };
    overrideDecision(original, makeDecision(f, nodeId, { authority: "human" }), FIXTURE_TIMESTAMP);
    expect(original).toEqual(snapshot);
  });

  it("stamps the override timestamp", () => {
    const at = "2026-12-25T00:00:00.000Z";
    const result = overrideDecision(
      makeDecision(f, nodeId, { authority: "agent" }),
      makeDecision(f, nodeId, { authority: "human" }),
      at,
    );
    expect(result.createdAt).toBe(at);
  });
});

describe("reversibility", () => {
  it("orders the classes by severity", () => {
    expect(reversibilitySeverity("reversible")).toBeLessThan(
      reversibilitySeverity("compensatable"),
    );
    expect(reversibilitySeverity("compensatable")).toBeLessThan(
      reversibilitySeverity("irreversible"),
    );
  });

  it.each([
    ["reversible", "reversible"],
    ["reversible", "compensatable"],
    ["reversible", "irreversible"],
    ["compensatable", "compensatable"],
    ["compensatable", "irreversible"],
    ["irreversible", "irreversible"],
  ] as [Reversibility, Reversibility][])("allows %s to become %s", (from, to) => {
    expect(() => assertReversibilityNotSoftened(from, to)).not.toThrow();
  });

  // Architecture §6: an irreversible external effect is never recorded as reversible.
  it.each([
    ["irreversible", "reversible"],
    ["irreversible", "compensatable"],
    ["compensatable", "reversible"],
  ] as [Reversibility, Reversibility][])("refuses %s becoming %s", (from, to) => {
    expect(() => assertReversibilityNotSoftened(from, to)).toThrow(ReversibilitySoftenedError);
  });

  it("refuses an override that softens reversibility", () => {
    const original = makeDecision(f, nodeId, { authority: "agent", reversibility: "irreversible" });
    const override = makeDecision(f, nodeId, { authority: "human", reversibility: "reversible" });
    expect(() => overrideDecision(original, override, FIXTURE_TIMESTAMP)).toThrow(
      ReversibilitySoftenedError,
    );
  });

  it("allows a human override that hardens reversibility", () => {
    const original = makeDecision(f, nodeId, { authority: "agent", reversibility: "reversible" });
    const override = makeDecision(f, nodeId, {
      authority: "human",
      reversibility: "irreversible",
    });
    expect(() => overrideDecision(original, override, FIXTURE_TIMESTAMP)).not.toThrow();
  });
});

describe("supersession chains", () => {
  it("identifies a superseded decision", () => {
    const first = makeDecision(f, nodeId, { authority: "agent" });
    const second = overrideDecision(
      first,
      makeDecision(f, nodeId, { authority: "human" }),
      FIXTURE_TIMESTAMP,
    );
    const all = [first, second];
    expect(isSuperseded(first, all)).toBe(true);
    expect(isSuperseded(second, all)).toBe(false);
  });

  it("follows a chain to the final word", () => {
    const first = makeDecision(f, nodeId, { authority: "agent" });
    const second = overrideDecision(
      first,
      makeDecision(f, nodeId, { authority: "human" }),
      FIXTURE_TIMESTAMP,
    );
    const third = overrideDecision(
      second,
      makeDecision(f, nodeId, { authority: "human" }),
      FIXTURE_TIMESTAMP,
    );
    expect(effectiveDecision(first, [first, second, third]).decisionId).toBe(third.decisionId);
  });

  it("throws on a supersession cycle rather than looping", () => {
    const a = makeDecision(f, nodeId);
    const b = makeDecision(f, nodeId);
    const aCycled = { ...a, supersedesDecisionId: b.decisionId };
    const bCycled = { ...b, supersedesDecisionId: a.decisionId };
    expect(() => effectiveDecision(aCycled, [aCycled, bCycled])).toThrow(DecisionAuthorityError);
  });
});

describe("buildReversal (P11, D-P11-08)", () => {
  const f = createFixtures();
  const root = makeRootNode(f);
  const original = makeDecision(f, root.executionNodeId, {
    context: "  Which store?  ",
    choice: "One table",
    rationale: "Simplest.",
    reversibility: "compensatable",
    checkpointAfter: f.ids.next("ckpt"),
    produced: { commits: ["a".repeat(40)] },
  });
  const at = "2026-09-28T12:00:00.000Z";

  it("writes exactly what `nightshift decision reverse` writes", () => {
    const reversal = buildReversal(original, {
      decisionId: f.ids.next("dec"),
      choice: "Two tables",
      reason: "Isolation.",
      at,
    });
    expect(reversal).toEqual({
      ...original,
      decisionId: reversal.decisionId,
      agentId: null,
      context: `The owner reversed ${original.decisionId} (Which store?)`,
      alternatives: [{ summary: "One table", rejectedBecause: "Isolation." }],
      choice: "Two tables",
      rationale: "Isolation.",
      authority: "human",
      supersedesDecisionId: original.decisionId,
      createdAt: at,
      checkpointAfter: undefined,
      produced: undefined,
    });
    expect("checkpointAfter" in reversal).toBe(false);
    expect("produced" in reversal).toBe(false);
    // Beside what it reverses: the same node, class and checkpoint.
    expect(reversal.executionNodeId).toBe(original.executionNodeId);
    expect(reversal.reversibility).toBe("compensatable");
    expect(reversal.checkpointBefore).toBe(original.checkpointBefore);
  });

  it("refuses to reverse a reversal, naming the decision to reverse instead", () => {
    const reversal = buildReversal(original, {
      decisionId: f.ids.next("dec"),
      choice: "Two tables",
      reason: "Isolation.",
      at,
    });
    expect(whyNotReversible(original)).toBeUndefined();
    expect(whyNotReversible(reversal)).toBe(
      `${reversal.decisionId} is itself a reversal; reverse the decision it superseded, ${original.decisionId}`,
    );
    expect(() =>
      buildReversal(reversal, { decisionId: f.ids.next("dec"), choice: "x", reason: "y", at }),
    ).toThrow(DecisionAuthorityError);
  });
});
