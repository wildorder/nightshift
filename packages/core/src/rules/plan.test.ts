import type { ProgramContract, Strand } from "@nightshift/contracts";
import { describe, expect, it } from "vitest";
import { createFixtures, makeProgramContract } from "../testing/index.js";
import { emptyConversation, keepMessages } from "./conversation.js";
import {
  blockedBy,
  checkPlan,
  downstreamCone,
  findDependencyCycle,
  globsMayOverlap,
  independentOverlaps,
  isPlanned,
  mayRunContract,
  mayStartStrand,
  type PlanReason,
  planHash,
  samePlanContent,
  scopesOverlap,
  splitPlanSections,
  strandOutcomes,
} from "./plan.js";

const strand = (id: string, includes: string[], overrides: Partial<Strand> = {}): Strand => ({
  id,
  name: `Strand ${id}`,
  scope: { summary: "somewhere", includes, excludes: [] },
  acceptance: ["its tests pass"],
  successCriteria: [],
  dependsOn: [],
  prerequisites: [],
  ...overrides,
});

const PLAN = [
  "# Fixture program",
  "",
  "## Strands",
  "",
  "### S-01 The API",
  "",
  "A route exists.",
  "",
  "#### Considered and rejected",
  "",
  "A socket.",
  "",
  "### S-02 The CLI",
  "",
  "A command exists.",
  "",
  "## Decisions",
  "",
  "None.",
].join("\n");

// One world, so two contracts built here differ only in what a test changes.
const fixtures = createFixtures();

const planned = (overrides: Partial<ProgramContract> = {}): ProgramContract =>
  makeProgramContract(fixtures, {
    status: "planning",
    strands: [
      strand("S-01", ["src/api/**"], { successCriteria: ["SC-01"], prerequisites: ["HP-01"] }),
      strand("S-02", ["src/cli/**"], { dependsOn: ["S-01"] }),
    ],
    prerequisites: [
      {
        id: "HP-01",
        description: "An API key exists.",
        remediation: "Create one in the console.",
        verifyCommand: 'test -n "$KEY"',
        status: "pending",
      },
    ],
    decisions: [
      { id: "D-01", question: "Which?", options: ["a", "b"], answer: "a", touches: "all" },
    ],
    ...overrides,
  });

const kinds = (contract: ProgramContract, plan = PLAN): PlanReason["kind"][] => {
  const result = checkPlan(contract, splitPlanSections(plan));
  return result.ready ? [] : result.reasons.map((reason) => reason.kind);
};

describe("globsMayOverlap", () => {
  it.each([
    ["src/**", "src/api/**", true],
    ["src/api/**", "src/cli/**", false],
    ["src/*.ts", "src/*.md", false],
    ["src/a*.ts", "src/*b.ts", true],
    ["**/index.ts", "src/api/index.ts", true],
    ["**/index.ts", "src/api/main.ts", false],
    ["src/*", "src/api/deep.ts", false],
    ["src/**", "src", true],
    ["docs/**", "src/**", false],
    ["**", "anything/at/all", true],
  ])("%s against %s is %s, both ways", (a, b, expected) => {
    expect(globsMayOverlap(a, b)).toBe(expected);
    expect(globsMayOverlap(b, a)).toBe(expected);
  });
});

describe("scopesOverlap", () => {
  it("is cleared by an exclude that covers the other scope's include", () => {
    const wide = { summary: "w", includes: ["src/**"], excludes: [] as string[] };
    const narrow = { summary: "n", includes: ["src/api/**"], excludes: [] as string[] };
    expect(scopesOverlap(wide, narrow)).toBe(true);
    expect(scopesOverlap({ ...wide, excludes: ["src/api/**"] }, narrow)).toBe(false);
  });

  it("is not cleared by an exclude that covers only part of the intersection", () => {
    const a = { summary: "a", includes: ["src/**"], excludes: ["src/api/v1/**"] };
    const b = { summary: "b", includes: ["src/api/**"], excludes: [] };
    expect(scopesOverlap(a, b)).toBe(true);
  });
});

describe("independentOverlaps", () => {
  const a = strand("S-01", ["src/**"]);
  const b = strand("S-02", ["src/api/**"]);
  const c = strand("S-03", ["docs/**"]);

  it("flags two overlapping strands with no dependency path", () => {
    const found = independentOverlaps([a, b, c]);
    expect(found).toHaveLength(1);
    expect(found[0]?.intersections).toEqual([{ a: "src/**", b: "src/api/**" }]);
  });

  it("is cleared by a dependency in either direction, however long the path", () => {
    expect(independentOverlaps([a, { ...b, dependsOn: ["S-01"] }])).toEqual([]);
    expect(independentOverlaps([{ ...a, dependsOn: ["S-02"] }, b])).toEqual([]);
    expect(
      independentOverlaps([a, { ...c, dependsOn: ["S-01"] }, { ...b, dependsOn: ["S-03"] }]),
    ).toEqual([]);
  });
});

describe("checkPlan (SC-P7-03)", () => {
  it("answers READY for a whole plan", () => {
    expect(checkPlan(planned(), splitPlanSections(PLAN))).toEqual({ ready: true });
  });

  it("refuses a contract with no strands", () => {
    expect(kinds(planned({ strands: [], prerequisites: [], decisions: [] }))).toEqual([
      "no_strands",
      "unclaimed_criterion",
    ]);
  });

  it("refuses an unclaimed success criterion", () => {
    const contract = planned({
      successCriteria: [
        { id: "SC-01", outcome: "one", serves: ["US-01"] },
        { id: "SC-02", outcome: "two", serves: ["US-01"] },
      ],
    });
    expect(kinds(contract)).toEqual(["unclaimed_criterion"]);
  });

  it("refuses a strand scope outside the program's", () => {
    const base = planned();
    const strands = [...(base.strands ?? [])];
    strands[1] = strand("S-02", ["infra/**"], { dependsOn: ["S-01"] });
    expect(kinds(planned({ strands }))).toEqual(["scope_outside_program"]);
  });

  it("refuses a cycle", () => {
    const strands = [
      strand("S-01", ["src/api/**"], {
        successCriteria: ["SC-01"],
        prerequisites: ["HP-01"],
        dependsOn: ["S-02"],
      }),
      strand("S-02", ["src/cli/**"], { dependsOn: ["S-01"] }),
    ];
    expect(kinds(planned({ strands }))).toEqual(["dependency_cycle"]);
    expect(findDependencyCycle(strands)).toEqual(["S-01", "S-02", "S-01"]);
  });

  it("refuses an unknown dependsOn", () => {
    const base = planned();
    const strands = [...(base.strands ?? [])];
    strands[1] = strand("S-02", ["src/cli/**"], { dependsOn: ["S-09"] });
    expect(kinds(planned({ strands }))).toEqual(["unknown_dependency"]);
  });

  it("refuses a strand with no section, or a heading with nothing under it", () => {
    expect(kinds(planned(), PLAN.replace("### S-02 The CLI", "### The CLI"))).toEqual([
      "missing_section",
    ]);
    expect(kinds(planned(), PLAN.replace("A command exists.", ""))).toEqual(["missing_section"]);
  });

  it("refuses a prerequisite with no remediation, no verifyCommand, or no strand", () => {
    const contract = planned({
      prerequisites: [
        { id: "HP-01", description: "d", remediation: " ", verifyCommand: "", status: "pending" },
        { id: "HP-02", description: "d", remediation: "r", verifyCommand: "v", status: "pending" },
      ],
    });
    expect(kinds(contract)).toEqual([
      "prerequisite_without_remediation",
      "prerequisite_without_verify_command",
      "unused_prerequisite",
    ]);
  });

  it("refuses an unanswered decision", () => {
    const contract = planned({
      decisions: [{ id: "D-01", question: "Which?", options: ["a", "b"], touches: ["S-01"] }],
    });
    expect(kinds(contract)).toEqual(["unanswered_decision"]);
  });

  it("refuses two independent strands with overlapping scopes, showing both scopes", () => {
    const base = planned();
    const strands = [...(base.strands ?? []), strand("S-03", ["src/api/routes/**"])];
    const result = checkPlan(planned({ strands }), splitPlanSections(`${PLAN}\n### S-03 X\n\ny\n`));
    expect(result.ready).toBe(false);
    if (result.ready) return;
    expect(result.reasons.map((reason) => reason.kind)).toEqual(["scope_overlap"]);
    const message = result.reasons[0]?.message ?? "";
    expect(message).toContain('"src/api/**" (S-01) intersects "src/api/routes/**" (S-03)');
    expect(message).toContain("includes: src/api/**");
  });

  it("reports every reason at once", () => {
    const contract = planned({
      strands: [strand("S-01", ["infra/**"], { dependsOn: ["S-07"] })],
      prerequisites: [],
      decisions: [{ id: "D-01", question: "Which?", options: [], touches: ["S-04"] }],
    });
    expect(kinds(contract, "# empty")).toEqual([
      "unclaimed_criterion",
      "scope_outside_program",
      "unknown_dependency",
      "missing_section",
      "unanswered_decision",
      "unknown_decision_strand",
    ]);
  });
});

describe("splitPlanSections", () => {
  it("takes a strand's section to the next heading of its level or above, verbatim", () => {
    const sections = splitPlanSections(PLAN.replace(/\n/g, "\r\n"));
    expect(Object.keys(sections)).toEqual(["S-01", "S-02"]);
    expect(sections["S-01"]).toBe(
      "### S-01 The API\n\nA route exists.\n\n#### Considered and rejected\n\nA socket.",
    );
    expect(sections["S-02"]).toBe("### S-02 The CLI\n\nA command exists.");
  });

  it("does not read a heading inside a code fence", () => {
    const sections = splitPlanSections("## S-01 A\n\n```md\n## S-02 not a strand\n```\n\ntext\n");
    expect(Object.keys(sections)).toEqual(["S-01"]);
    expect(sections["S-01"]).toContain("text");
  });
});

describe("strand gating and the cone", () => {
  // S-01 ← S-02 ← S-04, S-01 ← S-03, S-05 alone.
  const contract = planned({
    strands: [
      strand("S-01", ["src/a/**"], { successCriteria: ["SC-01"], prerequisites: ["HP-01"] }),
      strand("S-02", ["src/b/**"], { dependsOn: ["S-01"] }),
      strand("S-03", ["src/c/**"], { dependsOn: ["S-01"] }),
      strand("S-04", ["src/d/**"], { dependsOn: ["S-02"] }),
      strand("S-05", ["src/e/**"]),
    ],
  });

  it("holds a strand until everything it depends on has succeeded", () => {
    expect(mayStartStrand(contract, {}, "S-01")).toEqual({ start: true });
    expect(mayStartStrand(contract, {}, "S-02")).toEqual({ start: false, waitingFor: ["S-01"] });
    expect(mayStartStrand(contract, { "S-01": "running" }, "S-02")).toEqual({
      start: false,
      waitingFor: ["S-01"],
    });
    expect(mayStartStrand(contract, { "S-01": "succeeded" }, "S-02")).toEqual({ start: true });
  });

  it("does not start a strand twice", () => {
    expect(mayStartStrand(contract, { "S-05": "running" }, "S-05")).toEqual({
      start: false,
      waitingFor: [],
    });
  });

  it("computes the downstream cone transitively", () => {
    expect(downstreamCone(contract, "S-01")).toEqual(["S-02", "S-03", "S-04"]);
    expect(downstreamCone(contract, "S-02")).toEqual(["S-04"]);
    expect(downstreamCone(contract, "S-05")).toEqual([]);
    expect(() => downstreamCone(contract, "S-99")).toThrow(RangeError);
  });

  it("counts a carried-over strand as succeeded, so what depends on it may start", () => {
    const outcomes = strandOutcomes(
      [{ strandId: "S-03", status: "running", createdAt: "2026-10-07T00:00:00.000Z" }],
      [{ strandId: "S-01" }],
    );
    expect(outcomes).toEqual({ "S-01": "succeeded", "S-03": "running" });
    expect(mayStartStrand(contract, outcomes, "S-02")).toEqual({ start: true });
    // An attempt in this run, which nothing should make, would stand instead.
    expect(
      strandOutcomes(
        [{ strandId: "S-01", status: "failed", createdAt: "2026-10-07T00:00:00.000Z" }],
        [{ strandId: "S-01" }],
      ),
    ).toEqual({ "S-01": "failed" });
  });

  it("names the strand that broke, not the first casualty", () => {
    const blocked = blockedBy(contract, {
      "S-01": "succeeded",
      "S-02": "failed",
      "S-04": "cancelled",
    });
    expect([...blocked]).toEqual([["S-04", ["S-02"]]]);
    expect([...blockedBy(contract, { "S-01": "failed" }).keys()]).toEqual(["S-02", "S-03", "S-04"]);
  });
});

describe("planHash", () => {
  // Not SHA-256: the rule only needs a deterministic function of its input.
  const fake = (text: string): string => `${text.length}:${text}`;

  it("is stable over key order and line endings", () => {
    const contract = planned();
    const reordered = Object.fromEntries(Object.entries(contract).reverse()) as ProgramContract;
    expect(planHash(reordered, "a\r\nb\r\n", fake)).toEqual(planHash(contract, "a\nb\n", fake));
  });

  it("does not move when the plan is ratified or a prerequisite is checked", () => {
    const contract = planned();
    const sha = "a".repeat(64);
    const ratified = planned({
      status: "ratified",
      planHash: sha,
      planDocument: { uri: "s3://b/k", sha256: sha, sizeBytes: 1 },
      prerequisites: (contract.prerequisites ?? []).map((prerequisite) => ({
        ...prerequisite,
        status: "satisfied" as const,
        lastCheck: { exitCode: 0, checkedAt: contract.createdAt },
      })),
    });
    expect(planHash(ratified, PLAN, fake)).toEqual(planHash(contract, PLAN, fake));
    expect(samePlanContent(ratified, contract)).toBe(true);
  });

  it("moves when the plan or anything approved in the contract changes", () => {
    const contract = planned();
    const before = planHash(contract, PLAN, fake);
    expect(planHash(contract, `${PLAN}\nmore`, fake).hash).not.toBe(before.hash);
    expect(planHash(contract, `${PLAN}\nmore`, fake).contract).toBe(before.contract);
    const edited = planned({ outOfScope: ["a UI"] });
    expect(planHash(edited, PLAN, fake).hash).not.toBe(before.hash);
    expect(samePlanContent(edited, contract)).toBe(false);
  });
});

describe("stories (P14, SC-P14-02)", () => {
  it("refuses a plan with no story, and says only that", () => {
    const contract = planned({
      stories: [],
      successCriteria: [{ id: "SC-01", outcome: "It works." }],
    });
    expect(kinds(contract)).toEqual(["no_stories"]);
  });

  it("reports every story reason at once", () => {
    const base = planned();
    const contract = planned({
      stories: [
        { id: "US-01", who: " ", problem: "It is broken.", outcome: "" },
        { id: "US-02", who: "Someone", problem: "Something.", outcome: "Better." },
      ],
      successCriteria: [
        { id: "SC-01", outcome: "one", serves: ["US-01"] },
        { id: "SC-02", outcome: "two" },
        { id: "SC-03", outcome: "three", serves: ["US-09"] },
      ],
      strands: (base.strands ?? []).map((candidate) =>
        candidate.id === "S-01"
          ? { ...candidate, successCriteria: ["SC-01", "SC-02", "SC-03"] }
          : candidate,
      ),
    });
    const result = checkPlan(contract, splitPlanSections(PLAN));
    expect(result.ready).toBe(false);
    if (result.ready) return;
    expect(result.reasons.map((reason) => reason.kind)).toEqual([
      "story_incomplete",
      "unserved_story",
      "criterion_serves_no_story",
      "unknown_story",
    ]);
    expect(result.reasons[0]).toMatchObject({ storyId: "US-01", missing: ["who", "outcome"] });
    expect(result.reasons[3]).toMatchObject({ criterionId: "SC-03", storyId: "US-09" });
  });
});

describe("the human's words (P14, SC-P14-03)", () => {
  const quoting = (overrides: Partial<ProgramContract> = {}): ProgramContract => {
    const base = planned();
    return planned({
      stories: (base.stories ?? []).map((story) => ({
        ...story,
        words: ["I want the median, tested"],
      })),
      ...overrides,
    });
  };
  const session = {
    harness: "claude",
    sessionId: "s-1",
    messages: [
      { index: 1, role: "human" as const, text: "hi. I want   the median,\ntested — soon" },
      { index: 2, role: "assistant" as const, text: "You said: I want the mean, tested" },
    ],
  };
  const kept = keepMessages(emptyConversation("p1"), session, [1, 2]);

  it("refuses quotes when no conversation is kept to hold them to", () => {
    expect(kinds(quoting())).toEqual(["conversation_missing"]);
  });

  it("accepts a quote the human said, differing only in whitespace", () => {
    expect(checkPlan(quoting(), splitPlanSections(PLAN), kept)).toEqual({ ready: true });
  });

  it("refuses a quote the human did not say, even one the assistant did", () => {
    const contract = quoting({
      stories: [
        {
          id: "US-01",
          who: "w",
          problem: "p",
          outcome: "o",
          words: ["I want the mean, tested", "I want the median"],
        },
      ],
    });
    const result = checkPlan(contract, splitPlanSections(PLAN), kept);
    expect(result.ready).toBe(false);
    if (result.ready) return;
    expect(result.reasons).toEqual([
      expect.objectContaining({ kind: "quote_not_found", quote: "I want the mean, tested" }),
    ]);
  });

  it("does not check quotes when the conversation is not kept", () => {
    expect(kinds(quoting({ keepConversation: false }))).toEqual([]);
  });
});

describe("planHash over P14's fields", () => {
  const fake = (text: string): string => `${text.length}:${text}`;
  it("moves with a story, and not with the kept conversation", () => {
    const contract = planned();
    const before = planHash(contract, PLAN, fake);
    const conversation = { uri: "s3://b/c", sha256: "c".repeat(64), sizeBytes: 3 };
    expect(planHash(planned({ conversation }), PLAN, fake)).toEqual(before);
    const reworded = planned({
      stories: (contract.stories ?? []).map((story) => ({ ...story, outcome: "Something else." })),
    });
    expect(planHash(reworded, PLAN, fake).hash).not.toBe(before.hash);
  });
});

describe("the gate (D-P7-02)", () => {
  it("does not gate a contract with no strands, and gates a planned one on ratification", () => {
    const plain = makeProgramContract(createFixtures());
    expect(isPlanned(plain)).toBe(false);
    expect(mayRunContract(plain)).toBe(true);
    expect(mayRunContract(planned())).toBe(false);
    const sha = "b".repeat(64);
    expect(
      mayRunContract(
        planned({
          status: "ratified",
          planHash: sha,
          planDocument: { uri: "s3://b/k", sha256: sha, sizeBytes: 1 },
        }),
      ),
    ).toBe(true);
  });
});
