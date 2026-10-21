/**
 * Finding the run a command is about, and who is acting, for the commands that
 * read a program's files and then write a record about one of its runs.
 */
import type { Run, UserPrincipal } from "@nightshift/contracts";
import { UserPrincipalSchema } from "@nightshift/contracts";
import type { ProgramScope } from "@nightshift/core";
import { tokenClaims } from "@nightshift/persistence/http";
import { UsageError } from "../failures.js";
import type { FreshSession, Session } from "../session.js";

/** Every run of the program, oldest page first. */
export const listRuns = async (session: Session, program: ProgramScope): Promise<Run[]> => {
  const runs: Run[] = [];
  let cursor: string | undefined;
  do {
    const page = await session.stores.runs.listByProgram(
      program,
      cursor === undefined ? {} : { cursor },
    );
    runs.push(...page.items);
    cursor = page.cursor;
  } while (cursor !== undefined);
  return runs;
};

/** The named run, or the latest one; a `UsageError` when there is none. */
export const findRun = async (
  session: Session,
  program: ProgramScope,
  id: string,
  runId: string | undefined,
): Promise<Run> => {
  const run = (await listRuns(session, program))
    .filter((candidate) => runId === undefined || candidate.runId === runId)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
  if (run === undefined) {
    throw new UsageError(`no run of \`${id}\`${runId === undefined ? "" : ` named ${runId}`}`);
  }
  return run;
};

const ACTIVE_ORG_CLAIM = "custom:active_org";

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

/**
 * The person this session acts as, for the attribution a client proposes.
 *
 * The control plane replaces it with its own reading of the token, so this only
 * has to be well formed. The subject is the ID token's; a local instance's
 * bearer is not a JWT and its operator is `local-operator`. The org is the
 * token's acting org, else the one that owns the project.
 */
export const actingUser = async (
  session: FreshSession,
  local: boolean,
  projectId: ProgramScope["projectId"],
): Promise<UserPrincipal> => {
  const claims = local ? {} : tokenClaims(session.idToken);
  const userId = local ? "local-operator" : asString(claims.sub);
  if (userId === undefined) {
    throw new UsageError("the ID token carries no sub claim; run `nightshift login` again");
  }
  const orgId =
    asString(claims[ACTIVE_ORG_CLAIM]) ?? (await session.stores.projects.get(projectId))?.orgId;
  return UserPrincipalSchema.parse({ kind: "user", userId, orgId });
};
