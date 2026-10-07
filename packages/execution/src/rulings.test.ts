/**
 * The program's memory of its rulings: what is gathered, what is left out, and
 * which rulings follow a change because it carries the very work they were
 * made on. Records stand in for the control plane; git is real.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGGREGATE_EXAMPLES,
  type Decision,
  type Examination,
  type Run,
} from "@nightshift/contracts";
import type { ProjectStores } from "@nightshift/core";
import type { ProgramRuling } from "@nightshift/harness";
import { afterEach, describe, expect, it } from "vitest";
import { git, nodeGitRunner, revParse } from "./git/index.js";
import { programRulings, rulingsCarriedBy } from "./rulings.js";

const made: string[] = [];
afterEach(async () => {
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
});

const RUN = AGGREGATE_EXAMPLES.Run as Run;
const EXAMINATION = AGGREGATE_EXAMPLES.Examination as Examination;
const DECISION = AGGREGATE_EXAMPLES.Decision as Decision;

const ruling = (
  decisionId: string,
  choice: string,
  supersedes: string | null = null,
): Decision => ({
  ...DECISION,
  decisionId: decisionId as never,
  executionNodeId: EXAMINATION.executionNodeId,
  authority: supersedes === null ? "agent" : "human",
  choice,
  rationale: `why ${decisionId}`,
  supersedesDecisionId: supersedes as never,
});

const examinationRuledBy = (decisionId: string): Examination => ({
  ...EXAMINATION,
  findings: EXAMINATION.findings.map((finding) => ({
    ...finding,
    resolution: "upheld" as const,
    resolvedBy: { authority: "agent" as const, decisionId: decisionId as never, at: RUN.startedAt },
  })),
});

const storesWith = (decisions: Decision[], examinations: Examination[]) =>
  ({
    runs: { listByProgram: async () => ({ items: [RUN] }) },
    decisions: { listByRun: async () => ({ items: decisions }) },
    examinations: { listByNode: async () => examinations },
  }) as unknown as Pick<ProjectStores, "runs" | "decisions" | "examinations">;

describe("the program's rulings", () => {
  it("gathers each upheld ruling with its finding, rationale, paths and the work it was made on", async () => {
    const decisionId = "dec_01M4BHBEV4HGHTQQ419AD8BC58";
    const rulings = await programRulings(
      storesWith([ruling(decisionId, "uphold")], [examinationRuledBy(decisionId)]),
      RUN,
    );
    expect(rulings).toEqual([
      {
        decisionId,
        runId: RUN.runId,
        findingId: EXAMINATION.findings[0]?.id,
        finding: EXAMINATION.findings[0]?.summary,
        rationale: `why ${decisionId}`,
        paths: ["migrations/0007_tenant_owner.sql"],
        commitSha: EXAMINATION.commitSha,
        patchId: EXAMINATION.patchId,
      },
    ]);
  });

  it("leaves out an overturned ruling, and one a human reversed", async () => {
    const overturned = "dec_01M4BHBEV4HGHTQQ419AD8BC51";
    const reversed = "dec_01M4BHBEV4HGHTQQ419AD8BC52";
    const rulings = await programRulings(
      storesWith(
        [
          ruling(overturned, "overturn"),
          ruling(reversed, "uphold"),
          ruling("dec_01M4BHBEV4HGHTQQ419AD8BC53", "overturn", reversed),
        ],
        [examinationRuledBy(overturned), examinationRuledBy(reversed)],
      ),
      RUN,
    );
    expect(rulings).toEqual([]);
  });
});

describe("rulings that follow the work", () => {
  const repo = async () => {
    const root = await mkdtemp(join(tmpdir(), "nightshift-rulings-"));
    made.push(root);
    const dir = join(root, "repo");
    await mkdir(dir);
    const run = (args: readonly string[]) => git(nodeGitRunner, args, { cwd: dir });
    await writeFile(join(dir, "a.txt"), "0\n");
    await run(["init", "--initial-branch", "main"]);
    await run(["add", "-A"]);
    await run(["commit", "-qm", "base"]);
    const base = await revParse(nodeGitRunner, dir, "HEAD");
    await writeFile(join(dir, "a.txt"), "ruled on\n");
    await run(["commit", "-qam", "the ruled-on work"]);
    const ruled = await revParse(nodeGitRunner, dir, "HEAD");
    await writeFile(join(dir, "b.txt"), "more\n");
    await run(["add", "-A"]);
    await run(["commit", "-qm", "built on it"]);
    const onTop = await revParse(nodeGitRunner, dir, "HEAD");
    return { dir, base, ruled, onTop };
  };
  const theRuling = (commitSha: string, patchId: string): ProgramRuling => ({
    decisionId: "dec_01M4BHBEV4HGHTQQ419AD8BC58",
    runId: RUN.runId,
    findingId: "F-01",
    finding: "it is wrong",
    rationale: "because",
    paths: [],
    commitSha,
    patchId,
  });

  it("follows the same patch, re-landed or replayed by any job", async () => {
    const r = await repo();
    const carried = await rulingsCarriedBy(nodeGitRunner, {
      repoPath: r.dir,
      base: r.base,
      commitSha: r.base,
      patchId: "a".repeat(40),
      rulings: [theRuling(r.ruled, "a".repeat(40))],
    });
    expect(carried.map((c) => c.findingId)).toEqual(["F-01"]);
  });

  it("follows a change whose commits include the one it was made on", async () => {
    const r = await repo();
    const carried = await rulingsCarriedBy(nodeGitRunner, {
      repoPath: r.dir,
      base: r.base,
      commitSha: r.onTop,
      patchId: "b".repeat(40),
      rulings: [theRuling(r.ruled, "a".repeat(40))],
    });
    expect(carried).toHaveLength(1);
  });

  it("does not follow other work, even in the same files, nor work already beneath the base", async () => {
    const r = await repo();
    const unrelated = await rulingsCarriedBy(nodeGitRunner, {
      repoPath: r.dir,
      base: r.base,
      commitSha: r.base,
      patchId: "c".repeat(40),
      rulings: [theRuling(r.ruled, "a".repeat(40))],
    });
    expect(unrelated).toEqual([]);
    const landedAlready = await rulingsCarriedBy(nodeGitRunner, {
      repoPath: r.dir,
      base: r.ruled,
      commitSha: r.onTop,
      patchId: "c".repeat(40),
      rulings: [theRuling(r.ruled, "a".repeat(40))],
    });
    expect(landedAlready).toEqual([]);
  });
});
