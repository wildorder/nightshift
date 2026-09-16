/**
 * Materialising the fixture repository (T9 deliverable 1).
 *
 * `test/fixtures/slice-repo/` is a plain directory of files in this monorepo —
 * **not** a git repository. A repository inside a repository is a submodule, a
 * `.git` directory that `git add -A` half-commits, or a checkout that the
 * monorepo's own tooling walks into. So it is copied to a temporary directory
 * and made into a repository there, once per test, and thrown away after.
 *
 * Copying also means every test gets a pristine one. A suite that shared a
 * worktree would have its second test debugging the first test's leftovers.
 */
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProgramContract, ProgramId, ProjectId } from "@nightshift/contracts";
import { ProgramContractSchema } from "@nightshift/contracts";
import { type GitRunner, git, nodeGitRunner, revParse } from "@nightshift/execution";

/**
 * Where the authored fixture lives.
 *
 * Two levels up is `test/` whether this module is running from `src` (under
 * vitest) or from `dist` (loaded by a child process), so the same expression
 * finds the fixture in both.
 */
const FIXTURE_SOURCE = fileURLToPath(new URL("../../fixtures/slice-repo", import.meta.url));

export const CONTRACT_FILE = "nightshift.program.json";
/** Matches the authored contract. Changing one without the other is a bug. */
export const PROGRAM_BRANCH = "program/slice";

const AUTHORED_AT = Date.parse("2026-09-15T00:00:00.000Z");

export interface MaterialisedRepo {
  /** The temporary root holding both the checkout and the state directory. */
  readonly root: string;
  /** The program checkout: a real repository, on the program branch. */
  readonly repo: string;
  /** Somewhere for worktrees, spools and transcripts. Never inside `repo`. */
  readonly stateDir: string;
  /** The contract as written into the checkout. */
  readonly program: ProgramContract;
  readonly baseCommit: string;
  remove(): Promise<void>;
}

export interface MaterialiseOptions {
  /**
   * Replace the authored identifiers.
   *
   * The authored ones are stable so a human can read a local run's records.
   * Deployed mode mints a throwaway project instead, and rewrites them here.
   */
  readonly projectId?: ProjectId;
  readonly programId?: ProgramId;
  readonly git?: GitRunner;
}

/** The authored contract, read without materialising anything. */
export const authoredProgram = async (): Promise<ProgramContract> =>
  ProgramContractSchema.parse(
    JSON.parse(await readFile(join(FIXTURE_SOURCE, CONTRACT_FILE), "utf8")),
  );

export const materialiseFixtureRepo = async (
  options: MaterialiseOptions = {},
): Promise<MaterialisedRepo> => {
  const root = await mkdtemp(join(tmpdir(), "nightshift-slice-"));
  const repo = join(root, "repo");
  const stateDir = join(root, "state");
  await mkdir(stateDir, { recursive: true });
  await cp(FIXTURE_SOURCE, repo, { recursive: true });

  const authored = ProgramContractSchema.parse(
    JSON.parse(await readFile(join(repo, CONTRACT_FILE), "utf8")),
  );
  const program: ProgramContract = {
    ...authored,
    ...(options.projectId === undefined ? {} : { projectId: options.projectId }),
    ...(options.programId === undefined ? {} : { programId: options.programId }),
    // The contract's repository is where it actually is, now that it is
    // somewhere. The authored value is a placeholder.
    repository: { ...authored.repository, url: repo },
  };
  await writeFile(join(repo, CONTRACT_FILE), `${JSON.stringify(program, null, 2)}\n`, "utf8");

  const runner = options.git ?? nodeGitRunner;
  const run = (args: readonly string[]) => git(runner, args, { cwd: repo, atMs: AUTHORED_AT });
  await run(["init", "--initial-branch=main"]);
  await run(["add", "-A"]);
  await run(["commit", "-m", "the slice fixture repository"]);
  await run(["checkout", "-b", PROGRAM_BRANCH]);

  return {
    root,
    repo,
    stateDir,
    program,
    baseCommit: await revParse(runner, repo, "HEAD"),
    remove: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
};

/** Where the fixture's own files are, for a test that wants to read one. */
export const fixturePath = (...parts: readonly string[]): string => join(FIXTURE_SOURCE, ...parts);

export { dirname };
