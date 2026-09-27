import { AGGREGATE_EXAMPLES, type Examination, ExaminationSchema } from "@nightshift/contracts";
import { describe, expect, it } from "vitest";
import {
  type AgentRoute,
  examinationBlocks,
  explainExaminationUpdate,
  FINDING_RESOLUTION_MOVES,
  mayArbitrate,
  mayExamine,
} from "./examination.js";

const claudeSonnet: AgentRoute = {
  agentId: "agent_a",
  provider: "anthropic",
  model: "claude-sonnet-5",
};
const claudeOpus: AgentRoute = {
  agentId: "agent_b",
  provider: "anthropic",
  model: "claude-opus-5-5",
};
const codexAstra: AgentRoute = { agentId: "agent_c", provider: "openai", model: "gpt-6-astra" };
const codexSol: AgentRoute = { agentId: "agent_d", provider: "openai", model: "gpt-6-sol" };

const NONE = { mustDifferModel: false, mustDifferProvider: false };
const MODEL = { mustDifferModel: true, mustDifferProvider: false };
const PROVIDER = { mustDifferModel: true, mustDifferProvider: true };

describe("mayExamine (SC-P8-10)", () => {
  it("always refuses self-examination", () => {
    for (const requirement of [NONE, MODEL, PROVIDER]) {
      expect(mayExamine(requirement, claudeSonnet, claudeSonnet).map((p) => p.reason)).toContain(
        "same_agent",
      );
    }
  });

  it("refuses a shared model only when the policy requires a difference", () => {
    const sameModel = { ...claudeSonnet, agentId: "agent_x" };
    expect(mayExamine(NONE, claudeSonnet, sameModel)).toEqual([]);
    expect(mayExamine(MODEL, claudeSonnet, sameModel).map((p) => p.reason)).toEqual(["same_model"]);
  });

  it("refuses a shared provider only when the policy requires one", () => {
    expect(mayExamine(MODEL, claudeSonnet, claudeOpus)).toEqual([]);
    expect(mayExamine(PROVIDER, claudeSonnet, claudeOpus).map((p) => p.reason)).toEqual([
      "same_provider",
    ]);
    expect(mayExamine(PROVIDER, claudeSonnet, codexAstra)).toEqual([]);
  });
});

describe("mayArbitrate (D-P8-13)", () => {
  it("accepts a model neither side used, even on a side's provider", () => {
    expect(mayArbitrate(claudeSonnet, codexAstra, claudeOpus)).toEqual([]);
    expect(mayArbitrate(claudeSonnet, codexAstra, codexSol)).toEqual([]);
  });

  it("accepts a fresh invocation of a side's model, and refuses being either side (as amended 2026-09-26)", () => {
    expect(mayArbitrate(claudeSonnet, codexAstra, { ...codexAstra, agentId: "agent_z" })).toEqual(
      [],
    );
    expect(mayArbitrate(claudeSonnet, codexAstra, claudeSonnet).map((p) => p.reason)).toEqual([
      "same_agent",
    ]);
    expect(mayArbitrate(claudeSonnet, codexAstra, codexAstra).map((p) => p.reason)).toEqual([
      "same_agent",
    ]);
  });
});

const example = (): Examination =>
  ExaminationSchema.parse(structuredClone(AGGREGATE_EXAMPLES.Examination));

const withFinding = (
  examination: Examination,
  patch: Partial<Examination["findings"][number]>,
): Examination => ({
  ...examination,
  findings: examination.findings.map((finding, index) =>
    index === 0 ? { ...finding, ...patch } : finding,
  ),
});

const AT = "2026-09-25T10:00:00.000Z";

describe("explainExaminationUpdate (D-P8-13)", () => {
  it("accepts an identical write", () => {
    expect(explainExaminationUpdate(example(), example())).toEqual([]);
  });

  it("holds the verdict and its evidence immutable", () => {
    const before = example();
    expect(
      explainExaminationUpdate(before, { ...before, outcome: "passed", findings: [] }),
    ).toContain("outcome is immutable once an examination is recorded");
    expect(
      explainExaminationUpdate(before, withFinding(before, { summary: "softened" })).join(),
    ).toContain("may change only its resolution");
  });

  it("moves a resolution forward, and says who moved it", () => {
    const before = example();
    const disputed = withFinding(before, {
      resolution: "disputed",
      resolvedBy: { authority: "agent", reason: "deliberate", at: AT },
    });
    expect(explainExaminationUpdate(before, disputed)).toEqual([]);
    const ruled = withFinding(disputed, {
      resolution: "overturned",
      resolvedBy: {
        authority: "agent",
        decisionId: "dec_01HF7YAT00GGGGGGGGGGGGGGGG" as never,
        at: AT,
      },
    });
    expect(explainExaminationUpdate(disputed, ruled)).toEqual([]);
    expect(explainExaminationUpdate(ruled, disputed).join()).toContain(
      "may not move from overturned",
    );
  });

  it("refuses a ruling without its decision, and an agent accepting risk", () => {
    const before = withFinding(example(), {
      resolution: "disputed",
      resolvedBy: { authority: "agent", at: AT },
    });
    expect(
      explainExaminationUpdate(
        before,
        withFinding(before, { resolution: "upheld", resolvedBy: { authority: "agent", at: AT } }),
      ).join(),
    ).toContain("must name its decision");
    expect(
      explainExaminationUpdate(
        before,
        withFinding(before, {
          resolution: "risk_accepted",
          resolvedBy: { authority: "agent", at: AT },
        }),
      ).join(),
    ).toContain("only a human");
  });

  it("lets every ending stay an ending", () => {
    for (const ending of ["fixed", "overturned", "upheld", "risk_accepted"] as const) {
      expect(FINDING_RESOLUTION_MOVES[ending]).toEqual([]);
    }
  });
});

describe("examinationBlocks", () => {
  it("blocks only on a blocking policy with a material finding still standing", () => {
    const material = withFinding(example(), { severity: "material" });
    expect(examinationBlocks({ ...material, blocking: true })).toBe(true);
    expect(examinationBlocks({ ...material, blocking: false })).toBe(false);
    expect(examinationBlocks({ ...example(), blocking: true })).toBe(false);
    const overturned = withFinding(material, {
      resolution: "overturned",
      resolvedBy: { authority: "agent", decisionId: "dec_x" as never, at: AT },
    });
    expect(examinationBlocks({ ...overturned, blocking: true })).toBe(false);
  });

  it("on a check of an arbiter's ruling, blocks only on a finding that the ruling is not carried out", () => {
    const ruling = {
      findingId: "F-01",
      decisionId: "dec_x" as never,
      summary: "divide does not throw on zero",
      rationale: "it must throw RangeError",
    };
    const material = { ...withFinding(example(), { severity: "material" }), blocking: true };
    const check = { ...material, followsRulings: [ruling] };
    // Something the ruling was not about: recorded, and it does not stop the work.
    expect(examinationBlocks(check)).toBe(false);
    // The ruling not carried out does.
    expect(examinationBlocks(withFinding(check, { concerns: "F-01" }))).toBe(true);
    expect(examinationBlocks(withFinding(check, { concerns: "F-09" }))).toBe(false);
  });

  it("keeps the rulings an examination checked, once recorded", () => {
    const ruling = {
      findingId: "F-01",
      decisionId: "dec_x" as never,
      summary: "s",
      rationale: "r",
    };
    const recorded = { ...example(), followsRulings: [ruling] };
    const { followsRulings: _dropped, ...without } = recorded;
    expect(explainExaminationUpdate(recorded, without)).toContain(
      "followsRulings is immutable once an examination is recorded",
    );
  });
});
