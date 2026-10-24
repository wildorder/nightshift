/**
 * `nightshift report <program> [--run <id>] [--json [--role --model --since --until]]` (P9, D-P9-06).
 *
 * Writes a run's `report.md` again from the control plane alone, so a report
 * read before a decision was reversed shows the reversal, and the correction
 * that followed, after it. The latest run by default. `--json` also writes the
 * versioned export (`report.json`) beside it, its attempts narrowed by the
 * filters.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  exportReport,
  gatherReport,
  type ReportExportFilters,
  renderReport,
} from "@nightshift/core";
import type { CliEnvironment } from "../environment.js";
import { resolveFrom } from "../program-files.js";
import { findProgram } from "../program-source.js";
import { openSession } from "../session.js";
import { findRun } from "./program-run.js";
import { REPORT_FILE } from "./run-program.js";

export interface ReportOptions {
  readonly id: string;
  readonly run?: string;
  readonly repo?: string;
  /** Also write the versioned JSON export. */
  readonly json?: boolean;
  readonly filters?: ReportExportFilters;
}

export const REPORT_JSON_FILE = "report.json";

export const writeRunReport = async (
  environment: CliEnvironment,
  options: ReportOptions,
): Promise<number> => {
  const repoPath = resolveFrom(environment.cwd, options.repo ?? environment.cwd);
  const session = await openSession(environment);
  const files = await findProgram(environment, session, {
    repoPath,
    name: options.id,
    use: "ratified",
  });
  const program = {
    projectId: files.contract.projectId,
    programId: files.contract.programId,
  };
  const run = await findRun(session, program, options.id, options.run);
  const report = await gatherReport(session.stores, {
    ...program,
    runId: run.runId,
  });
  await mkdir(join(repoPath, files.directory), { recursive: true });
  const path = join(repoPath, files.directory, REPORT_FILE);
  await writeFile(path, renderReport(report));
  environment.out(`report for run ${run.runId}: ${path}`);
  if (options.json === true) {
    const jsonPath = join(repoPath, files.directory, REPORT_JSON_FILE);
    await writeFile(
      jsonPath,
      `${JSON.stringify(exportReport(report, options.filters), null, 2)}\n`,
    );
    environment.out(`export for run ${run.runId}: ${jsonPath}`);
  }
  return 0;
};
