/**
 * `nightshift preflight {id}` (P7, T3; D-P7-05, SC-P7-05).
 *
 * Runs every pending `verifyCommand`, records each exit code, and prints the
 * remediation for whatever is still unmet. Nothing else can mark a prerequisite
 * satisfied, and nothing here decides anything: the status follows from the exit
 * code, in the control plane.
 */
import { prerequisitesOf } from "@nightshift/core";
import { type PreflightCheck, runPreflight } from "@nightshift/execution";
import { createHttpPlanning } from "@nightshift/persistence/http";
import type { CliEnvironment } from "../environment.js";
import { UsageError } from "../failures.js";
import { readProgramFiles, resolveFrom } from "../program-files.js";
import { openSession } from "../session.js";

export interface PreflightOptions {
  readonly id: string;
  readonly repo?: string;
  /** Run satisfied prerequisites again too. */
  readonly recheck: boolean;
}

const indent = (text: string): string[] =>
  text
    .trimEnd()
    .split("\n")
    .map((line) => `      ${line}`);

/** One check: a line when it passed; the remediation, and what the command said, when it did not. */
const report = (environment: CliEnvironment, check: PreflightCheck): void => {
  const { prerequisite } = check;
  if (prerequisite.status === "satisfied") {
    environment.out(`  ok    ${prerequisite.id}  ${prerequisite.description}`);
    return;
  }
  environment.err(
    `  UNMET ${prerequisite.id}  ${prerequisite.description} ` +
      `(\`${prerequisite.verifyCommand}\` ${check.timedOut ? "timed out" : `exited ${check.exitCode}`})`,
  );
  environment.err("    To fix:");
  for (const line of indent(prerequisite.remediation)) environment.err(line);
  if (check.output.trim() === "") return;
  environment.err("    It said:");
  for (const line of indent(check.output.slice(-2000))) environment.err(line);
};

/** Exit code 0 when nothing is pending, 1 otherwise. */
export const preflight = async (
  environment: CliEnvironment,
  options: PreflightOptions,
): Promise<number> => {
  const repoPath = resolveFrom(environment.cwd, options.repo ?? environment.cwd);
  const files = await readProgramFiles(repoPath, options.id);
  const scope = { projectId: files.contract.projectId, programId: files.contract.programId };

  const session = await openSession(environment);
  const planning = createHttpPlanning({ transport: session.transport });
  // The control plane's record, not the file's: statuses live there, and a
  // hurdle a run discovered (D-P7-10) exists nowhere else.
  const recorded = await session.stores.programContracts.get(scope.projectId, scope.programId);
  if (recorded === undefined || recorded.status !== "ratified") {
    throw new UsageError(
      `program \`${options.id}\` is not ratified, so it has no prerequisites to check yet`,
      `Run \`nightshift plan ratify ${options.id}\` first.`,
    );
  }
  if (prerequisitesOf(recorded).length === 0) {
    environment.out("no human prerequisites: nothing to check");
    return 0;
  }

  const result = await runPreflight({
    contract: recorded,
    cwd: repoPath,
    record: planning.recordCheck,
    recheck: options.recheck,
    clock: environment.clock,
  });

  for (const prerequisite of result.skipped) {
    environment.out(`  ok    ${prerequisite.id}  ${prerequisite.description} (already satisfied)`);
  }
  for (const check of result.checks) report(environment, check);

  if (result.pending.length > 0) {
    environment.err(
      `${result.pending.length} of ${result.checks.length + result.skipped.length} prerequisites unmet. ` +
        `Do them, then run \`nightshift preflight ${options.id}\` again.`,
    );
    return 1;
  }
  environment.out("all prerequisites satisfied");
  return 0;
};
