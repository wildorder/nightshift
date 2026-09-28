/**
 * `nightshift report <program> [--run <id>]` (P9, D-P9-06).
 *
 * Writes a run's `report.md` again from the control plane alone, so a report
 * read before a decision was reversed shows the reversal, and the correction
 * that followed, after it. The latest run by default.
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Run } from "@nightshift/contracts";
import { gatherReport, renderReport } from "@nightshift/core";
import type { CliEnvironment } from "../environment.js";
import { UsageError } from "../failures.js";
import { readProgramFiles, resolveFrom } from "../program-files.js";
import { openSession } from "../session.js";
import { REPORT_FILE } from "./run-program.js";

export interface ReportOptions {
  readonly id: string;
  readonly run?: string;
  readonly repo?: string;
}

export const writeRunReport = async (
  environment: CliEnvironment,
  options: ReportOptions,
): Promise<number> => {
  const repoPath = resolveFrom(environment.cwd, options.repo ?? environment.cwd);
  const files = await readProgramFiles(repoPath, options.id);
  const session = await openSession(environment);
  const program = { projectId: files.contract.projectId, programId: files.contract.programId };
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
  const run = runs
    .filter((candidate) => options.run === undefined || candidate.runId === options.run)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
  if (run === undefined) {
    throw new UsageError(
      `no run of \`${options.id}\`${options.run === undefined ? "" : ` named ${options.run}`}`,
    );
  }
  const report = await gatherReport(session.stores, { ...program, runId: run.runId });
  const path = join(repoPath, files.directory, REPORT_FILE);
  await writeFile(path, renderReport(report));
  environment.out(`report for run ${run.runId}: ${path}`);
  return 0;
};
