/**
 * The real-git adapter of {@link LineCheckoutPort}: every worktree is a fresh
 * detached checkout in its own temporary directory, and every commit is made by
 * Nightshift's own identity (the runner carries it).
 */
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { CommitSha } from "@nightshift/contracts";
import { addDetachedWorktree } from "../git/operations.js";
import { type GitRunner, git, tryGit } from "../git/runner.js";
import type { LineCheckoutPort, LineMergeOutcome, LineWorktree } from "./ports.js";

export interface LineCheckoutOptions {
  runner: GitRunner;
  repo: string;
  /** Where the temporary worktree directories go; the system temp directory by default. */
  scratchDir?: string;
}

/** The temporary directory `open` made for a worktree: what a user must be granted to enter it. */
export const lineWorktreeRoot = (worktreePath: string): string => dirname(worktreePath);

const lines = (text: string): string[] =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");

export const createLineCheckout = (options: LineCheckoutOptions): LineCheckoutPort => {
  const { runner, repo } = options;
  const run = (wt: LineWorktree, args: readonly string[]) => git(runner, args, { cwd: wt.path });
  const attempt = (wt: LineWorktree, args: readonly string[]) =>
    tryGit(runner, args, { cwd: wt.path });
  const head = async (wt: LineWorktree): Promise<CommitSha> =>
    (await run(wt, ["rev-parse", "HEAD"])).trim();
  const conflicted = async (wt: LineWorktree): Promise<string[]> =>
    lines(await run(wt, ["diff", "--name-only", "--diff-filter=U"]));
  const mergeInProgress = async (wt: LineWorktree): Promise<boolean> =>
    (await attempt(wt, ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"])).exitCode === 0;
  const isAncestor = async (ancestor: CommitSha, descendant: CommitSha): Promise<boolean> => {
    const result = await tryGit(runner, ["merge-base", "--is-ancestor", ancestor, descendant], {
      cwd: repo,
    });
    if (result.exitCode === 0) return true;
    if (result.exitCode === 1) return false;
    throw new Error(`git merge-base --is-ancestor failed: ${result.stderr.trim()}`);
  };
  const tree = async (commit: CommitSha): Promise<string> =>
    (await git(runner, ["rev-parse", `${commit}^{tree}`], { cwd: repo })).trim();

  const startMerge: LineCheckoutPort["startMerge"] = async (wt, commit) => {
    const result = await attempt(wt, ["merge", "--no-commit", "--no-ff", commit]);
    if (result.exitCode === 0) return { kind: "clean" };
    const paths = await conflicted(wt);
    if (paths.length > 0) return { kind: "conflict", paths };
    // Refused for another reason (unrelated histories, a dirty tree): not a conflict.
    await attempt(wt, ["merge", "--abort"]);
    throw new Error(`git merge ${commit} failed: ${(result.stderr || result.stdout).trim()}`);
  };

  return {
    async open(base) {
      const root = await mkdtemp(join(options.scratchDir ?? tmpdir(), "nightshift-line-"));
      // mkdtemp makes the root 0700. On a machine the root is handed to the
      // project user for the checks and the repairs (D-P10-30), and the engine,
      // which only shares its group, must still enter it to spawn them: the
      // line's first trial failed every landing check with `spawn sudo EACCES`
      // (2026-10-29). Group rwx with setgid, as the workspace's directories are.
      if (process.platform !== "win32") await chmod(root, 0o2770);
      const path = join(root, "wt");
      try {
        await addDetachedWorktree(runner, { repo, path, base });
      } catch (error) {
        await rm(root, { recursive: true, force: true });
        throw error;
      }
      return { path };
    },

    async merge(wt, commit, message): Promise<LineMergeOutcome> {
      const previous = await head(wt);
      if (await isAncestor(commit, previous)) return { kind: "merged", head: previous };
      const result = await attempt(wt, ["merge", "--no-ff", "-m", message, commit]);
      if (result.exitCode === 0) return { kind: "merged", head: await head(wt) };
      const paths = await conflicted(wt);
      const detail = (result.stdout + result.stderr).trim();
      await attempt(wt, ["merge", "--abort"]);
      // Whatever the abort left (it should be nothing), the contract is a clean tree at the old head.
      await run(wt, ["reset", "--hard", previous]);
      await run(wt, ["clean", "-fd"]);
      if (paths.length === 0) throw new Error(`git merge ${commit} failed: ${detail}`);
      return { kind: "conflict", paths, detail };
    },

    startMerge,

    async commitMerge(wt, message) {
      if (!(await mergeInProgress(wt))) throw new Error("no merge is in progress");
      const previous = await head(wt);
      await run(wt, ["add", "-A"]);
      const unresolved = await conflicted(wt);
      if (unresolved.length > 0)
        throw new Error(`unresolved conflicts remain in: ${unresolved.join(", ")}`);
      // `add -A` resolves a path whose markers are still in its content, so look at the content too.
      const markers = await attempt(wt, ["diff", "--cached", "--check"]);
      if (markers.exitCode !== 0 && /conflict marker/i.test(markers.stdout))
        throw new Error(`conflict markers are left in the files:\n${markers.stdout.trim()}`);
      await run(wt, ["commit", "--no-verify", "-m", message]);
      const made = await head(wt);
      if (made === previous) throw new Error("the merge produced no commit");
      return made;
    },

    async conflictCandidate(wt, commit, message) {
      const previous = await head(wt);
      const started = await attempt(wt, ["merge", "--no-commit", "--no-ff", commit]);
      if (!(await mergeInProgress(wt))) {
        throw new Error(
          `git merge ${commit} did not start: ${(started.stderr || started.stdout).trim()}`,
        );
      }
      try {
        // The markers stay in the conflicting paths: they are committed as they are.
        await run(wt, ["add", "-A"]);
        await run(wt, ["commit", "--no-verify", "-m", message]);
        return await head(wt);
      } finally {
        await run(wt, ["reset", "--hard", previous]);
        await run(wt, ["clean", "-fd"]);
      }
    },

    async changedPaths(from, upTo, lineHead) {
      let base = from;
      if (base === undefined && lineHead !== undefined) {
        const found = await tryGit(runner, ["merge-base", lineHead, upTo], { cwd: repo });
        if (found.exitCode === 0) base = found.stdout.trim();
      }
      const args =
        base === undefined
          ? ["diff-tree", "-r", "--root", "--no-commit-id", "--name-only", upTo]
          : ["diff", "--name-only", `${base}..${upTo}`];
      return lines(await git(runner, args, { cwd: repo }));
    },

    head,
    isAncestor,

    async hasCommit(commit) {
      const result = await tryGit(runner, ["cat-file", "-e", `${commit}^{commit}`], { cwd: repo });
      return result.exitCode === 0;
    },

    async sameTree(a, b) {
      return (await tree(a)) === (await tree(b));
    },

    async close(wt) {
      await tryGit(runner, ["worktree", "remove", "--force", wt.path], { cwd: repo });
      await git(runner, ["worktree", "prune"], { cwd: repo });
      await rm(dirname(wt.path), { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
    },
  };
};
