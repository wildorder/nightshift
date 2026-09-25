/**
 * The `plan-program` skill's template and the rules that read it (P7, T2).
 *
 * The template is what every program's plan starts from, so it has to parse
 * into the sections `checkPlan` looks for, and a plan written from it has to be
 * able to reach `READY`. The second test is a recorded planning session's
 * output over the slice fixture: the two files as the skill leaves them.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { type ProgramContract, ProgramContractSchema } from "@nightshift/contracts";
import { checkPlan, splitPlanSections } from "@nightshift/core";
import { describe, expect, it } from "vitest";
import { authoredProgram } from "../slice/fixture-repo.js";

const skill = (...parts: string[]): string =>
  fileURLToPath(new URL(`../../../skills/plan-program/${parts.join("/")}`, import.meta.url));

/** A template filled in the way the skill fills it: comments gone, sections written. */
const fill = (template: string, replacements: Readonly<Record<string, string>>): string => {
  let text = template.replace(/<!--[\s\S]*?-->\n?/g, "");
  for (const [from, to] of Object.entries(replacements)) text = text.replace(from, to);
  return text;
};

describe("the plan template", () => {
  it("has the sections the program contract §4.2 names, in order", async () => {
    const template = await readFile(skill("templates", "plan.md"), "utf8");
    const headings = template
      .split("\n")
      .filter((line) => /^## /.test(line))
      .map((line) => line.slice(3));
    expect(headings).toEqual([
      "Overview",
      "Architecture",
      "Strands",
      "Decisions",
      "Human prerequisites",
      "Program boundary",
      "Risks",
    ]);
  });

  it("has nowhere to put a job", async () => {
    const template = await readFile(skill("templates", "plan.md"), "utf8");
    const headings = template.split("\n").filter((line) => /^#+ /.test(line));
    expect(headings.some((line) => /\b(jobs?|tasks?|steps?)\b/i.test(line))).toBe(false);
  });

  it("parses into a strand section only once the section has something in it", async () => {
    const template = await readFile(skill("templates", "plan.md"), "utf8");
    // As shipped, the strand's heading is there and its body is comments: not a section yet.
    expect(Object.keys(splitPlanSections(template))).toEqual(["S-01"]);

    const base = await authoredProgram();
    const contract: ProgramContract = ProgramContractSchema.parse({
      ...base,
      status: "planning",
      strands: [
        {
          id: "S-01",
          name: "The median helper",
          scope: { summary: "src and its tests", includes: base.scope.includes, excludes: [] },
          acceptance: ["median is exported and tested"],
          successCriteria: base.successCriteria.map((criterion) => criterion.id),
          dependsOn: [],
          prerequisites: [],
        },
      ],
    });

    const empty = fill(template, { "{Strand name}": "The median helper" });
    const unready = checkPlan(contract, splitPlanSections(empty));
    expect(unready.ready).toBe(false);

    const written = fill(template, {
      "{Strand name}": "The median helper",
      "#### Approach\n":
        "#### Approach\n\nA pure function in `src/stats.js`, exported from `src/index.js`.\n",
    });
    expect(splitPlanSections(written)["S-01"]).toContain("A pure function in `src/stats.js`");
    expect(checkPlan(contract, splitPlanSections(written))).toEqual({ ready: true });
  });
});

describe("the run-program skill", () => {
  it("starts the run detached, reads the report rulings then departures first, and never edits the plan", async () => {
    const text = await readFile(
      fileURLToPath(new URL("../../../skills/run-program/SKILL.md", import.meta.url)),
      "utf8",
    );
    for (const phrase of [
      "run_in_background",
      // P8: an arbiter's ruling is read out before anything, with how to reverse it.
      "Every **arbiter ruling**, before anything else",
      "nightshift ruling reverse {id} <decisionId>",
      "Every **departure** from the plan's approach",
      "nightshift resume {id}",
      "Edit the plan or the contract to get past a refusal",
    ]) {
      expect(text, phrase).toContain(phrase);
    }
  });
});

describe("the skill", () => {
  it("states the line, the audit's tests and the gate, and never offers to ratify", async () => {
    const text = await readFile(skill("SKILL.md"), "utf8");
    for (const phrase of [
      "Would undoing this choice throw away more than one job's work, or need a",
      "**You name no jobs.**",
      "cannot-versus-tedious",
      "perform-versus-observe",
      "**Hoist first.**",
      "expand → migrate → contract",
      "nightshift plan check {id}",
      "plan and hand it to the run?",
      "git checkout -b program/{id} main",
      "nightshift plan ratify {id}",
      "/run-program {id}",
      "Those are **all** the fields.",
    ]) {
      expect(text, phrase).toContain(phrase);
    }
  });

  it("ships a contract example that is a valid planned contract", async () => {
    const text = await readFile(skill("SKILL.md"), "utf8");
    const json = /```json\n([\s\S]*?)```/.exec(text)?.[1];
    expect(json).toBeDefined();
    const base = await authoredProgram();
    // The example states only the planned part; the rest is inherited or authored.
    const contract = ProgramContractSchema.parse({ ...base, ...JSON.parse(json ?? "{}") });
    expect(contract.strands?.[0]?.id).toBe("S-01");
    expect(contract.prerequisites?.[0]?.verifyCommand).toContain("gh secret list");
  });
});

describe("the nightshift skill (P8)", () => {
  it("names the classification, the fix limit, the dispute and every tool it names by its real name", async () => {
    const text = await readFile(
      fileURLToPath(new URL("../../../skills/nightshift/SKILL.md", import.meta.url)),
      "utf8",
    );
    for (const phrase of [
      "**Leaving a field unset is the conservative choice, not the cheap one**",
      "`testability`",
      "At most **two** fixes",
      "finding.dispute { jobId, reason }",
      "climbs one rung",
    ]) {
      expect(text, phrase).toContain(phrase);
    }
    expect(text).not.toContain("examination_unavailable");
  });
});
