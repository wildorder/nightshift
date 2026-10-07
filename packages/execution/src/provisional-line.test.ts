/**
 * The provisional line and the records, kept in agreement: what a stop leaves
 * at the line's tip without a deferred node is dropped, and nothing else is.
 * Real git; the records are the run's nodes, as the control plane holds them.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommitSha, ExecutionNode, ExecutionNodeStatus } from "@nightshift/contracts";
import { createFixtures, makeNode, type ProjectStores } from "@nightshift/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  git,
  nodeGitRunner,
  provisionalHead,
  provisionalRef,
  revParse,
  updateRef,
} from "./git/index.js";
import { repairProvisionalLine } from "./provisional-line.js";

const AT = Date.parse("2026-10-07T12:00:00.000Z");
const BRANCH = "program/line";

const made: string[] = [];
afterEach(async () => {
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
});

const repository = async () => {
  const root = await mkdtemp(join(tmpdir(), "nightshift-line-"));
  made.push(root);
  const repo = join(root, "repo");
  await mkdir(repo);
  const run = (args: readonly string[]) => git(nodeGitRunner, args, { cwd: repo, atMs: AT });
  await writeFile(join(repo, "a.txt"), "0\n");
  await run(["init", "--initial-branch", BRANCH]);
  await run(["add", "-A"]);
  await run(["commit", "-m", "base"]);
  return { repo, run };
};

/** A commit on top of `parent`, off the branch: what the queue puts on the line. */
const commitOn = async (
  ctx: Awaited<ReturnType<typeof repository>>,
  parent: string,
  n: number,
): Promise<CommitSha> => {
  await ctx.run(["checkout", "-q", "--detach", parent]);
  await writeFile(join(ctx.repo, "a.txt"), `${n}\n`);
  await ctx.run(["commit", "-qam", `c${n}`]);
  const sha = await revParse(nodeGitRunner, ctx.repo, "HEAD");
  await ctx.run(["checkout", "-q", BRANCH]);
  return sha;
};

const world = async (statuses: readonly ExecutionNodeStatus[]) => {
  const ctx = await repository();
  const f = createFixtures();
  let parent: string = await revParse(nodeGitRunner, ctx.repo, BRANCH);
  const nodes: ExecutionNode[] = [];
  const line: CommitSha[] = [];
  for (const [i, status] of statuses.entries()) {
    const sha = await commitOn(ctx, parent, i + 1);
    line.push(sha);
    nodes.push(makeNode(f, f.rootNodeId, { status, commitSha: sha }));
    parent = sha;
  }
  if (line.length > 0) {
    await updateRef(nodeGitRunner, ctx.repo, provisionalRef(f.scope.runId), parent);
  }
  const stores = {
    executionNodes: { listByRun: async () => ({ items: nodes }) },
  } as unknown as Pick<ProjectStores, "executionNodes">;
  const session = {
    scope: f.scope,
    repoPath: ctx.repo,
    program: { repository: { programBranch: BRANCH } },
  };
  const repair = () => repairProvisionalLine({ git: nodeGitRunner, stores }, session);
  const head = () => provisionalHead(nodeGitRunner, ctx.repo, f.scope.runId);
  return { line, repair, head };
};

describe("the provisional line and its records", () => {
  it("drops a tip whose node never became deferred, and keeps the line beneath it", async () => {
    const w = await world(["deferred", "verifying"]);
    expect(await w.repair()).toEqual([w.line[1]]);
    expect(await w.head()).toBe(w.line[0]);
  });

  it("removes the line when no commit on it has a deferred node", async () => {
    const w = await world(["interrupted"]);
    expect(await w.repair()).toEqual([w.line[0]]);
    expect(await w.head()).toBeUndefined();
  });

  it("leaves a line every commit of which a deferred node carries", async () => {
    const w = await world(["deferred", "deferred"]);
    expect(await w.repair()).toEqual([]);
    expect(await w.head()).toBe(w.line[1]);
  });

  it("does nothing while there is no line", async () => {
    const w = await world([]);
    expect(await w.repair()).toEqual([]);
    expect(await w.head()).toBeUndefined();
  });
});
