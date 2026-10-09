import { describe, expect, it } from "vitest";
import { createFixtures, makeProgramContract } from "../testing/index.js";
import { splitPlanSections } from "./plan.js";

import { StrandBriefError, strandBrief } from "./strand-brief.js";

const PLAN = [
  "# Demo",
  "",
  "### S-01 The API",
  "",
  "A route exists.",
  "",
  "#### Considered and rejected",
  "",
  "A socket: P10 depends on there being none.",
  "",
  "### S-02 The CLI",
  "",
  "A command exists.",
  "",
].join("\n");

const strand = (id: string, includes: string[], excludes: string[] = []) => ({
  id,
  name: id === "S-01" ? "The API" : "The CLI",
  scope: { summary: `${id}'s corner`, includes, excludes },
  acceptance: [`${id} is green`],
  successCriteria: [],
  dependsOn: [],
  prerequisites: [],
});

const contract = makeProgramContract(createFixtures(), {
  status: "planning",
  strands: [strand("S-01", ["src/api/**"], ["src/api/legacy/**"]), strand("S-02", ["src/cli/**"])],
  decisions: [
    {
      id: "D-01",
      question: "REST or RPC?",
      options: ["REST", "RPC"],
      answer: "REST",
      rationale: "It is what the clients speak.",
      touches: ["S-01"],
    },
    { id: "D-02", question: "Which logger?", options: ["a", "b"], answer: "a", touches: "all" },
    { id: "D-03", question: "Colours?", options: ["y", "n"], answer: "n", touches: ["S-02"] },
    { id: "D-04", question: "Unanswered?", options: ["y", "n"], touches: "all" },
  ],
});
const sections = splitPlanSections(PLAN);

describe("strandBrief (SC-P7-10)", () => {
  it("opens with the strand's plan section, verbatim", () => {
    const brief = strandBrief(contract, sections, "S-01");
    const section = sections["S-01"] as string;
    expect(brief.objective.startsWith(`${section}\n\n`)).toBe(true);
    expect(section).toContain("A socket: P10 depends on there being none.");
    expect(brief.objective).not.toContain("A command exists.");
  });

  it("hands over the answered decisions that touch it, and no others (SC-P7-09)", () => {
    const { objective } = strandBrief(contract, sections, "S-01");
    expect(objective).toContain(
      "D-01: REST or RPC?\n    Answer: REST\n    Why: It is what the clients speak.",
    );
    expect(objective).toContain("D-02: Which logger?");
    expect(objective).not.toContain("D-03");
    expect(objective).not.toContain("D-04");
  });

  it("names where the plan expects the other strands' work, never its own", () => {
    const { objective } = strandBrief(contract, sections, "S-02");
    expect(objective).toContain("S-01 The API: S-01's corner");
    expect(objective).toContain("the plan expects its work mostly in: src/api/**");
    expect(objective).toContain("and not in: src/api/legacy/**");
    expect(objective).not.toContain("S-02 The CLI: S-02's corner");
  });

  // The owner's ruling, 2026-10-09: a strand's planned paths are guidance, and
  // nothing in its brief tells it what it may not change.
  it("carries no path scope and never limits what the strand may change", () => {
    const brief = strandBrief(contract, sections, "S-01");
    expect(Object.keys(brief).sort()).toEqual(["acceptance", "objective"]);
    expect(brief.acceptance).toEqual(["S-01 is green"]);
    expect(brief.objective).toContain("guidance, not a limit");
    expect(brief.objective).not.toMatch(
      /not yours to change|may change|may not change|outside your scope/i,
    );
  });

  it("refuses a strand the plan does not have, or has no section for", () => {
    expect(() => strandBrief(contract, sections, "S-09")).toThrow(StrandBriefError);
    expect(() => strandBrief(contract, {}, "S-01")).toThrow(/no section/);
  });
});
