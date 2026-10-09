/**
 * The git operations the lifecycle needs, each a thin function over `git`.
 *
 * The whole git model of D-P3-05 / A-29 is here:
 *
 * - a worktree per job, cut from the program branch head;
 * - one Nightshift-authored **snapshot commit** at completion, which squashes
 *   whatever the worker did into the tree it left behind;
 * - a **sealed** ref at the verified commit;
 * - **fast-forward only** integration into the program branch;
 * - a **checkpoint** ref at the integrated commit;
 * - and nothing is ever pushed.
 *
 * Nothing here decides anything. A caller supplies the commits and the paths;
 * these functions run the commands and report what happened.
 */
import type { CommitSha } from "@nightshift/contracts";
import { type GitOptions, type GitRunner, git, tryGit } from "./runner.js";

const trimmed = (value: string): string => value.trim();

/** A 40-character lowercase sha, parsed from `rev-parse` output. */
const asSha = (value: string): CommitSha => {
  const sha = trimmed(value);
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`expected a commit sha, got "${sha}"`);
  return sha as CommitSha;
};

export const revParse = async (
  runner: GitRunner,
  repo: string,
  revision: string,
): Promise<CommitSha> => asSha(await git(runner, ["rev-parse", revision], { cwd: repo }));

/** `undefined` when the revision does not resolve, rather than throwing. */
export const tryRevParse = async (
  runner: GitRunner,
  repo: string,
  revision: string,
): Promise<CommitSha | undefined> => {
  const result = await tryGit(runner, ["rev-parse", revision], { cwd: repo });
  return result.exitCode === 0 ? asSha(result.stdout) : undefined;
};

/**
 * The commits reachable from `to` and not from `from`, oldest first (P9,
 * D-P9-01): what landed after a decision's checkpoint.
 */
export const commitsSince = async (
  runner: GitRunner,
  repo: string,
  from: CommitSha,
  to: string,
): Promise<readonly CommitSha[]> =>
  (await git(runner, ["rev-list", "--reverse", `${from}..${to}`], { cwd: repo }))
    .split("\n")
    .map(trimmed)
    .filter((line) => line !== "")
    .map(asSha);

export const currentBranch = async (runner: GitRunner, repo: string): Promise<string> =>
  trimmed(await git(runner, ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repo }));

/**
 * Whether the working tree has uncommitted changes.
 *
 * Untracked files count. Integration fast-forwards the operator's checkout, and
 * a fast-forward over an untracked file that the incoming commit also adds fails
 * halfway, which is the worst of both outcomes.
 */
export const isDirty = async (runner: GitRunner, repo: string): Promise<boolean> =>
  // Every untracked file by name: by default git folds a new directory into one
  // line (`?? docs/`), which would hide what is in it.
  trimmed(await git(runner, ["status", "--porcelain", "--untracked-files=all"], { cwd: repo }))
    .split("\n")
    .some((line) => line.trim() !== "" && !isNightshiftReport(line));

/**
 * `nightshift run` writes `docs/programs/{id}/report.md` into the checkout (P7,
 * D-P7-03), and it is the one thing Nightshift leaves there. Untracked, it is
 * not the operator's work in progress and must not stop the next landing: found
 * when the first `nightshift resume` was refused by the report of the run it was
 * resuming. Only while **untracked** (`??`): once a human commits it, a change
 * to it is a change like any other.
 */
const NIGHTSHIFT_REPORT = /^\?\? "?docs\/programs\/[^/]+\/report\.md"?$/;
const isNightshiftReport = (porcelainLine: string): boolean =>
  NIGHTSHIFT_REPORT.test(porcelainLine.trimEnd());

export interface WorktreeInput {
  readonly repo: string;
  readonly path: string;
  readonly branch: string;
  readonly base: CommitSha;
}

/**
 * Worktree and ref changes to one repository, one at a time. Two jobs starting
 * together each add a worktree, and git rewrites `packed-refs` for both; on
 * Windows the second reads the file while the first is replacing it and fails
 * with "Permission denied" (seen under the full suite's load, 2026-10-04).
 * Serialising the writes per repository removes the race; a "Permission
 * denied" that still appears, from anything else holding the file, is retried
 * a few times before it is anyone's failure.
 */
const repoQueues = new Map<string, Promise<unknown>>();
const inRepoOrder = async <T>(repo: string, work: () => Promise<T>): Promise<T> => {
  const previous = repoQueues.get(repo) ?? Promise.resolve();
  const next = previous.then(work, work);
  repoQueues.set(
    repo,
    next.catch(() => undefined),
  );
  return next;
};
const PERMISSION_RETRIES = 4;
const retryingPermission = async <T>(work: () => Promise<T>): Promise<T> => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      const stderr = (error as { result?: { stderr?: string } }).result?.stderr ?? "";
      if (attempt >= PERMISSION_RETRIES || !/Permission denied|EPERM|EBUSY/.test(stderr))
        throw error;
      await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
    }
  }
};
const repoWrite = <T>(repo: string, work: () => Promise<T>): Promise<T> =>
  inRepoOrder(repo, () => retryingPermission(work));

/** Creates the worktree and its branch at `base`. */
export const addWorktree = async (runner: GitRunner, input: WorktreeInput): Promise<void> => {
  await repoWrite(input.repo, () =>
    git(runner, ["worktree", "add", "-b", input.branch, input.path, input.base], {
      cwd: input.repo,
    }),
  );
};

/**
 * A worktree on a **detached** `base`, with no branch: somewhere to read the
 * program from, for a sub-program's orchestrator (P6, D-P6-03). Nothing in it
 * is ever snapshotted, so it needs no branch to carry a commit.
 */
export const addDetachedWorktree = async (
  runner: GitRunner,
  input: Omit<WorktreeInput, "branch">,
): Promise<void> => {
  await repoWrite(input.repo, () =>
    git(runner, ["worktree", "add", "--detach", input.path, input.base], { cwd: input.repo }),
  );
};

/**
 * Removes a worktree and its branch, or says why it could not.
 *
 * Called once the work is sealed, so the commit stays reachable through
 * `refs/nightshift/sealed/<nodeId>` and deleting the branch loses nothing, and
 * by a launch that failed before any work existed. A worktree that was never
 * made, or whose directory is already gone, is forgotten and its branch freed.
 * One that is there and will not go is left whole, and the call throws with
 * git's own reason: a branch left behind silently is how a retry of the same
 * job later failed with "a branch named … already exists" and no cause (keki,
 * 2026-10-08).
 */
export const removeWorktree = async (
  runner: GitRunner,
  repo: string,
  path: string,
  branch: string,
  nodeId?: string,
): Promise<void> => {
  await repoWrite(repo, async () => {
    const removed = await tryGit(runner, ["worktree", "remove", "--force", path], { cwd: repo });
    if (removed.exitCode !== 0) await tryGit(runner, ["worktree", "prune"], { cwd: repo });
    const deleted = await tryGit(runner, ["branch", "-D", branch], { cwd: repo });
    if (nodeId !== undefined)
      await tryGit(runner, ["update-ref", "-d", baseRef(nodeId)], { cwd: repo });
    const left = await tryGit(
      runner,
      ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`],
      { cwd: repo },
    );
    if (left.exitCode === 0) {
      const why = [removed.stderr, deleted.stderr]
        .map((text) => text.trim())
        .filter((text) => text !== "")
        .join("; ");
      throw new Error(`could not remove the worktree at ${path} and its branch ${branch}: ${why}`);
    }
  });
};

/** Forgets worktrees whose directories are gone, so a stale entry cannot block a name. */
export const pruneWorktrees = async (runner: GitRunner, repo: string): Promise<void> => {
  await inRepoOrder(repo, () => tryGit(runner, ["worktree", "prune"], { cwd: repo }));
};

export interface SnapshotInput {
  readonly worktree: string;
  /** The commit the worktree was cut from. The snapshot's parent. */
  readonly base: CommitSha;
  readonly message: string;
  readonly trailers: Readonly<Record<string, string>>;
  readonly atMs: number;
}

/** The conventional limit for a git subject line. */
const SUBJECT_LIMIT = 72;

/**
 * Shapes a worker's completion summary into a commit message.
 *
 * Found at the exit gate (T10), and worth stating plainly because the scripted
 * harness could never have found it: a real model's summary is a **paragraph**,
 * and `git commit -m` treats everything before the first blank line as the
 * subject. The first integrated commit therefore carried a 700-character
 * subject line, which `git log --oneline`, every UI and every mail formatter
 * renders as a wall. Nightshift owns every commit (A-29), so the shape of one
 * is Nightshift's problem and not the worker's.
 *
 * Nothing is discarded. A summary that already has a subject and a body is left
 * exactly as written; one that does not gains a subject — its first sentence,
 * cut at a word boundary if that sentence is itself too long — and keeps the
 * whole original text as the body, so the worker's own account survives
 * verbatim under a line a human can read.
 */
export const commitMessageFor = (summary: string): string => {
  const text = summary.trim();
  if (text === "") return "a Nightshift snapshot with no summary";
  // An author who already wrote a subject and a body gets left alone.
  if (/\n\s*\n/.test(text)) return text;

  const oneLine = text.replace(/\s+/g, " ");
  if (oneLine.length <= SUBJECT_LIMIT) return oneLine;

  // The first sentence, when there is one that fits.
  const sentence = /^(.+?[.!?])(?:\s|$)/.exec(oneLine)?.[1];
  const subject =
    sentence !== undefined && sentence.length <= SUBJECT_LIMIT
      ? sentence
      : // Otherwise cut at the last word boundary that leaves room for the
        // ellipsis, so the subject never ends mid-word.
        `${oneLine.slice(0, SUBJECT_LIMIT - 1).replace(/\s+\S*$/, "")}\u2026`;

  return `${subject}\n\n${text}`;
};

/**
 * Collapses whatever is in the worktree into one commit on top of `base`.
 *
 * Three steps, and the middle one is the interesting one:
 *
 * 1. `add -A` stages the whole working tree, including deletions and untracked
 *    files.
 * 2. `reset --soft <base>` moves `HEAD` back to the base **without touching the
 *    index**, so any commits the worker made along the way disappear as commits
 *    while every change they contained stays staged. The snapshot is the *tree*
 *    the worker left, not its history — a worker's commit messages are its own
 *    working notes, and Nightshift is the author of record.
 * 3. `commit` writes that index as a single commit parented on the base.
 *
 * `--allow-empty` is deliberate: a worker that correctly concluded nothing
 * needed changing has done its job, and failing it for having produced no diff
 * would be punishing the right answer. The empty commit still carries the
 * trailers, so the node's result is addressable either way.
 */
export const snapshotCommit = async (
  runner: GitRunner,
  input: SnapshotInput,
): Promise<CommitSha> => {
  const options: GitOptions = { cwd: input.worktree, atMs: input.atMs };
  await git(runner, ["add", "-A"], options);
  await git(runner, ["reset", "--soft", input.base], options);

  const trailerArgs = Object.entries(input.trailers).flatMap(([key, value]) => [
    "--trailer",
    `${key}: ${value}`,
  ]);
  await git(
    runner,
    [
      "commit",
      "--allow-empty",
      // A target repository's hooks are someone else's arbitrary code, and this
      // commit is Nightshift's.
      "--no-verify",
      "-m",
      commitMessageFor(input.message),
      ...trailerArgs,
    ],
    options,
  );
  return revParse(runner, input.worktree, "HEAD");
};

/**
 * Repository-relative paths that differ between two commits.
 *
 * `--no-renames` on purpose: a file moved from inside the job's scope to outside
 * it must be reported as both a deletion and an addition, so the scope check
 * sees the destination. Reported as a rename, the out-of-scope destination would
 * be invisible.
 *
 * `-z` because a path may contain a space, a quote or a newline, and git's
 * default quoting would have to be parsed back.
 */
export const changedPaths = async (
  runner: GitRunner,
  worktree: string,
  from: CommitSha,
  to: CommitSha,
): Promise<readonly string[]> => {
  const output = await git(runner, ["diff", "--name-only", "--no-renames", "-z", from, to], {
    cwd: worktree,
  });
  return output.split("\0").filter((path) => path !== "");
};

/** Points `ref` at `sha`, creating it or moving it. */
export const updateRef = async (
  runner: GitRunner,
  repo: string,
  ref: string,
  sha: CommitSha,
): Promise<void> => {
  await repoWrite(repo, () => git(runner, ["update-ref", ref, sha], { cwd: repo }));
};

export interface FastForwardResult {
  readonly ok: boolean;
  readonly detail: string;
}

/**
 * Fast-forwards the checked-out branch onto `sha`.
 *
 * `--ff-only` is the whole guarantee: a program branch that has moved since the
 * worktree was cut cannot be merged, and the caller turns that into a durable
 * `stale_base` failure rather than a merge commit nobody asked for (D-P3-05).
 * Reconciling a moved base is P6.
 *
 * Returns rather than throws, because a non-fast-forward is an expected outcome
 * with its own node status, not an exception.
 */
export const fastForward = async (
  runner: GitRunner,
  repo: string,
  sha: CommitSha,
  atMs: number,
): Promise<FastForwardResult> => {
  const result = await tryGit(runner, ["merge", "--ff-only", sha], { cwd: repo, atMs });
  return result.exitCode === 0
    ? { ok: true, detail: trimmed(result.stdout) }
    : { ok: false, detail: trimmed(result.stderr) || trimmed(result.stdout) };
};

/**
 * Returns the worktree to `sha` for an agent to go on working in it.
 *
 * `clean -fd` without `-x`, so **ignored files survive**: `node_modules` and
 * build caches stay, and the agent starts with a usable checkout. This is a
 * workspace, not evidence. Verification never uses it: `pristineCheckout`
 * removes ignored files too.
 */
export const cleanCheckout = async (
  runner: GitRunner,
  worktree: string,
  sha: CommitSha,
): Promise<void> => {
  await git(runner, ["reset", "--hard", sha], { cwd: worktree });
  await git(runner, ["clean", "-fd"], { cwd: worktree });
};

/**
 * Returns the worktree to exactly `sha` and nothing else, ignored files
 * included, so that verification sees what a fresh clone of the commit holds.
 *
 * `clean -fdx`. Ignored files in a worker's worktree are whatever the worker,
 * or an earlier verification, left there: an install the commit does not
 * describe, a hand-run code generator's output, a build cache from another
 * mode. Any of them can make a check pass or fail for a reason the commit does
 * not contain. The playspace-time-reservations run on keki-backend
 * (2026-10-06) failed its build twelve times out of twelve in reused worker
 * worktrees and never in a fresh checkout of the same commits. The program's
 * `setup` makes the checkout usable again afterwards, and is cheap when the
 * lockfiles have not changed (D-P10-24). A file git cannot remove fails the
 * clean rather than surviving it.
 */
export const pristineCheckout = async (
  runner: GitRunner,
  worktree: string,
  sha: CommitSha,
): Promise<void> => {
  await git(runner, ["reset", "--hard", sha], { cwd: worktree });
  await git(runner, ["clean", "-fdx"], { cwd: worktree });
};

export type ReplayResult =
  | { readonly ok: true; readonly commitSha: CommitSha }
  | { readonly ok: false; readonly conflicts: readonly string[]; readonly detail: string };

export interface ReplayInput {
  readonly worktree: string;
  /** The snapshot to replay: one Nightshift-authored commit on the old base. */
  readonly commit: CommitSha;
  /** The program head it must now sit on. */
  readonly onto: CommitSha;
  readonly atMs: number;
}

/**
 * Replays one snapshot commit onto a moved program head (P6, D-P6-06).
 *
 * A cherry-pick, because a snapshot is exactly one commit and its message and
 * trailers are the worker's summary and Nightshift's provenance: both survive.
 * `Nightshift-Rebased-From` is added so the commit says what it was before.
 *
 * **A conflict is never resolved.** The pick is aborted, the worktree is put
 * back on the snapshot exactly as the worker left it, and the conflicting paths
 * are returned for an orchestrator to read. Nightshift picking a side would be
 * unverifiable intent.
 *
 * `--allow-empty --keep-redundant-commits`: a snapshot whose changes are already
 * upstream replays to an empty commit rather than an error, for the reason
 * `snapshotCommit` allows one.
 */
export const replayCommit = async (
  runner: GitRunner,
  input: ReplayInput,
): Promise<ReplayResult> => {
  const options: GitOptions = { cwd: input.worktree, atMs: input.atMs };
  await git(runner, ["reset", "--hard", input.onto], options);
  await git(runner, ["clean", "-fd"], options);

  const picked = await tryGit(
    runner,
    ["cherry-pick", "--allow-empty", "--keep-redundant-commits", input.commit],
    options,
  );
  if (picked.exitCode !== 0) {
    const unmerged = await tryGit(
      runner,
      ["diff", "--name-only", "--diff-filter=U", "-z"],
      options,
    );
    const conflicts = unmerged.stdout.split("\0").filter((path) => path !== "");
    await tryGit(runner, ["cherry-pick", "--abort"], options);
    await git(runner, ["reset", "--hard", input.commit], options);
    await git(runner, ["clean", "-fd"], options);
    return { ok: false, conflicts, detail: trimmed(picked.stderr) || trimmed(picked.stdout) };
  }

  await git(
    runner,
    [
      "commit",
      "--amend",
      "--allow-empty",
      "--no-verify",
      "--no-edit",
      "--trailer",
      `Nightshift-Rebased-From: ${input.commit}`,
    ],
    options,
  );
  return { ok: true, commitSha: await revParse(runner, input.worktree, "HEAD") };
};

/** The refs D-P3-05 names, plus the base ref. One place, so a reader finds them all. */
export const sealedRef = (nodeId: string): string => `refs/nightshift/sealed/${nodeId}`;

/**
 * The commit a job's worktree was cut from.
 *
 * Written when the worktree is created and read when the snapshot is taken, so
 * "what was the base?" is answered by a ref in the repository rather than by
 * inferring it from a branch's reflog or by trusting a value carried through
 * three processes. A worker that commits, amends and resets three times does not
 * move it, and a server that died and restarted can still find it.
 *
 * Under `refs/nightshift/` with the sealed and checkpoint refs, and cleaned up
 * with the worktree.
 */
export const baseRef = (nodeId: string): string => `refs/nightshift/base/${nodeId}`;
export const checkpointRef = (checkpointId: string): string =>
  `refs/nightshift/checkpoints/${checkpointId}`;
/** The branch a job's worktree sits on. */
export const jobBranch = (runId: string, nodeId: string): string => `nightshift/${runId}/${nodeId}`;

/**
 * The run's **provisional line** (P7, D-P7-10): where work lands whose checks
 * could not all run, and everything built on it. Never the program branch, which
 * still receives nothing that has not passed every check on the commit that
 * lands (A-05).
 */
export const provisionalRef = (runId: string): string => `refs/nightshift/provisional/${runId}`;

/** The provisional line's head, or `undefined` while nothing has been deferred. */
export const provisionalHead = (
  runner: GitRunner,
  repo: string,
  runId: string,
): Promise<CommitSha | undefined> => tryRevParse(runner, repo, provisionalRef(runId));

/**
 * What new work is cut from and reconciled onto: the provisional head once
 * anything has been deferred, the program branch's until then.
 */
export const effectiveHead = async (
  runner: GitRunner,
  repo: string,
  programBranch: string,
  runId: string,
): Promise<{ readonly head: CommitSha; readonly provisional: boolean }> => {
  const provisional = await provisionalHead(runner, repo, runId);
  return provisional === undefined
    ? { head: await revParse(runner, repo, programBranch), provisional: false }
    : { head: provisional, provisional: true };
};

/** The commits on the provisional line that the program branch does not have, oldest first. */
export const provisionalCommits = async (
  runner: GitRunner,
  repo: string,
  programBranch: string,
  runId: string,
): Promise<readonly CommitSha[]> => {
  if ((await provisionalHead(runner, repo, runId)) === undefined) return [];
  const listed = await git(
    runner,
    ["rev-list", "--reverse", `${programBranch}..${provisionalRef(runId)}`],
    { cwd: repo },
  );
  return listed
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map(asSha);
};

export const deleteRef = async (runner: GitRunner, repo: string, ref: string): Promise<void> => {
  await git(runner, ["update-ref", "-d", ref], { cwd: repo });
};

/**
 * Where an attempt's unfinished work is kept: one commit on the base that
 * attempt was cut from, per node and attempt, never moved and never pushed.
 */
export const unfinishedRef = (nodeId: string, attempt: number): string =>
  `refs/nightshift/unfinished/${nodeId}/${attempt}`;

export interface UnfinishedWork {
  readonly commit: CommitSha;
  readonly base: CommitSha;
  readonly paths: readonly string[];
}

/**
 * The work an attempt left in its worktree without handing it in, as one commit
 * on its base, or `undefined` when there is none to keep.
 *
 * Handed-in work is not unfinished: when the worktree's `HEAD` is a snapshot
 * this node's `job.complete` made (it carries the node's trailer), the work was
 * delivered and judged, and a retry of it starts clean by design (a fix, a
 * ruling carried out). Everything else a worker left, tracked or not, is taken
 * the way a snapshot takes it, so nothing it wrote is lost to the retry.
 */
export const collectUnfinished = async (
  runner: GitRunner,
  input: {
    readonly worktree: string;
    readonly base: CommitSha;
    readonly nodeId: string;
    readonly attempt: number;
    readonly atMs: number;
  },
): Promise<UnfinishedWork | undefined> => {
  const options: GitOptions = { cwd: input.worktree, atMs: input.atMs };
  const handedIn = await tryGit(
    runner,
    ["log", "-1", "--format=%(trailers:key=Nightshift-Node,valueonly)", "HEAD"],
    options,
  );
  if (trimmed(handedIn.stdout) === input.nodeId) return undefined;
  const commit = await snapshotCommit(runner, {
    worktree: input.worktree,
    base: input.base,
    message: `Unfinished work of attempt ${input.attempt}, kept for the next`,
    trailers: { "Nightshift-Unfinished": `${input.nodeId} attempt ${input.attempt}` },
    atMs: input.atMs,
  });
  const paths = await changedPaths(runner, input.worktree, input.base, commit);
  return paths.length === 0 ? undefined : { commit, base: input.base, paths };
};

/** The whole of a piece of unfinished work as a patch, binary files included. */
export const unfinishedPatch = (
  runner: GitRunner,
  repo: string,
  work: UnfinishedWork,
): Promise<string> =>
  git(runner, ["diff", "--binary", "--no-color", "--no-ext-diff", work.base, work.commit], {
    cwd: repo,
  });

/**
 * Puts unfinished work into a fresh worktree as **uncommitted** changes on its
 * head, three-way, so a program head that has moved since is taken into
 * account. A conflict is never resolved here: the worktree goes back to its
 * head exactly, and the conflicting paths are returned for the next worker,
 * who has the code in front of it and the patch beside it.
 */
export const applyUnfinished = async (
  runner: GitRunner,
  worktree: string,
  commit: CommitSha,
  atMs: number,
): Promise<{ readonly applied: boolean; readonly conflicts: readonly string[] }> => {
  const options: GitOptions = { cwd: worktree, atMs };
  const picked = await tryGit(runner, ["cherry-pick", "--no-commit", commit], options);
  if (picked.exitCode === 0) {
    // Unstaged, so the worktree looks exactly like work in progress.
    await git(runner, ["reset", "-q"], options);
    return { applied: true, conflicts: [] };
  }
  const unmerged = await tryGit(runner, ["diff", "--name-only", "--diff-filter=U", "-z"], options);
  const conflicts = unmerged.stdout.split("\0").filter((path) => path !== "");
  await tryGit(runner, ["cherry-pick", "--abort"], options);
  await git(runner, ["reset", "--hard", "HEAD"], options);
  await git(runner, ["clean", "-fd"], options);
  return { applied: false, conflicts };
};
