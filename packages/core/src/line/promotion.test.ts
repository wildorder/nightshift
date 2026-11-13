import type { LineComposition, LineRecord, ProgramId } from "@nightshift/contracts";
import { describe, expect, it } from "vitest";
import { createFixtures, makeLineRecord, makeLineVerification } from "../testing/index.js";
import {
  divergedCommits,
  lineWaitingReasons,
  MAX_PROMOTION_BODY_CHARS,
  type PromotionCompare,
  type PromotionProgramFacts,
  promotionBody,
  promotionPrograms,
  promotionTitle,
} from "./promotion.js";

const AT = "2026-01-01T00:00:00.000Z";
const sha = (n: number): string => n.toString(16).padStart(7, "0").padEnd(40, "0");
const pid = (n: number): ProgramId => `prog_${n.toString().padStart(26, "0")}` as ProgramId;
const commit = (n: number, subject = `commit ${n}`, parents: string[] = [sha(n - 1)]) => ({
  sha: sha(n),
  subject,
  parents,
});
const compare = (
  commits: ReturnType<typeof commit>[],
  over: Partial<PromotionCompare> = {},
): PromotionCompare => ({
  aheadBy: commits.length,
  behindBy: 0,
  commits,
  complete: true,
  ...over,
});

const f = createFixtures();
const composition = (
  n: number,
  programs: number[],
  over: Partial<LineComposition> = {},
): LineComposition => ({
  compositionId: `c${n}`,
  commit: sha(n),
  parent: sha(n - 1),
  ranges: programs.map((p) => ({ program: pid(p), upTo: sha(1000 + p) })),
  verification: makeLineVerification(f, { commitSha: sha(n) }),
  composedAt: AT,
  ...over,
});
const line = (over: Partial<LineRecord> = {}): LineRecord =>
  makeLineRecord(f, { head: sha(3), ...over });
const facts = (ids: number[], over: Partial<PromotionProgramFacts> = {}) =>
  new Map(ids.map((i) => [pid(i), { whole: true, programsDirectory: "docs/programs", ...over }]));

describe("divergedCommits", () => {
  it("is empty when the target has nothing the line lacks", () => {
    expect(divergedCommits(compare([])).count).toBe(0);
  });

  it("does not count the merge commit of an earlier promotion", () => {
    const merge = commit(5, "Merge pull request #1 from x/line", [sha(4), sha(100)]);
    const result = divergedCommits(compare([merge]));
    expect(result.commits).toEqual([]);
    expect(result.count).toBe(0);
  });

  it("counts a squash merge and a direct commit", () => {
    const result = divergedCommits(compare([commit(5, "feat (#2)"), commit(6, "fix")]));
    expect(result.count).toBe(2);
    expect(result.commits.map((c) => c.subject)).toEqual(["feat (#2)", "fix"]);
  });

  it("counts a merge whose second parent is itself target-only", () => {
    const result = divergedCommits(
      compare([commit(5), commit(6, "Merge branch hotfix", [sha(5), sha(5)])]),
    );
    expect(result.count).toBe(2);
  });

  it("reports the target-only aheadBy for an incomplete compare, not behindBy", () => {
    const result = divergedCommits(
      compare([commit(5), commit(6)], { aheadBy: 400, behindBy: 7, complete: false }),
    );
    expect(result.count).toBe(400);
    expect(result.complete).toBe(false);
    expect(result.commits).toHaveLength(2);
    expect(
      divergedCommits(compare([commit(5)], { aheadBy: 30, behindBy: 0, complete: false })).count,
    ).toBe(30);
  });
});

describe("promotionPrograms", () => {
  it("lists every range program of kept compositions in ahead, in order", () => {
    const record = line({ compositions: [composition(1, [1]), composition(2, [2, 3])] });
    expect(promotionPrograms(record, compare([commit(1), commit(2)]))).toEqual([
      pid(1),
      pid(2),
      pid(3),
    ]);
  });

  it("omits compositions whose commit the target already has", () => {
    const record = line({ compositions: [composition(1, [1]), composition(2, [2])] });
    expect(promotionPrograms(record, compare([commit(2)]))).toEqual([pid(2)]);
  });

  it("names an evicted composition's program from its subject only", () => {
    const record = line({ compositions: [composition(2, [2])] });
    const ahead = compare([
      commit(1, `Merge program ${pid(9)} (start)..abc123 into the line`),
      commit(2),
      commit(3, `Merge program ${pid(2)} aaa..bbb into the line`),
      commit(4, "unrelated"),
    ]);
    expect(promotionPrograms(record, ahead)).toEqual([pid(9), pid(2)]);
  });
});

describe("promotionTitle", () => {
  it("names the line and target", () => {
    expect(promotionTitle(line(), "main")).toBe("Promote nightshift/develop to main");
  });
});

const body = (over: Partial<Parameters<typeof promotionBody>[0]> = {}): string => {
  const record = over.record ?? line({ compositions: [composition(3, [1, 2])] });
  const ahead = over.ahead ?? compare([commit(3)]);
  return promotionBody({
    record,
    to: "main",
    repository: "acme/app",
    ahead,
    diverged: divergedCommits(compare([])),
    programs: facts([1, 2]),
    ...over,
  });
};

describe("promotionBody", () => {
  it("opens with the warning, commits and remedy when diverged", () => {
    const diverged = divergedCommits(compare([commit(5, "feat (#2)"), commit(6, "fix")]));
    const lines = body({ diverged }).split("\n");
    expect(lines[0]).toMatch(/Warning/);
    expect(lines.slice(0, 8).join("\n")).toContain("`0000005` feat (#2)");
    expect(lines.slice(0, 8).join("\n")).toContain("Merge `main` into `nightshift/develop`");
    expect(lines.slice(0, 8).join("\n")).toContain("protect `main`");
  });

  it("says 'and N more' from the count when commits are capped", () => {
    const many = Array.from({ length: 40 }, (_, i) => commit(100 + i));
    const text = body({ diverged: divergedCommits(compare(many)) });
    expect(text).toContain("- and 30 more");
  });

  it("has no warning when not diverged, and names head, merge advice", () => {
    const text = body();
    expect(text).not.toContain("Warning");
    expect(text).toContain(sha(3));
    expect(text).toContain("Merge with a merge commit");
  });

  it("links each program's report and says whole or part", () => {
    const programs = new Map<ProgramId, PromotionProgramFacts>([
      [
        pid(1),
        { whole: true, programsDirectory: "docs/programs", title: "One", name: "p1-billing" },
      ],
      [pid(2), { whole: false, programsDirectory: "docs/programs" }],
    ]);
    const text = body({ programs });
    expect(text).toContain(
      `- \`${pid(1)}\` One: whole, [report](https://github.com/acme/app/blob/nightshift/develop/docs/programs/p1-billing/report.md)`,
    );
    expect(text).not.toContain(`/${pid(1)}/report.md`);
    expect(text).toContain(`\`${pid(2)}\`: part, no report published`);
  });

  it("calls a program missing from the map part", () => {
    expect(body({ programs: new Map() })).toContain(`\`${pid(1)}\`: part`);
  });

  it("gives an evicted composition's program a link and whole/part", () => {
    const record = line({ compositions: [] });
    const ahead = compare([commit(1, `Merge program ${pid(7)} (start)..abc into the line`)]);
    const text = body({ record, ahead, programs: facts([7], { whole: false, name: "p7-x" }) });
    expect(text).toContain(
      `\`${pid(7)}\` p7-x: part, [report](https://github.com/acme/app/blob/nightshift/develop/docs/programs/p7-x/report.md)`,
    );
  });

  it("states the repairs made on the line", () => {
    const job = f.ids.next("job");
    const record = line({
      compositions: [
        composition(3, [1], {
          resolver: { decision: "resolved", attempts: 1, detail: "kept both imports" },
          repair: { runId: f.scope.runId, jobContractId: job },
        }),
      ],
    });
    const text = body({ record });
    expect(text).toContain("## Repairs made on the line");
    expect(text).toContain("resolver resolved: kept both imports");
    expect(text).toContain(`repair run ${f.scope.runId}, job ${job}`);
  });

  it("states each repair's decision, or that none was recorded", () => {
    const [jobA, jobB] = [f.ids.next("job"), f.ids.next("job")];
    const record = line({
      compositions: [
        composition(3, [1], { repair: { runId: f.scope.runId, jobContractId: jobA } }),
        composition(4, [2], { repair: { runId: f.scope.runId, jobContractId: jobB } }),
      ],
    });
    const text = body({
      record,
      ahead: compare([commit(3), commit(4)]),
      repairs: new Map([
        [
          jobA,
          {
            cause: "gate_failure",
            gates: ["npm test", "npm run lint"],
            choice: "Delegate repair attempt 1 of 3",
            rationale: "only this range waits",
          },
        ],
      ]),
    });
    expect(text).toContain("cause gate_failure; gates npm test, npm run lint;");
    expect(text).toContain(
      "decided: Delegate repair attempt 1 of 3, because only this range waits",
    );
    expect(text).toContain(`job ${jobB}; decision not recorded`);
  });

  it("omits repairs when none were made", () => {
    expect(body()).not.toContain("Repairs");
  });

  it("states the head composition's verification", () => {
    const text = body();
    expect(text).toContain("**passed**");
    expect(text).toContain("`npm test`: exit 0");
  });

  it("says how many commits an incomplete ahead compare did not list", () => {
    const text = body({ ahead: compare([commit(3)], { aheadBy: 251, complete: false }) });
    expect(text).toContain("250 commits the line holds were not listed");
  });

  it("stays within the bound with 50 large compositions and over 250 commits", () => {
    const big = "x".repeat(5000);
    const compositions = Array.from({ length: 50 }, (_, i) =>
      composition(i + 1, [i * 3 + 1, i * 3 + 2, i * 3 + 3], {
        resolver: { decision: "resolved", attempts: 1, detail: big },
        repair: { runId: f.scope.runId, jobContractId: f.ids.next("job") },
        verification: makeLineVerification(f, {
          commands: Array.from({ length: 40 }, (_, c) => ({
            stepId: `s${c}`,
            command: big,
            exitCode: 0,
            durationMs: 1,
          })),
        }),
      }),
    );
    const record = line({ compositions, head: sha(50) });
    const commits = Array.from({ length: 300 }, (_, i) => commit(i + 1, big));
    const text = promotionBody({
      record,
      to: "main",
      repository: "acme/app",
      ahead: compare(commits, { complete: false, aheadBy: 400 }),
      diverged: divergedCommits(compare(commits.map((c) => ({ ...c, parents: [sha(0)] })))),
      programs: facts(
        Array.from({ length: 150 }, (_, i) => i + 1),
        { title: big },
      ),
      repairs: new Map(
        compositions.map((c) => [
          c.repair?.jobContractId ?? "",
          { cause: big, gates: [big], choice: big, rationale: big },
        ]),
      ),
    });
    expect(text.length).toBeLessThanOrEqual(MAX_PROMOTION_BODY_CHARS);
    expect(text).toMatch(/- and \d+ more/);
    expect(text.endsWith("\n")).toBe(false);
    expect(text).toContain("Merge with a merge commit");
  });
});

describe("lineWaitingReasons", () => {
  it("is empty for a line with no promotion and nothing waiting", () => {
    expect(lineWaitingReasons(line())).toEqual([]);
  });

  it("keeps the line's own waiting first", () => {
    const waiting = { reason: "monthly_cap" as const, detail: "cap", since: AT };
    expect(lineWaitingReasons(line({ waiting }))).toEqual([waiting]);
  });

  it("adds promotion_diverged with the commits and remedy", () => {
    const record = line({
      promotion: {
        to: "main",
        updatedAt: AT,
        diverged: { commits: [{ sha: sha(5), subject: "feat" }], count: 1, since: AT },
      },
    });
    const [reason] = lineWaitingReasons(record);
    expect(reason?.reason).toBe("promotion_diverged");
    expect(reason?.detail).toContain("0000005 feat");
    expect(reason?.detail).toContain("Merge `main` into `nightshift/develop`");
  });

  it("adds promotion_forbidden with the grant", () => {
    const record = line({
      promotion: {
        to: "main",
        updatedAt: AT,
        blocked: { reason: "pull_requests_permission", detail: "403", since: AT, at: AT },
      },
    });
    const [reason] = lineWaitingReasons(record);
    expect(reason?.reason).toBe("promotion_forbidden");
    expect(reason?.detail).toContain("Pull requests: Read and write");
  });

  it("ignores other blocked reasons", () => {
    const record = line({
      promotion: {
        to: "main",
        updatedAt: AT,
        blocked: { reason: "error", detail: "x", since: AT, at: AT },
      },
    });
    expect(lineWaitingReasons(record)).toEqual([]);
  });
});
