/**
 * A strand an earlier run left unlanded, continued by the next run of the same
 * plan (A-60): its checkout starts from the earlier strand's head with the
 * program head merged in, or, when the two conflict, from the program head
 * with the earlier work named. Real git; the records are stand-ins for the
 * control plane's.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CommitSha,
  ExecutionNode,
  ExecutionNodeStatus,
  JobContract,
  ProgramContract,
  Run,
} from "@nightshift/contracts";
import {
  createFixtures,
  makeJobContract,
  makeNode,
  makeRootNode,
  makeRun,
  type ProjectStores,
} from "@nightshift/core";
import { afterEach, describe, expect, it } from "vitest";
import { continueUnfinishedStrand } from "./carry-over.js";
import { git, nodeGitRunner, revParse } from "./git/index.js";
import type { StrandMove } from "./publish.js";
import { strandBranch } from "./strand.js";

const AT = Date.parse("2026-10-18T12:00:00.000Z");
const BRANCH = "program/line";
const PLAN_HASH = "a".repeat(64);

const made: string[] = [];
afterEach(async () => {
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
});

const repository = async () => {
  const root = await mkdtemp(join(tmpdir(), "nightshift-carry-"));
  made.push(root);
  const repo = join(root, "repo");
  await mkdir(repo);
  const run = (args: readonly string[], cwd = repo) => git(nodeGitRunner, args, { cwd, atMs: AT });
  await writeFile(join(repo, "a.txt"), "0\n");
  await run(["init", "--initial-branch", BRANCH]);
  await run(["add", "-A"]);
  await run(["commit", "-m", "base"]);
  return { root, repo, run };
};

/** A commit of `file` on `branch`, made from `from`. */
const commitOn = async (
  ctx: Awaited<ReturnType<typeof repository>>,
  branch: string,
  from: string,
  file: string,
  text: string,
  message: string,
): Promise<CommitSha> => {
  await ctx.run(["checkout", "-q", "-B", branch, from]);
  await writeFile(join(ctx.repo, file), text);
  await ctx.run(["add", "-A"]);
  await ctx.run(["commit", "-qm", message]);
  const sha = await revParse(nodeGitRunner, ctx.repo, "HEAD");
  await ctx.run(["checkout", "-q", BRANCH]);
  return sha;
};

/**
 * One earlier run of the plan, whose strand S-01 ended `status` and built on
 * the branch the test makes; and the stores that hold it.
 */
const earlierRun = (status: ExecutionNodeStatus, planHash = PLAN_HASH) => {
  const f = createFixtures();
  const run: Run = makeRun(f, { status: "failed" });
  const strandJob: JobContract = makeJobContract(f, { kind: "orchestrate", strandId: "S-01" });
  const strandNode: ExecutionNode = makeNode(f, f.rootNodeId, {
    kind: "sub-program",
    status,
    jobContractId: strandJob.jobContractId,
  });
  const root = makeRootNode(f, {
    plan: { planHash, planDocument: { uri: "plan.md", sha256: planHash, sizeBytes: 1 } },
  });
  const stores = {
    runs: { listByProgram: async () => ({ items: [run] }) },
    executionNodes: {
      get: async () => root,
      listByRun: async () => ({ items: [root, strandNode] }),
    },
    jobContracts: { listByRun: async () => ({ items: [strandJob] }) },
  } as unknown as ProjectStores;
  const program = {
    projectId: f.scope.projectId,
    programId: f.scope.programId,
    planHash: PLAN_HASH,
    strands: [{ id: "S-01" }],
    repository: { programBranch: BRANCH },
  } as unknown as ProgramContract;
  return {
    f,
    run,
    strandNode,
    stores,
    program,
    branch: strandBranch(run.runId, strandNode.executionNodeId),
  };
};

/** This run's strand checkout, cut at the program head as the runner cuts it. */
const checkout = async (ctx: Awaited<ReturnType<typeof repository>>, base: string) => {
  const worktree = join(ctx.root, "strand");
  await ctx.run(["worktree", "add", "-q", "-b", "nightshift/run_now/node_now", worktree, base]);
  return worktree;
};

const continueIt = async (
  ctx: Awaited<ReturnType<typeof repository>>,
  earlier: ReturnType<typeof earlierRun>,
  worktree: string,
  base: CommitSha,
  moves: StrandMove[],
) =>
  continueUnfinishedStrand(
    {
      stores: earlier.stores,
      git: nodeGitRunner,
      clock: { now: () => AT },
      publishStrand: async (move) => {
        moves.push(move);
      },
    },
    {
      program: earlier.program,
      repoPath: ctx.repo,
      runId: "run_now",
      strandId: "S-01",
      strandNodeId: "node_now" as ExecutionNode["executionNodeId"],
      worktree,
      base,
    },
  );

describe("a strand an earlier run left unlanded (A-60)", () => {
  it("is continued from its branch, with the program head merged in, and published at once", async () => {
    const ctx = await repository();
    const earlier = earlierRun("failed");
    const start = await revParse(nodeGitRunner, ctx.repo, BRANCH);
    const j1 = await commitOn(ctx, earlier.branch, start, "s1.txt", "one\n", "the s1 module");
    await commitOn(ctx, earlier.branch, j1, "s2.txt", "two\n", "the s2 module");
    // The program moved on meanwhile: another strand landed.
    const base = await commitOn(ctx, BRANCH, start, "other.txt", "x\n", "another strand");
    const worktree = await checkout(ctx, base);
    const moves: StrandMove[] = [];

    const continued = await continueIt(ctx, earlier, worktree, base, moves);
    expect(continued).toMatchObject({ fromRunId: earlier.run.runId, branch: earlier.branch });
    expect(continued?.conflict).toBeUndefined();
    expect(continued?.work).toEqual(["the s2 module", "the s1 module"]);
    // Every job's work is in the checkout, and so is the program's.
    expect(await readFile(join(worktree, "s1.txt"), "utf8")).toBe("one\n");
    expect(await readFile(join(worktree, "s2.txt"), "utf8")).toBe("two\n");
    expect(await readFile(join(worktree, "other.txt"), "utf8")).toBe("x\n");
    // And its new head is on its way to GitHub.
    expect(moves).toHaveLength(1);
    expect(moves[0]?.branch).toBe("nightshift/run_now/node_now");
  });

  it("is read from the remote when this clone never had it: a machine published it", async () => {
    const ctx = await repository();
    const earlier = earlierRun("cancelled");
    const start = await revParse(nodeGitRunner, ctx.repo, BRANCH);
    await commitOn(ctx, earlier.branch, start, "s1.txt", "one\n", "the s1 module");
    // The clone that runs next is another one, whose origin holds the branch.
    const clone = join(ctx.root, "clone");
    await ctx.run(["clone", "-q", "--branch", BRANCH, ctx.repo, clone], ctx.root);
    await ctx.run(["branch", "-q", "-D", earlier.branch], clone).catch(() => undefined);
    const other = { ...ctx, repo: clone };
    const worktree = await checkout(other, start);
    const continued = await continueIt(other, earlier, worktree, start as CommitSha, []);
    expect(continued?.conflict).toBeUndefined();
    expect(await readFile(join(worktree, "s1.txt"), "utf8")).toBe("one\n");
  });

  it("starts from the program head and names the earlier work when the two conflict", async () => {
    const ctx = await repository();
    const earlier = earlierRun("failed");
    const start = await revParse(nodeGitRunner, ctx.repo, BRANCH);
    await commitOn(ctx, earlier.branch, start, "a.txt", "theirs\n", "the strand's a");
    const base = await commitOn(ctx, BRANCH, start, "a.txt", "ours\n", "the program's a");
    const worktree = await checkout(ctx, base);
    const continued = await continueIt(ctx, earlier, worktree, base, []);
    expect(continued?.conflict).toContain("a.txt");
    expect(continued?.work).toEqual(["the strand's a"]);
    expect(await revParse(nodeGitRunner, worktree, "HEAD")).toBe(base);
  });

  it("is nothing to continue when it landed, when the plan changed, or when it built nothing", async () => {
    const ctx = await repository();
    const start = (await revParse(nodeGitRunner, ctx.repo, BRANCH)) as CommitSha;
    const landed = earlierRun("succeeded");
    await commitOn(ctx, landed.branch, start, "s1.txt", "one\n", "the s1 module");
    const replanned = earlierRun("failed", "b".repeat(64));
    await commitOn(ctx, replanned.branch, start, "s1.txt", "one\n", "the s1 module");
    const empty = earlierRun("failed");
    await ctx.run(["branch", "-q", empty.branch, start]);
    for (const earlier of [landed, replanned, empty]) {
      const worktree = await checkout(ctx, start);
      expect(await continueIt(ctx, earlier, worktree, start, [])).toBeUndefined();
      await ctx.run(["worktree", "remove", "--force", worktree]);
      await ctx.run(["branch", "-q", "-D", "nightshift/run_now/node_now"]);
    }
  });
});
