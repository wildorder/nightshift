import {
  DEFAULT_EXAMINATION_POLICY,
  DEFAULT_ROUTING_POLICY,
  type ExaminationPolicy,
  type OrgConfig,
} from "@nightshift/contracts";
import { describe, expect, it } from "vitest";
import {
  classificationOf,
  conservativeDefaults,
  effectivePolicy,
  examinationRequirementFor,
  PolicyWideningError,
  requireEffectivePolicy,
} from "./policy.js";

const org: Pick<OrgConfig, "routingPolicy" | "examinationPolicy" | "version"> = {
  routingPolicy: DEFAULT_ROUTING_POLICY,
  examinationPolicy: DEFAULT_EXAMINATION_POLICY,
  version: 3,
};

const OFF: ExaminationPolicy = {
  low: {
    required: false,
    mustDifferModel: false,
    mustDifferProvider: false,
    blockOnMaterialFindings: false,
  },
  medium: {
    required: false,
    mustDifferModel: false,
    mustDifferProvider: false,
    blockOnMaterialFindings: false,
  },
  high: {
    required: false,
    mustDifferModel: false,
    mustDifferProvider: false,
    blockOnMaterialFindings: false,
  },
};

describe("classificationOf (D-P8-01)", () => {
  it("fills testability conservatively and leaves an unsaid kind absent", () => {
    expect(classificationOf({ risk: "low", ambiguity: "low" })).toEqual({
      risk: "low",
      ambiguity: "low",
      testability: "weak",
    });
  });

  it("keeps what the job says", () => {
    expect(
      classificationOf({ risk: "high", ambiguity: "medium", testability: "strong", kind: "fix" }),
    ).toEqual({
      risk: "high",
      ambiguity: "medium",
      testability: "strong",
      kind: "fix",
    });
  });

  it("defaults a delegation's risk to the program's and its ambiguity to medium", () => {
    expect(conservativeDefaults({ defaultRisk: "high" })).toEqual({
      risk: "high",
      ambiguity: "medium",
    });
  });
});

describe("effectivePolicy (D-P8-03)", () => {
  it("is the org's policy when the program narrows nothing", () => {
    const result = requireEffectivePolicy(org, { examinationPolicy: OFF });
    expect(result.routingPolicy).toEqual(DEFAULT_ROUTING_POLICY);
    expect(result.orgConfigVersion).toBe(3);
  });

  it("never loosens examination: a program with examination off keeps the org's", () => {
    const result = requireEffectivePolicy(org, { examinationPolicy: OFF });
    expect(result.examinationPolicy).toEqual(DEFAULT_EXAMINATION_POLICY);
  });

  it("tightens examination field by field", () => {
    const stricter: ExaminationPolicy = {
      ...OFF,
      low: {
        required: true,
        mustDifferModel: true,
        mustDifferProvider: false,
        blockOnMaterialFindings: false,
      },
      medium: { ...OFF.medium, blockOnMaterialFindings: true },
    };
    const result = requireEffectivePolicy(org, { examinationPolicy: stricter });
    expect(result.examinationPolicy.low.required).toBe(true);
    expect(result.examinationPolicy.medium).toEqual({
      ...DEFAULT_EXAMINATION_POLICY.medium,
      blockOnMaterialFindings: true,
    });
    expect(result.examinationPolicy.high).toEqual(DEFAULT_EXAMINATION_POLICY.high);
  });

  it("keeps only the ladders named, and moves a rule off a dropped ladder", () => {
    const result = requireEffectivePolicy(org, {
      examinationPolicy: OFF,
      routing: { ladders: ["codex"] },
    });
    expect(Object.keys(result.routingPolicy.ladders)).toEqual(["codex"]);
    expect(result.routingPolicy.rules.every((rule) => rule.start.ladder === "codex")).toBe(true);
  });

  it("drops forbidden routes, and a rung or ladder left empty", () => {
    const result = requireEffectivePolicy(org, {
      examinationPolicy: OFF,
      routing: { forbid: [{ harness: "claude", model: "claude-haiku-4-5-20251001" }] },
    });
    expect(result.routingPolicy.ladders.claude?.map((rung) => rung.tier)).toEqual([
      "standard",
      "frontier",
    ]);
  });

  it("raises every rule's start to the minimum tier, and never lowers one", () => {
    const result = requireEffectivePolicy(org, {
      examinationPolicy: OFF,
      routing: { minimumTier: "standard" },
    });
    const tiers = Object.fromEntries(
      result.routingPolicy.rules.map((rule) => [rule.id, rule.start.tier]),
    );
    expect(tiers).toEqual({
      "R-orchestrate": "frontier",
      "R-high": "frontier",
      "R-bounded": "standard",
      "R-default": "standard",
    });
  });

  it("refuses a ladder the org does not have, by name", () => {
    const result = effectivePolicy(org, {
      examinationPolicy: OFF,
      routing: { ladders: ["claude", "bedrock"] },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.widenings.map((w) => w.detail).join()).toContain('"bedrock"');
  });

  it("refuses a narrowing that leaves no route", () => {
    const forbidAll = Object.values(DEFAULT_ROUTING_POLICY.ladders).flatMap((ladder) =>
      ladder.flatMap((rung) => rung.routes.map(({ harness, model }) => ({ harness, model }))),
    );
    const result = effectivePolicy(org, { examinationPolicy: OFF, routing: { forbid: forbidAll } });
    expect(result.ok).toBe(false);
    expect(() =>
      requireEffectivePolicy(org, { examinationPolicy: OFF, routing: { forbid: forbidAll } }),
    ).toThrow(PolicyWideningError);
  });
});

describe("examinationRequirementFor", () => {
  it("reads the level the job's risk names", () => {
    expect(
      examinationRequirementFor(DEFAULT_EXAMINATION_POLICY, "high").blockOnMaterialFindings,
    ).toBe(true);
    expect(examinationRequirementFor(DEFAULT_EXAMINATION_POLICY, "low").required).toBe(false);
  });
});
