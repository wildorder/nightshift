import type { Decision, ProgramContract, Strand } from "@nightshift/contracts";
import { describe, expect, it } from "vitest";
import { createFixtures, makeProgramContract } from "../testing/index.js";
import type { DecisionReport } from "./decision-graph.js";
import type { JobReport, StrandReport } from "./report.js";
import { type StoryRecords, storiesOf, storyStatuses } from "./stories.js";

const fixtures = createFixtures();

const strand = (id: string, criteria: string[]): Strand => ({
  id,
  name: `Strand ${id}`,
  scope: { summary: "s", includes: [`src/${id}/**`], excludes: [] },
  acceptance: ["ok"],
  successCriteria: criteria,
  dependsOn: [],
  prerequisites: [],
});

const program: ProgramContract = makeProgramContract(fixtures, {
  stories: [
    { id: "US-01", who: "An admin", problem: "Leaks.", outcome: "No leaks." },
    { id: "US-02", who: "A customer", problem: "Breaks.", outcome: "Nothing breaks." },
    { id: "US-03", who: "Support", problem: "Blind.", outcome: "They can see." },
  ],
  successCriteria: [
    { id: "SC-01", outcome: "isolated", serves: ["US-01"] },
    { id: "SC-02", outcome: "compatible", serves: ["US-02"] },
    { id: "SC-03", outcome: "visible", serves: ["US-01", "US-03"] },
  ],
  strands: [strand("S-01", ["SC-01"]), strand("S-02", ["SC-02"]), strand("S-03", ["SC-03"])],
  decisions: [
    { id: "D-01", question: "Q?", options: ["a"], answer: "a", touches: ["S-02"] },
    { id: "D-02", question: "R?", options: ["b"], answer: "b", touches: "all" },
  ],
});

const job = (nodeId: string, commitSha: string | null): JobReport =>
  ({ nodeId, commitSha }) as unknown as JobReport;

const strandReport = (id: string, nodeIds: string[], jobs: JobReport[]): StrandReport =>
  ({ id, nodeIds, jobs }) as unknown as StrandReport;

const decision = (overrides: Record<string, unknown>): Decision =>
  ({
    decisionId: "dec_x",
    executionNodeId: "node_root",
    authority: "agent",
    context: "Something.",
    ...overrides,
  }) as Decision;

const produced: DecisionReport = {
  decision: decision({ executionNodeId: "node_s1", produced: { commits: ["c-dec"] } }),
  place: "strand",
  where: "S-01",
  correctedBy: [],
};

const records: StoryRecords = {
  program,
  strands: [
    strandReport("S-01", ["node_s1", "node_j1"], [job("node_j1", "c-1")]),
    strandReport("S-02", ["node_s2", "node_j2"], [job("node_j2", "c-2")]),
    strandReport("S-03", ["node_s3"], []),
  ],
  graph: [produced],
};

const ids = (target: Parameters<typeof storiesOf>[1]): string[] =>
  storiesOf(records, target).map((story) => story.id);

describe("storiesOf (SC-P14-04)", () => {
  it("traces a strand and a criterion to the stories their criteria serve", () => {
    expect(ids({ strandId: "S-03" })).toEqual(["US-01", "US-03"]);
    expect(ids({ criterionId: "SC-02" })).toEqual(["US-02"]);
  });

  it("traces a job, and a strand's own node, through the strand", () => {
    expect(ids({ nodeId: "node_j2" })).toEqual(["US-02"]);
    expect(ids({ nodeId: "node_s1" })).toEqual(["US-01"]);
  });

  it("traces a node outside every strand, the program's, to every story", () => {
    expect(ids({ nodeId: "node_root" })).toEqual(["US-01", "US-02", "US-03"]);
  });

  it("traces a planned decision by the strands it touches, and `all` to every story", () => {
    expect(ids({ plannedDecisionId: "D-01" })).toEqual(["US-02"]);
    expect(ids({ plannedDecisionId: "D-02" })).toEqual(["US-01", "US-02", "US-03"]);
    expect(ids({ plannedDecisionId: "D-09" })).toEqual([]);
  });

  it("traces a recorded decision: a planned answer by its touches, else by its node", () => {
    const answer = decision({
      authority: "human",
      context: "D-01: Q?",
      executionNodeId: "node_root",
    });
    expect(ids({ decision: answer })).toEqual(["US-02"]);
    expect(ids({ decision: decision({ executionNodeId: "node_j1" }) })).toEqual(["US-01"]);
  });

  it("traces a commit by the job that landed it or the decision that produced it", () => {
    expect(ids({ commit: "c-2" })).toEqual(["US-02"]);
    expect(ids({ commit: "c-dec" })).toEqual(["US-01"]);
    expect(ids({ commit: "c-unknown" })).toEqual([]);
  });
});

describe("storyStatuses", () => {
  it("gives each story its criteria, met or not, and the strands that claim them", () => {
    const statuses = storyStatuses({
      program,
      criteria: [
        { id: "SC-01", outcome: "isolated", met: true, by: ["S-01"] },
        { id: "SC-02", outcome: "compatible", met: false, by: [] },
        { id: "SC-03", outcome: "visible", met: true, by: ["S-03"] },
      ],
    });
    expect(
      statuses.map(({ story, met, strands, criteria }) => [
        story.id,
        met,
        strands,
        criteria.map((c) => c.id),
      ]),
    ).toEqual([
      ["US-01", true, ["S-01", "S-03"], ["SC-01", "SC-03"]],
      ["US-02", false, ["S-02"], ["SC-02"]],
      ["US-03", true, ["S-03"], ["SC-03"]],
    ]);
  });
});
