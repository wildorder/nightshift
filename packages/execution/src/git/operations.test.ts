/**
 * The git layer against a real repository.
 *
 * Deliberately not a fake. Every claim in `operations.ts` is a claim about what
 * `git` does — that `reset --soft` keeps the index, that `clean -fd` spares
 * ignored files, that `merge --ff-only` refuses a diverged branch — and a fake
 * would only prove that this file and `operations.ts` agree with each other.
 *
 * `git` is on the path on both CI runners, which is stated in the contract §7.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommitSha } from "@nightshift/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  addWorktree,
  baseRef,
  changedPaths,
  checkpointRef,
  cleanCheckout,
  currentBranch,
  fastForward,
  isDirty,
  jobBranch,
  removeWorktree,
  revParse,
  sealedRef,
  snapshotCommit,
  tryRevParse,
  updateRef,
} from "./operations.js";
import { GitError, git, nodeGitRunner } from "./runner.js";

const AT = Date.parse("2026-09-15T12:00:00.000Z");
const PROGRAM_BRANCH = "program/test";

const made: string[] = [];
afterEach(async () => {
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** A repository with one commit on a program branch, and a `.gitignore`. */
const repository = async (): Promise<{ readonly repo: string; readonly base: CommitSha }> => {
  const root = await mkdtemp(join(tmpdir(), "nightshift-git-"));
  made.push(root);
  const repo = join(root, "repo");
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(join(repo, ".gitignore"), "ignored/\n", "utf8");
  await writeFile(join(repo, "src", "a.ts"), "export const a = 1;\n", "utf8");
  await writeFile(join(repo, "README.md"), "# fixture\n", "utf8");

  const run = (args: readonly string[]) => git(nodeGitRunner, args, { cwd: repo, atMs: AT });
  await run(["init", "--initial-branch=main"]);
  await run(["add", "-A"]);
  await run(["commit", "-m", "initial"]);
  await run(["checkout", "-b", PROGRAM_BRANCH]);
  return { repo, base: await revParse(nodeGitRunner, repo, "HEAD") };
};

describe("the runner", () => {
  it("authors as Nightshift, whatever the machine's git config says", async () => {
    const { repo } = await repository();
    const author = await git(nodeGitRunner, ["log", "-1", "--format=%an <%ae>"], { cwd: repo });
    expect(author.trim()).toBe("Nightshift <nightshift@nightshift.invalid>");
  });

  it("stamps the commit at the time it was given, so a snapshot is deterministic", async () => {
    const { repo } = await repository();
    const at = await git(nodeGitRunner, ["log", "-1", "--format=%aI"], { cwd: repo });
    expect(Date.parse(at.trim())).toBe(AT);
  });

  it("throws a GitError naming the command and what git said", async () => {
    const { repo } = await repository();
    const failure = await git(nodeGitRunner, ["rev-parse", "no-such-ref"], { cwd: repo }).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(GitError);
    expect((failure as GitError).message).toContain("rev-parse");
  });

  it("answers undefined for a revision that does not resolve", async () => {
    const { repo, base } = await repository();
    expect(await tryRevParse(nodeGitRunner, repo, "HEAD")).toBe(base);
    expect(await tryRevParse(nodeGitRunner, repo, "refs/nope")).toBeUndefined();
  });
});

describe("the working tree", () => {
  it("reports the branch and a clean tree", async () => {
    const { repo } = await repository();
    expect(await currentBranch(nodeGitRunner, repo)).toBe(PROGRAM_BRANCH);
    expect(await isDirty(nodeGitRunner, repo)).toBe(false);
  });

  it("counts an untracked file as dirty", async () => {
    const { repo } = await repository();
    await writeFile(join(repo, "scratch.txt"), "notes\n", "utf8");
    // Integration fast-forwards the operator's checkout. A fast-forward over an
    // untracked file the incoming commit also adds fails halfway, so an
    // untracked file has to count.
    expect(await isDirty(nodeGitRunner, repo)).toBe(true);
  });

  it("does not count an ignored file as dirty", async () => {
    const { repo } = await repository();
    await mkdir(join(repo, "ignored"), { recursive: true });
    await writeFile(join(repo, "ignored", "cache"), "x", "utf8");
    expect(await isDirty(nodeGitRunner, repo)).toBe(false);
  });
});

describe("worktrees", () => {
  it("creates one on its own branch at the base, and removes it with its refs", async () => {
    const { repo, base } = await repository();
    const path = join(repo, "..", "wt");
    const branch = jobBranch("run_a", "node_b");

    await addWorktree(nodeGitRunner, { repo, path, branch, base });
    await updateRef(nodeGitRunner, repo, baseRef("node_b"), base);

    expect(await revParse(nodeGitRunner, path, "HEAD")).toBe(base);
    expect(await currentBranch(nodeGitRunner, path)).toBe(branch);
    expect(await readFile(join(path, "src", "a.ts"), "utf8")).toContain("export const a");
    // The base is readable from inside the worktree, which is how the snapshot
    // finds its parent.
    expect(await revParse(nodeGitRunner, path, baseRef("node_b"))).toBe(base);

    await removeWorktree(nodeGitRunner, repo, path, branch, "node_b");
    expect(await tryRevParse(nodeGitRunner, repo, branch)).toBeUndefined();
    expect(await tryRevParse(nodeGitRunner, repo, baseRef("node_b"))).toBeUndefined();
  });
});

describe("the snapshot commit", () => {
  const worktreeAt = async (repo: string, base: CommitSha) => {
    const path = join(repo, "..", "wt-snapshot");
    const branch = jobBranch("run_a", "node_c");
    await addWorktree(nodeGitRunner, { repo, path, branch, base });
    return path;
  };

  const snapshot = (worktree: string, base: CommitSha) =>
    snapshotCommit(nodeGitRunner, {
      worktree,
      base,
      message: "the worker's summary",
      trailers: {
        "Nightshift-Run": "run_a",
        "Nightshift-Node": "node_c",
        "Nightshift-Job": "job_d",
      },
      atMs: AT,
    });

  it("collects an edit, an addition and a deletion into one commit on the base", async () => {
    const { repo, base } = await repository();
    const worktree = await worktreeAt(repo, base);
    await writeFile(join(worktree, "src", "a.ts"), "export const a = 2;\n", "utf8");
    await writeFile(join(worktree, "src", "b.ts"), "export const b = 3;\n", "utf8");
    await rm(join(worktree, "README.md"));

    const sha = await snapshot(worktree, base);
    expect(await revParse(nodeGitRunner, worktree, `${sha}^`)).toBe(base);
    expect([...(await changedPaths(nodeGitRunner, worktree, base, sha))].sort()).toEqual([
      "README.md",
      "src/a.ts",
      "src/b.ts",
    ]);
  });

  /**
   * The behaviour `reset --soft` buys. A worker that committed its own work
   * three times still yields one commit parented on the base, carrying the tree
   * it left — its commit messages are its working notes, and Nightshift is the
   * author of record.
   */
  it("squashes commits the worker made into one, keeping the tree", async () => {
    const { repo, base } = await repository();
    const worktree = await worktreeAt(repo, base);
    const run = (args: readonly string[]) => git(nodeGitRunner, args, { cwd: worktree, atMs: AT });

    await writeFile(join(worktree, "src", "a.ts"), "step one\n", "utf8");
    await run(["add", "-A"]);
    await run(["commit", "-m", "worker: step one"]);
    await writeFile(join(worktree, "src", "b.ts"), "step two\n", "utf8");
    await run(["add", "-A"]);
    await run(["commit", "-m", "worker: step two"]);
    // And something left unstaged when it stopped.
    await writeFile(join(worktree, "src", "c.ts"), "step three\n", "utf8");

    const sha = await snapshot(worktree, base);
    const log = await git(nodeGitRunner, ["log", "--format=%s", `${base}..${sha}`], {
      cwd: worktree,
    });
    expect(log.trim().split("\n")).toEqual(["the worker's summary"]);
    expect([...(await changedPaths(nodeGitRunner, worktree, base, sha))].sort()).toEqual([
      "src/a.ts",
      "src/b.ts",
      "src/c.ts",
    ]);
    expect(await readFile(join(worktree, "src", "c.ts"), "utf8")).toBe("step three\n");
  });

  it("carries the run, node and job trailers", async () => {
    const { repo, base } = await repository();
    const worktree = await worktreeAt(repo, base);
    await writeFile(join(worktree, "src", "a.ts"), "changed\n", "utf8");
    const sha = await snapshot(worktree, base);

    const body = await git(nodeGitRunner, ["log", "-1", "--format=%B", sha], { cwd: worktree });
    expect(body).toContain("Nightshift-Run: run_a");
    expect(body).toContain("Nightshift-Node: node_c");
    expect(body).toContain("Nightshift-Job: job_d");
    expect(
      await git(nodeGitRunner, ["log", "-1", "--format=%an", sha], { cwd: worktree }),
    ).toContain("Nightshift");
  });

  /** A worker that correctly concluded nothing needed changing has done its job. */
  it("allows an empty snapshot", async () => {
    const { repo, base } = await repository();
    const worktree = await worktreeAt(repo, base);
    const sha = await snapshot(worktree, base);
    expect(await changedPaths(nodeGitRunner, worktree, base, sha)).toEqual([]);
    expect(sha).not.toBe(base);
  });

  it("does not report a rename as a rename, so a move out of scope is visible", async () => {
    const { repo, base } = await repository();
    const worktree = await worktreeAt(repo, base);
    await mkdir(join(worktree, "vendor"), { recursive: true });
    await writeFile(join(worktree, "vendor", "a.ts"), "export const a = 1;\n", "utf8");
    await rm(join(worktree, "src", "a.ts"));

    const sha = await snapshot(worktree, base);
    const paths = await changedPaths(nodeGitRunner, worktree, base, sha);
    // Both halves, so the scope check sees the destination.
    expect([...paths].sort()).toEqual(["src/a.ts", "vendor/a.ts"]);
  });

  it("handles a path with a space, which is why the diff is NUL-separated", async () => {
    const { repo, base } = await repository();
    const worktree = await worktreeAt(repo, base);
    await writeFile(join(worktree, "src", "a file.ts"), "x\n", "utf8");
    const sha = await snapshot(worktree, base);
    expect(await changedPaths(nodeGitRunner, worktree, base, sha)).toEqual(["src/a file.ts"]);
  });
});

describe("the clean checkout before verification", () => {
  it("discards what the worker left and restores exactly the commit", async () => {
    const { repo, base } = await repository();
    const worktree = join(repo, "..", "wt-clean");
    await addWorktree(nodeGitRunner, {
      repo,
      path: worktree,
      branch: jobBranch("run_a", "node_e"),
      base,
    });
    await writeFile(join(worktree, "src", "a.ts"), "committed\n", "utf8");
    const sha = await snapshotCommit(nodeGitRunner, {
      worktree,
      base,
      message: "done",
      trailers: {},
      atMs: AT,
    });

    // Everything a worker might leave behind after its commit.
    await writeFile(join(worktree, "src", "a.ts"), "uncommitted edit\n", "utf8");
    await writeFile(join(worktree, "src", "stray.ts"), "untracked\n", "utf8");
    await mkdir(join(worktree, "ignored"), { recursive: true });
    await writeFile(join(worktree, "ignored", "cache"), "expensive\n", "utf8");

    await cleanCheckout(nodeGitRunner, worktree, sha);

    expect(await readFile(join(worktree, "src", "a.ts"), "utf8")).toBe("committed\n");
    await expect(readFile(join(worktree, "src", "stray.ts"), "utf8")).rejects.toThrow();
    // Ignored files survive: `clean -fd` without `-x`, so dependencies stay
    // installed and verification needs no reinstall.
    expect(await readFile(join(worktree, "ignored", "cache"), "utf8")).toBe("expensive\n");
    expect(await isDirty(nodeGitRunner, worktree)).toBe(false);
  });
});

describe("sealing, integrating and checkpointing", () => {
  it("fast-forwards the program branch onto a verified commit", async () => {
    const { repo, base } = await repository();
    const worktree = join(repo, "..", "wt-integrate");
    const branch = jobBranch("run_a", "node_f");
    await addWorktree(nodeGitRunner, { repo, path: worktree, branch, base });
    await writeFile(join(worktree, "src", "a.ts"), "verified\n", "utf8");
    const sha = await snapshotCommit(nodeGitRunner, {
      worktree,
      base,
      message: "done",
      trailers: {},
      atMs: AT,
    });

    await updateRef(nodeGitRunner, repo, sealedRef("node_f"), sha);
    const merged = await fastForward(nodeGitRunner, repo, sha, AT);

    expect(merged.ok).toBe(true);
    expect(await revParse(nodeGitRunner, repo, PROGRAM_BRANCH)).toBe(sha);
    // The operator's working tree moved with the branch, and only that way.
    expect(await readFile(join(repo, "src", "a.ts"), "utf8")).toBe("verified\n");
    expect(await isDirty(nodeGitRunner, repo)).toBe(false);

    await updateRef(nodeGitRunner, repo, checkpointRef("ckpt_1"), sha);
    expect(await revParse(nodeGitRunner, repo, checkpointRef("ckpt_1"))).toBe(sha);
  });

  /** The whole of `--ff-only`: a moved base is refused, never merged. */
  it("refuses a fast-forward when the program branch has moved", async () => {
    const { repo, base } = await repository();
    const worktree = join(repo, "..", "wt-stale");
    await addWorktree(nodeGitRunner, {
      repo,
      path: worktree,
      branch: jobBranch("run_a", "node_g"),
      base,
    });
    await writeFile(join(worktree, "src", "a.ts"), "the job's work\n", "utf8");
    const sha = await snapshotCommit(nodeGitRunner, {
      worktree,
      base,
      message: "done",
      trailers: {},
      atMs: AT,
    });

    // Someone else commits to the program branch in the meantime.
    await writeFile(join(repo, "src", "other.ts"), "someone else\n", "utf8");
    await git(nodeGitRunner, ["add", "-A"], { cwd: repo, atMs: AT });
    await git(nodeGitRunner, ["commit", "-m", "meanwhile"], { cwd: repo, atMs: AT });
    const moved = await revParse(nodeGitRunner, repo, PROGRAM_BRANCH);

    const merged = await fastForward(nodeGitRunner, repo, sha, AT);
    expect(merged.ok).toBe(false);
    expect(merged.detail.toLowerCase()).toContain("not possible to fast-forward");
    // Nothing happened: no merge commit, no moved branch.
    expect(await revParse(nodeGitRunner, repo, PROGRAM_BRANCH)).toBe(moved);
    // And the sealed commit is still there to be reconciled in P5.
    await updateRef(nodeGitRunner, repo, sealedRef("node_g"), sha);
    expect(await revParse(nodeGitRunner, repo, sealedRef("node_g"))).toBe(sha);
  });

  it("puts every Nightshift ref under refs/nightshift", () => {
    expect(sealedRef("node_x")).toBe("refs/nightshift/sealed/node_x");
    expect(checkpointRef("ckpt_x")).toBe("refs/nightshift/checkpoints/ckpt_x");
    expect(baseRef("node_x")).toBe("refs/nightshift/base/node_x");
  });
});
