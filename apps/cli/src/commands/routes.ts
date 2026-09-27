/**
 * `nightshift routes export <program> [--run <id>]` and
 * `nightshift routes export --project <id>` (P8, SC-P8-15, SC-11).
 *
 * Every routing decision, one self-contained JSON line each, on stdout: the
 * dataset a learned router trains on later. Read from the control plane alone.
 */
import type { ProgramContract, ProjectId, Run } from "@nightshift/contracts";
import { ProjectIdSchema } from "@nightshift/contracts";
import { routingDataset } from "@nightshift/execution";
import type { CliEnvironment } from "../environment.js";
import { UsageError } from "../failures.js";
import { readProgramFiles, resolveFrom } from "../program-files.js";
import { openSession, type Session } from "../session.js";

export interface RoutesExportOptions {
  readonly id?: string;
  readonly run?: string;
  readonly project?: string;
  readonly repo?: string;
}

const readAll = async <T>(
  read: (page: {
    cursor?: string;
  }) => Promise<{ readonly items: readonly T[]; readonly cursor?: string | undefined }>,
): Promise<T[]> => {
  const items: T[] = [];
  let cursor: string | undefined;
  do {
    const page = await read(cursor === undefined ? {} : { cursor });
    items.push(...page.items);
    cursor = page.cursor;
  } while (cursor !== undefined);
  return items;
};

const exportRuns = async (
  environment: CliEnvironment,
  session: Session,
  program: Pick<ProgramContract, "projectId" | "programId">,
  only: string | undefined,
): Promise<number> => {
  const scope = { projectId: program.projectId, programId: program.programId };
  const runs = (await readAll<Run>((page) => session.stores.runs.listByProgram(scope, page)))
    .filter((run) => only === undefined || run.runId === only)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  let lines = 0;
  for (const run of runs) {
    for (const line of await routingDataset(session.stores, { ...scope, runId: run.runId })) {
      environment.out(JSON.stringify(line));
      lines += 1;
    }
  }
  return lines;
};

export const exportRoutes = async (
  environment: CliEnvironment,
  options: RoutesExportOptions,
): Promise<number> => {
  const session = await openSession(environment);
  if (options.project !== undefined) {
    const parsed = ProjectIdSchema.safeParse(options.project);
    if (!parsed.success) throw new UsageError(`\`${options.project}\` is not a project id`);
    const projectId: ProjectId = parsed.data;
    const programs = await readAll<ProgramContract>((page) =>
      session.stores.programContracts.listByProject(projectId, page),
    );
    let lines = 0;
    for (const program of programs)
      lines += await exportRuns(environment, session, program, undefined);
    environment.err(`${lines} routing decision(s) across ${programs.length} program(s).`);
    return 0;
  }
  if (options.id === undefined)
    throw new UsageError("a program id, or --project <id>, is required");
  const repoPath = resolveFrom(environment.cwd, options.repo ?? environment.cwd);
  const files = await readProgramFiles(repoPath, options.id);
  const lines = await exportRuns(environment, session, files.contract, options.run);
  environment.err(`${lines} routing decision(s).`);
  return 0;
};
