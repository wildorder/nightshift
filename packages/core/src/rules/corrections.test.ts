import { AGGREGATE_EXAMPLES, type Decision, DecisionSchema } from "@nightshift/contracts";
import { describe, expect, it } from "vitest";
import {
  explainCorrection,
  explainDecisionStamp,
  irreversibleConfirmationContext,
  isDecisionStamp,
  unconfirmedCorrections,
} from "./corrections.js";

const decision = (patch: Partial<Decision> = {}): Decision =>
  DecisionSchema.parse({
    ...(structuredClone(AGGREGATE_EXAMPLES.Decision) as Record<string, unknown>),
    ...patch,
  }) as Decision;

const SHA = "0123456789abcdef0123456789abcdef01234567";
const target = {
  programId: "prog_01HF7YAT09GGGGGGGGGGGGGGGG" as never,
  runId: "run_01HF7YAT09GGGGGGGGGGGGGGGG" as never,
  decisionId: "dec_01HF7YAT09AAAAAAAAAAAAAAAA" as never,
  reversedBy: "dec_01HF7YAT09BBBBBBBBBBBBBBBB" as never,
};

describe("stamping a recorded decision (D-P9-01)", () => {
  it("accepts checkpointAfter and produced, set where they were absent, together or apart", () => {
    const recorded = decision();
    const { checkpointAfter: _none, ...bare } = recorded;
    const base = bare as Decision;
    const stamped = {
      ...base,
      checkpointAfter: base.checkpointBefore,
      produced: { commits: [SHA] },
    };
    expect(isDecisionStamp(base, stamped)).toBe(true);
    expect(isDecisionStamp(base, { ...base, produced: { commits: [] } })).toBe(true);
  });

  it("refuses a second stamp, any other change, and calls an identical record no stamp", () => {
    const stamped = decision({ produced: { commits: [SHA] } });
    expect(explainDecisionStamp(stamped, { ...stamped, produced: { commits: [] } })).toContain(
      "produced is set once, and it is already set",
    );
    expect(explainDecisionStamp(stamped, { ...stamped, rationale: "changed" })).toContain(
      "a recorded decision changes only by gaining checkpointAfter and produced",
    );
    expect(isDecisionStamp(stamped, stamped)).toBe(false);
  });
});

describe("what a correction may name (D-P9-04)", () => {
  const original = decision({ decisionId: target.decisionId, authority: "agent" });
  const reversal = decision({
    decisionId: target.reversedBy,
    authority: "human",
    supersedesDecisionId: target.decisionId,
  });

  it("accepts a decision a human reversed", () => {
    expect(explainCorrection({ target, decision: original, reversal })).toEqual([]);
  });

  it("refuses a decision that is not there, a reversal that is not human, or one that supersedes something else", () => {
    expect(explainCorrection({ target, reversal })[0]).toMatch(/is not a decision of run/);
    expect(explainCorrection({ target, decision: original })[0]).toMatch(
      /is not a decision of run/,
    );
    expect(
      explainCorrection({
        target,
        decision: original,
        reversal: { ...reversal, authority: "agent" },
      }),
    ).toEqual([`${target.reversedBy} is not a human decision: only the owner reverses`]);
    expect(
      explainCorrection({
        target,
        decision: original,
        reversal: { ...reversal, supersedesDecisionId: null },
      }),
    ).toEqual([`${target.reversedBy} does not supersede ${target.decisionId}`]);
  });
});

describe("confirming a correction of an effect outside the repository (D-P9-05)", () => {
  it("waits on the owner for irreversible and compensatable decisions, until a human confirms each", () => {
    const irreversible = decision({ decisionId: target.decisionId, reversibility: "irreversible" });
    const compensatable = decision({
      decisionId: target.reversedBy,
      reversibility: "compensatable",
    });
    const reversible = decision({ reversibility: "reversible" });
    expect(
      unconfirmedCorrections([irreversible, compensatable, reversible], []).map(
        (candidate) => candidate.decisionId,
      ),
    ).toEqual([target.decisionId, target.reversedBy]);

    const confirmation = decision({
      authority: "human",
      context: irreversibleConfirmationContext(target.decisionId),
    });
    expect(
      unconfirmedCorrections([irreversible, compensatable], [confirmation]).map(
        (candidate) => candidate.decisionId,
      ),
    ).toEqual([target.reversedBy]);
    // An agent cannot confirm it.
    expect(
      unconfirmedCorrections([irreversible], [{ ...confirmation, authority: "agent" }]),
    ).toHaveLength(1);
  });
});
