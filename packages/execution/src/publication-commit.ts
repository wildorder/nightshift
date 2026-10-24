/**
 * The one commit a finished planned run adds to its program branch (P21, D-03):
 * the program's contract, plan, conversation and report, in `docs/programs/{name}/`,
 * as history. Not verified; so it is built in a temporary worktree, its actual
 * diff is held to `publicationPathsAllowed`, and only then does the branch move.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { CommitSha } from "@nightshift/contracts";
import {
  PUBLICATION_FILES,
  type PublicationFile,
  publicationDirectory,
  publicationPathsAllowed,
} from "@nightshift/core";
import {
  addDetachedWorktree,
  changedPaths,
  currentBranch,
  fastForward,
  removeWorktree,
  revParse,
  updateRef,
} from "./git/operations.js";
import { type GitRunner, git, tryGit } from "./git/runner.js";

export interface PublicationCommitInput {
  readonly repo: string;
  readonly programBranch: string;
  /** The program's name on the plane: its directory under `docs/programs/`. */
  readonly name: string;
  /** What to write; the conversation only when the contract names one. */
  readonly files: Partial<Record<PublicationFile, string>>;
  readonly message: string;
  readonly atMs?: number;
}

export type PublicationCommit =
  | { readonly published: true; readonly head: CommitSha; readonly previous: CommitSha }
  | { readonly published: false; readonly head: CommitSha };

export class PublicationRefusedError extends Error {
  constructor(
    readonly paths: readonly string[],
    detail: string,
  ) {
    super(`the publication commit was refused: ${detail}`);
    this.name = "PublicationRefusedError";
  }
}

/**
 * Commits exactly the given files onto the program branch and moves the branch
 * to the commit. A commit whose diff is empty (the same files already there)
 * adds nothing. Anything outside the four files refuses before the branch moves.
 */
export const commitPublication = async (
  runner: GitRunner,
  input: PublicationCommitInput,
): Promise<PublicationCommit> => {
  const previous = await revParse(runner, input.repo, input.programBranch);
  const scratch = await mkdtemp(join(tmpdir(), "nightshift-publication-"));
  const worktree = join(scratch, "wt");
  const throwaway = "nightshift/publication/none";
  try {
    await addDetachedWorktree(runner, { repo: input.repo, path: worktree, base: previous });
    const options = { cwd: worktree, ...(input.atMs === undefined ? {} : { atMs: input.atMs }) };
    const directory = publicationDirectory(input.name);
    const written: string[] = [];
    for (const file of PUBLICATION_FILES) {
      const text = input.files[file];
      if (text === undefined) continue;
      const relative = `${directory}/${file}`;
      await mkdir(dirname(join(worktree, relative)), { recursive: true });
      await writeFile(join(worktree, relative), text);
      written.push(relative);
    }
    if (written.length === 0) return { published: false, head: previous };
    await git(runner, ["add", "--", ...written], options);
    const unchanged = await tryGit(runner, ["diff", "--cached", "--quiet"], options);
    if (unchanged.exitCode === 0) return { published: false, head: previous };
    await git(runner, ["commit", "--no-verify", "-m", input.message], options);
    const head = await revParse(runner, worktree, "HEAD");

    // The commit is not verified: what it actually changed is what is checked.
    const paths = await changedPaths(runner, worktree, previous, head);
    if (!publicationPathsAllowed(input.name, paths)) {
      throw new PublicationRefusedError(
        paths,
        `it changes ${paths.join(", ")}, outside the four files of ${directory}/`,
      );
    }

    // The branch moves only to a commit on top of where it was.
    const checkedOut = await currentBranch(runner, input.repo).catch(() => undefined);
    if (checkedOut === input.programBranch) {
      const moved = await fastForward(runner, input.repo, head, input.atMs ?? Date.now());
      if (!moved.ok) throw new PublicationRefusedError(paths, moved.detail);
    } else {
      await updateRef(runner, input.repo, `refs/heads/${input.programBranch}`, head);
    }
    return { published: true, head, previous };
  } finally {
    await removeWorktree(runner, input.repo, worktree, throwaway).catch(() => undefined);
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
};
