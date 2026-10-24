/**
 * The program branch, made the same at GitHub as here (2026-10-13).
 *
 * A remote run's machine clones the program branch from GitHub, never from the
 * checkout, so a ratified plan is only dispatchable once its branch is there.
 * `nightshift run --remote` used to refuse until a human remembered to push,
 * and read `origin/<branch>` without fetching, so a branch pushed from another
 * machine still read as missing. The owner hit it on most runs.
 *
 * Here: fetch the branch first, so what origin has is what origin has now;
 * then push when origin lacks it or is behind, fast-forward only. Never force:
 * origin ahead of the checkout is a pull to make, and diverged history is a
 * human's to resolve, each refused with what to do.
 */
import {
  currentBranch,
  fastForward,
  type GitRunner,
  isDirty,
  tryGit,
  tryRevParse,
  updateRef,
} from "@nightshift/execution";
import { UsageError } from "./failures.js";

export interface PublishOptions {
  /** False to refuse rather than push, as `--no-push` asks. */
  readonly push: boolean;
  /** Told what was pushed. */
  readonly out: (line: string) => void;
}

export type BranchPublication =
  | { readonly kind: "in-step"; readonly head: string }
  | { readonly kind: "pushed"; readonly head: string; readonly from?: string };

const short = (sha: string): string => sha.slice(0, 12);

/** Whether `ancestor` is in `descendant`'s history. */
const isAncestor = async (
  runner: GitRunner,
  repo: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> =>
  (await tryGit(runner, ["merge-base", "--is-ancestor", ancestor, descendant], { cwd: repo }))
    .exitCode === 0;

/** Origin's head for `branch` as it is now, `undefined` when origin has no such branch. */
const fetchOrigin = async (
  runner: GitRunner,
  repo: string,
  branch: string,
): Promise<string | undefined> => {
  const fetched = await tryGit(
    runner,
    ["fetch", "--no-tags", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`],
    { cwd: repo },
  );
  if (fetched.exitCode !== 0) {
    if (/couldn't find remote ref|no such ref|not our ref/i.test(fetched.stderr)) return undefined;
    throw new UsageError(
      `could not ask origin about ${branch}: ${fetched.stderr.trim() || `git fetch exited ${fetched.exitCode}`}`,
      "Check the network and your GitHub access, then run it again.",
    );
  }
  return tryRevParse(runner, repo, `refs/remotes/origin/${branch}`);
};

/**
 * Makes origin's `branch` this checkout's, or says why it cannot. Returns the
 * head that is now at both.
 */
export const publishProgramBranch = async (
  runner: GitRunner,
  repo: string,
  branch: string,
  options: PublishOptions,
): Promise<BranchPublication> => {
  const head = await tryRevParse(runner, repo, branch);
  const origin = await fetchOrigin(runner, repo, branch);
  if (head === undefined) {
    throw new UsageError(
      `the program branch ${branch} does not exist in ${repo}`,
      origin === undefined
        ? "Commit the plan on it first."
        : `Origin has it at ${short(origin)}: \`git switch ${branch}\` to work from it.`,
    );
  }
  if (origin === head) return { kind: "in-step", head };

  const behind = origin === undefined || (await isAncestor(runner, repo, origin, head));
  if (!behind) {
    if (await isAncestor(runner, repo, head, origin)) {
      throw new UsageError(
        `${branch} is at ${short(head)} here and ${short(origin)} at origin, which is ahead`,
        `Pull it (\`git switch ${branch} && git pull --ff-only\`): origin has work this checkout does not.`,
      );
    }
    throw new UsageError(
      `${branch} has diverged: ${short(head)} here, ${short(origin as string)} at origin`,
      "Reconcile the two by hand; Nightshift never forces a push.",
    );
  }
  if (!options.push) {
    throw new UsageError(
      origin === undefined
        ? `${branch} has not been pushed: origin has no such branch`
        : `${branch} is at ${short(head)} here and ${short(origin)} at origin`,
      `Push it (\`git push -u origin ${branch}\`), or run without --no-push and Nightshift will.`,
    );
  }
  const pushed = await tryGit(runner, ["push", "--set-upstream", "origin", `${branch}:${branch}`], {
    cwd: repo,
  });
  if (pushed.exitCode !== 0) {
    throw new UsageError(
      `could not push ${branch} to origin: ${pushed.stderr.trim() || `git push exited ${pushed.exitCode}`}`,
      `Push it yourself (\`git push -u origin ${branch}\`) and run it again.`,
    );
  }
  options.out(
    origin === undefined
      ? `pushed ${branch} to origin at ${short(head)} (it was not there)`
      : `pushed ${branch} to origin: ${short(origin)} -> ${short(head)}`,
  );
  return origin === undefined ? { kind: "pushed", head } : { kind: "pushed", head, from: origin };
};

/**
 * Brings this checkout's `branch` up to origin's, fast-forward only, before
 * anything is built on it here: a remote run landed its work at GitHub, so a
 * resume that commits onto a stale local branch would make history GitHub
 * cannot take. Ahead of origin is fine (the next push carries it); diverged is
 * refused with what to do. Returns the local head afterwards, `undefined` when
 * neither side has the branch.
 */
export const followOrigin = async (
  runner: GitRunner,
  repo: string,
  branch: string,
  out: (line: string) => void,
): Promise<string | undefined> => {
  const origin = await fetchOrigin(runner, repo, branch);
  const local = await tryRevParse(runner, repo, branch);
  if (origin === undefined || local === origin) return local;
  if (local !== undefined && (await isAncestor(runner, repo, origin, local))) return local;
  if (local !== undefined && !(await isAncestor(runner, repo, local, origin))) {
    throw new UsageError(
      `${branch} has diverged: ${short(local)} here, ${short(origin)} at origin`,
      "Reconcile the two by hand; Nightshift never forces a push.",
    );
  }
  if ((await currentBranch(runner, repo).catch(() => undefined)) === branch) {
    if (await isDirty(runner, repo)) {
      throw new UsageError(
        `${branch} is checked out in ${repo} with uncommitted changes, and origin is ahead at ${short(origin)}`,
        `Commit or stash them, then run it again: ${branch} must take origin's work first.`,
      );
    }
    const moved = await fastForward(runner, repo, origin, Date.now());
    if (!moved.ok) {
      throw new UsageError(
        `could not bring ${branch} up to origin's ${short(origin)}: ${moved.detail}`,
      );
    }
  } else {
    await updateRef(runner, repo, `refs/heads/${branch}`, origin as never);
  }
  out(
    local === undefined
      ? `made ${branch} here at origin's ${short(origin)}`
      : `brought ${branch} up to origin: ${short(local)} -> ${short(origin)}`,
  );
  return origin;
};

export type BranchEnsured =
  | { readonly kind: "present" }
  | { readonly kind: "created"; readonly head: string; readonly from: string }
  | { readonly kind: "tracked"; readonly head: string };

/**
 * Makes the program branch exist, here and at origin, so no plan file has to
 * have created it. Origin's is fetched first. Neither side has it: it is made
 * at the head of origin's `baseBranch` (the local one when origin has none) with
 * no checkout, and pushed with upstream. Origin has it and this checkout does
 * not: the local branch is made at origin's head, tracking it. Otherwise
 * nothing; {@link publishProgramBranch}'s checks are the next word.
 */
export const ensureProgramBranch = async (
  runner: GitRunner,
  repo: string,
  branch: string,
  baseBranch: string,
  options: PublishOptions,
): Promise<BranchEnsured> => {
  const origin = await fetchOrigin(runner, repo, branch);
  const local = await tryRevParse(runner, repo, branch);
  if (local !== undefined) return { kind: "present" };
  if (origin !== undefined) {
    const tracked = await tryGit(
      runner,
      ["branch", "--track", branch, `refs/remotes/origin/${branch}`],
      { cwd: repo },
    );
    if (tracked.exitCode !== 0) {
      throw new UsageError(
        `could not make ${branch} from origin's: ${tracked.stderr.trim() || `git branch exited ${tracked.exitCode}`}`,
        `Run \`git branch --track ${branch} origin/${branch}\` and look at what it says.`,
      );
    }
    options.out(`made ${branch} here at origin's ${short(origin)}, tracking it`);
    return { kind: "tracked", head: origin };
  }

  if (!options.push) {
    throw new UsageError(
      `${branch} exists neither here nor at origin, and --no-push forbids pushing the one this run would make`,
      `Create and push it from ${baseBranch} (\`git branch ${branch} ${baseBranch} && git push -u origin ${branch}\`), or run without --no-push and Nightshift will.`,
    );
  }
  const base =
    (await fetchOrigin(runner, repo, baseBranch)) ?? (await tryRevParse(runner, repo, baseBranch));
  if (base === undefined) {
    throw new UsageError(
      `${branch} does not exist and its base ${baseBranch} exists neither here nor at origin`,
      `Check repository.baseBranch in the plan, and that origin has ${baseBranch}.`,
    );
  }
  const made = await tryGit(runner, ["branch", "--no-track", branch, base], { cwd: repo });
  if (made.exitCode !== 0) {
    throw new UsageError(
      `could not create ${branch}: ${made.stderr.trim() || `git branch exited ${made.exitCode}`}`,
    );
  }
  const pushed = await tryGit(runner, ["push", "--set-upstream", "origin", `${branch}:${branch}`], {
    cwd: repo,
  });
  if (pushed.exitCode !== 0) {
    await tryGit(runner, ["branch", "-D", branch], { cwd: repo });
    throw new UsageError(
      `could not push ${branch} to origin: ${pushed.stderr.trim() || `git push exited ${pushed.exitCode}`}`,
      `Push it yourself (\`git push -u origin ${branch}\`) and run it again.`,
    );
  }
  options.out(
    `created ${branch} at ${short(base)}, the head of ${baseBranch}, and pushed it to origin`,
  );
  return { kind: "created", head: base, from: baseBranch };
};

/**
 * A local run works on the program branch: checks it out, refusing, with the
 * reason, when the working tree is dirty and it is not already out.
 */
export const checkOutProgramBranch = async (
  runner: GitRunner,
  repo: string,
  branch: string,
): Promise<void> => {
  if ((await currentBranch(runner, repo)) === branch) return;
  if (await isDirty(runner, repo)) {
    throw new UsageError(
      `the working tree in ${repo} has uncommitted changes, so ${branch} cannot be checked out`,
      `Commit or stash them, or \`git switch ${branch}\` yourself, then run it again.`,
    );
  }
  const switched = await tryGit(runner, ["switch", branch], { cwd: repo });
  if (switched.exitCode !== 0) {
    throw new UsageError(
      `could not check out ${branch}: ${switched.stderr.trim() || `git switch exited ${switched.exitCode}`}`,
    );
  }
};
