/**
 * Helpers for tests whose plan starts as files in a repository: the plan's home
 * is the control plane (P21), so these put the files from a scratch and ratify
 * the version the plane then holds.
 */
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Cli = (...argv: string[]) => Promise<number>;

/** `docs/programs/{id}` of a repository, as an absolute directory. */
export const programDirectory = (repo: string, id: string): string =>
  join(repo, "docs", "programs", id);

/** A temporary scratch holding copies of the program's files, outside the repository. */
export const scratchOf = async (
  repo: string,
  id: string,
): Promise<{ readonly dir: string; readonly remove: () => Promise<void> }> => {
  const dir = await mkdtemp(join(tmpdir(), "nightshift-scratch-"));
  const source = programDirectory(repo, id);
  await copyFile(join(source, "contract.json"), join(dir, "contract.json"));
  await copyFile(join(source, "plan.md"), join(dir, "plan.md"));
  try {
    await copyFile(join(source, "conversation.md"), join(dir, "conversation.md"));
  } catch {
    // No conversation is kept for this program.
  }
  return { dir, remove: () => rm(dir, { recursive: true, force: true }) };
};

/** Puts the repository's files for `id` as the draft's next version; the exit code of the put. */
export const putFromFiles = async (cli: Cli, repo: string, id: string): Promise<number> => {
  const scratch = await scratchOf(repo, id);
  const latest = await mkdtemp(join(tmpdir(), "nightshift-latest-"));
  try {
    // Based on the latest version when the plane has one, as a person who had read it would be.
    if ((await cli("plan", "show", id, "--dir", latest, "--repo", repo)) === 0) {
      await writeFile(
        join(scratch.dir, ".nightshift-plan-version"),
        await readFile(join(latest, ".nightshift-plan-version"), "utf8"),
      );
    }
    return await cli("plan", "put", id, "--dir", scratch.dir, "--repo", repo);
  } finally {
    await rm(latest, { recursive: true, force: true });
    await scratch.remove();
  }
};

/** Puts the repository's files, then ratifies the latest version; the exit code of the ratify. */
export const ratifyFromFiles = async (cli: Cli, repo: string, id: string): Promise<number> => {
  const put = await putFromFiles(cli, repo, id);
  return put === 0 ? cli("plan", "ratify", id, "--repo", repo) : put;
};
