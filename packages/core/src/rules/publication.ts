/**
 * What a finished planned run may publish onto its program branch (P21, D-03).
 *
 * At finish the engine commits the program's contract, plan, conversation and
 * report into `docs/programs/{name}/` as history. The commit is not verified,
 * so this rule is what keeps it from carrying anything else.
 */

/** The four files a publication may hold, directly inside `docs/programs/{name}/`. */
export const PUBLICATION_FILES = [
  "contract.json",
  "plan.md",
  "conversation.md",
  "report.md",
] as const;

export type PublicationFile = (typeof PUBLICATION_FILES)[number];

/** `docs/programs/{name}` with no trailing slash. */
export const publicationDirectory = (programName: string): string => `docs/programs/${programName}`;

/** Whether `programName` is a single safe directory name (no separators, no climbing). */
const isDirectoryName = (name: string): boolean =>
  /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) && name !== "." && name !== "..";

/**
 * Whether every changed path is one of the publication's four files under
 * `docs/programs/{programName}/`. Paths are repository-relative with `/`; a path
 * that climbs, is absolute, or names any other file or directory is refused.
 * An empty list is allowed: nothing changed, nothing outside.
 */
export const publicationPathsAllowed = (programName: string, paths: readonly string[]): boolean => {
  if (!isDirectoryName(programName)) return false;
  const allowed = new Set<string>(
    PUBLICATION_FILES.map((file) => `${publicationDirectory(programName)}/${file}`),
  );
  return paths.every((path) => allowed.has(path));
};
