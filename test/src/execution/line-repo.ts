/**
 * A real git repository for the line composition engine's tests: an initial
 * commit on `main`, a `line` branch and program branches, with helpers to commit
 * files on a branch and to read a file at a commit.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type CommitSha, VerificationIdSchema } from "@nightshift/contracts";
import { createCountingIdGenerator, createFixedClock, nowIso } from "@nightshift/core";
import {
  createLineCheckout,
  git,
  type LineCheckoutPort,
  type LineVerifierPort,
  nodeGitRunner,
} from "@nightshift/execution";

const AT_MS = Date.parse("2026-10-01T00:00:00.000Z");

export const LINE_BRANCH = "line";

export interface LineRepo {
  readonly repo: string;
  readonly root: string;
  /** The initial commit, on `main`, the line and every program branch start here. */
  readonly initial: CommitSha;
  /** Commits `files` (a null content deletes the path) on `branch`, creating it from the initial commit if absent. */
  commit(
    branch: string,
    files: Readonly<Record<string, string | null>>,
    message?: string,
  ): Promise<CommitSha>;
  /** The head of a branch. */
  tip(branch: string): Promise<CommitSha>;
  /** A file's content AT a commit (git show), or undefined when it is not there. */
  readFileAtCommit(commit: CommitSha, path: string): Promise<string | undefined>;
  checkout(): LineCheckoutPort;
  close(): Promise<void>;
}

export const createLineRepo = async (
  options: { programs?: readonly string[] } = {},
): Promise<LineRepo> => {
  const root = await mkdtemp(join(tmpdir(), "nightshift-line-repo-"));
  const repo = join(root, "repo");
  await mkdir(repo, { recursive: true });
  const run = (args: readonly string[]) =>
    git(nodeGitRunner, args, { cwd: repo, atMs: AT_MS }).then((out) => out.trim());
  await run(["init", "--initial-branch=main"]);
  await writeFile(join(repo, "README.md"), "# fixture\n", "utf8");
  await run(["add", "-A"]);
  await run(["commit", "-m", "the initial commit"]);
  const initial = await run(["rev-parse", "HEAD"]);
  for (const branch of [LINE_BRANCH, ...(options.programs ?? [])]) await run(["branch", branch]);

  // Commits are made in a scratch worktree so the repository's own checkout never moves.
  const tip = (branch: string) => run(["rev-parse", `refs/heads/${branch}`]);
  const commit: LineRepo["commit"] = async (branch, files, message = `edit ${branch}`) => {
    const exists = await git(
      nodeGitRunner,
      ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`],
      {
        cwd: repo,
      },
    ).then(
      () => true,
      () => false,
    );
    if (!exists) await run(["branch", branch, initial]);
    const dir = await mkdtemp(join(root, "commit-"));
    const wt = join(dir, "wt");
    try {
      await run(["worktree", "add", "--detach", wt, branch]);
      const inWt = (args: readonly string[]) => git(nodeGitRunner, args, { cwd: wt, atMs: AT_MS });
      for (const [path, content] of Object.entries(files)) {
        if (content === null) {
          await rm(join(wt, path), { force: true });
        } else {
          await mkdir(dirname(join(wt, path)), { recursive: true });
          await writeFile(join(wt, path), content, "utf8");
        }
      }
      await inWt(["add", "-A"]);
      await inWt(["commit", "-m", message]);
      const made = (await inWt(["rev-parse", "HEAD"])).trim();
      await run(["update-ref", `refs/heads/${branch}`, made]);
      return made;
    } finally {
      await run(["worktree", "remove", "--force", wt]).catch(() => undefined);
      await rm(dir, { recursive: true, force: true });
    }
  };

  return {
    repo,
    root,
    initial,
    commit,
    tip,
    async readFileAtCommit(sha, path) {
      const result = await nodeGitRunner(["show", `${sha}:${path}`], { cwd: repo });
      return result.exitCode === 0 ? result.stdout : undefined;
    },
    checkout: () => createLineCheckout({ runner: nodeGitRunner, repo, scratchDir: root }),
    close: () => rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }),
  };
};

/**
 * A verifier that decides from a commit's content alone: `passes` gets the
 * commit and a reader of files AT that commit, never a worktree's files. Its
 * results are schema-valid line verifications with one log and timedOut false.
 */
export const makeFakeVerifier = (
  repo: Pick<LineRepo, "readFileAtCommit">,
  passes: (
    commit: CommitSha,
    readFileAtCommit: (path: string) => Promise<string | undefined>,
  ) => boolean | Promise<boolean>,
): LineVerifierPort => {
  const ids = createCountingIdGenerator();
  const clock = createFixedClock(AT_MS);
  return {
    async verify({ commit, base }) {
      const ok = await passes(commit, (path) => repo.readFileAtCommit(commit, path));
      const at = nowIso(clock);
      return {
        verification: {
          verificationId: VerificationIdSchema.parse(ids.next("ver")),
          phase: "line",
          commitSha: commit,
          baseSha: base,
          commands: [
            { stepId: "fake", command: "fake verify", exitCode: ok ? 0 : 1, durationMs: 0 },
          ],
          outcome: ok ? "passed" : "failed",
          startedAt: at,
          endedAt: at,
        },
        logs: [
          { stepId: "fake", command: "fake verify", exitCode: ok ? 0 : 1, tail: ok ? "ok" : "red" },
        ],
        timedOut: false,
      };
    },
  };
};
