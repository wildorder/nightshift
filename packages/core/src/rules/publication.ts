/**
 * What a finished planned run may publish onto its program branch (P21, D-03).
 *
 * At finish the engine commits the program's contract, plan, conversation and
 * report into `{programsDirectory}/{name}/` as history. The commit is not verified,
 * so this rule is what keeps it from carrying anything else.
 */
import { DEFAULT_PROGRAMS_DIRECTORY, ProgramsDirectorySchema } from "@nightshift/contracts";

/** The four files a publication may hold, directly inside `{programsDirectory}/{name}/`. */
export const PUBLICATION_FILES = [
  "contract.json",
  "plan.md",
  "conversation.md",
  "report.md",
] as const;

export type PublicationFile = (typeof PUBLICATION_FILES)[number];

/** `{programsDirectory}/{name}` with no trailing slash; `docs/programs` unless the contract names another. */
export const publicationDirectory = (
  programName: string,
  programsDirectory: string = DEFAULT_PROGRAMS_DIRECTORY,
): string => `${programsDirectory}/${programName}`;

/** Whether `programName` is a single safe directory name (no separators, no climbing). */
const isDirectoryName = (name: string): boolean =>
  /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) && name !== "." && name !== "..";

/**
 * Whether every changed path is one of the publication's four files under
 * `{programsDirectory}/{programName}/`. Paths are repository-relative with `/`; a path
 * that climbs, is absolute, or names any other file or directory is refused.
 * An empty list is allowed: nothing changed, nothing outside.
 */
export const publicationPathsAllowed = (
  programName: string,
  paths: readonly string[],
  programsDirectory: string = DEFAULT_PROGRAMS_DIRECTORY,
): boolean => {
  if (!isDirectoryName(programName)) return false;
  if (!ProgramsDirectorySchema.safeParse(programsDirectory).success) return false;
  const directory = publicationDirectory(programName, programsDirectory);
  const allowed = new Set<string>(PUBLICATION_FILES.map((file) => `${directory}/${file}`));
  return paths.every((path) => allowed.has(path));
};
