import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { JobContract } from "@nightshift/contracts";
import {
  createFixtures,
  makeJobContract,
  makeProgramContract,
  makeRootNode,
} from "@nightshift/core";
import { describe, expect, it } from "vitest";
import { renderWorkerBrief } from "./brief.js";
import { GATE_STANDARD } from "./gate-standard.js";
import type { ExaminationEvidence } from "./harness.js";

/** The standard as Nightshift ships it, beside the planning skill (D-P15-05). */
const SHIPPED = fileURLToPath(
  new URL("../../../skills/plan-program/gate-standard.md", import.meta.url),
);

const EVIDENCE: ExaminationEvidence = {
  diff: "diff --git a/test/a.test.js b/test/a.test.js",
  diffTruncated: false,
  changedTests: ["test/a.test.js"],
  verification: [{ stepId: "test", command: "npm test", exitCode: 0 }],
  risk: "high",
  blocking: true,
  fixAttempt: 0,
};

const examinerBriefFor = (job: (f: ReturnType<typeof createFixtures>) => JobContract) => {
  const f = createFixtures();
  return renderWorkerBrief({
    job: job(f),
    node: makeRootNode(f, { kind: "job", parentNodeId: f.ids.next("node"), depth: 1 }),
    program: makeProgramContract(f),
    worktree: "/tmp/exam",
    task: { kind: "examine", evidence: EVIDENCE, round: 1 },
  });
};

describe("the gate standard (D-P15-05)", () => {
  it("is embedded exactly as skills/plan-program/gate-standard.md ships it", () => {
    expect(GATE_STANDARD).toBe(readFileSync(SHIPPED, "utf8").replace(/\r\n/g, "\n"));
  });
});

describe("the examiner's brief for a repair (D-P15-04, SC-P15-08)", () => {
  it("carries the gate standard and the weakened-gate rule, and points at the decision", () => {
    const brief = examinerBriefFor((f) =>
      makeJobContract(f, {
        objective:
          "Make the test gate pass.\n\nTHE DECISION RECORDED WITH THIS REPAIR\nChoice: commit the fixture.",
        risk: "high",
        repair: { cause: "flaky", gates: ["test"], decisionId: f.ids.next("dec") },
      }),
    );
    expect(brief).toContain("THIS IS A REPAIR");
    expect(brief).toContain("a flaky gate: test");
    expect(brief).toContain("A weakened gate (a");
    expect(brief).toContain("is a blocking finding unless the repair's");
    expect(brief).toContain("decision says why");
    // The decision's text, from the objective Nightshift wrote.
    expect(brief).toContain("Choice: commit the fixture.");
    // The standard itself, rule by rule.
    expect(brief).toContain("# Nightshift's gate standard");
    expect(brief).toContain("## 5. Is deterministic");
    expect(brief).toContain("## 7. Costs what it should");
  });

  it("is not given to an ordinary job's examiner", () => {
    const brief = examinerBriefFor((f) => makeJobContract(f, { objective: "Add a helper." }));
    expect(brief).toContain("You are a Nightshift examiner.");
    expect(brief).not.toContain("THIS IS A REPAIR");
    expect(brief).not.toContain("Nightshift's gate standard");
    expect(brief).not.toContain("weakened gate");
  });
});

describe("the planned root's brief (P15)", () => {
  it("says to repair a red base first, repair a flake off the blocking path, and not finish mid-repair", () => {
    const f = createFixtures();
    const program = makeProgramContract(f, {
      status: "planning",
      strands: [
        {
          id: "S-01",
          name: "The one strand",
          scope: { summary: "S-01", includes: ["src/**"], excludes: [] },
          acceptance: ["green"],
          successCriteria: [],
          dependsOn: [],
          prerequisites: [],
        },
      ],
    });
    const brief = renderWorkerBrief({
      job: makeJobContract(f, { objective: "# Plan\n\n### S-01\n" }),
      node: makeRootNode(f),
      program,
      worktree: "/tmp/root",
    });
    expect(brief).toContain("WHEN A GATE BREAKS");
    expect(brief).toContain("If the run started red");
    expect(brief).toContain(
      "is a repair { cause: red_base } naming the failing gates, before anything else",
    );
    expect(brief).toContain("Open one repair { cause: flaky } per flaky gate");
    expect(brief).toContain("off the blocking path");
    expect(brief).toContain("Do not run.finish while a repair is still in flight.");
    expect(brief).toContain("repair_needs_decision");
  });
});
