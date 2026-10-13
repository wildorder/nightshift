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
import { type GitRunner, tryGit, tryRevParse } from "@nightshift/execution";
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
