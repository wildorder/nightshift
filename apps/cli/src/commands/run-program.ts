/**
 * `nightshift run {id}` for a **planned** program: a ratified plan to a report
 * with nobody watching (P7, T4; D-P7-09, SC-P7-06).
 *
 * In this order, and each step's refusal comes before the next step writes
 * anything:
 *
 * 1. the plan on disk is the plan that was ratified, or nothing starts;
 * 2. preflight, for what the **first** strands need. Those unmet stop the run
 *    here with their remediations, because there is nothing to carry on with. A
 *    prerequisite only a later strand needs does not stop it (D-P7-10): the
 *    work that needs it defers, and the rest of the night is not wasted;
 * 3. the run, its program node, and the human's decisions (`startRun`);
 * 4. the headless root orchestrator, as a process, waited for;
 * 5. `report.md`, from the control plane alone.
 *
 * The exit code is 0 only when the run succeeded: anything parked is non-zero,
 * so a script chaining programs stops where a human would want to look.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProgramContract } from "@nightshift/contracts";
import { prerequisitesOf, strandsOf } from "@nightshift/core";
import {
  gatherReport,
  renderReport,
  requireRatifiedPlan,
  runPreflight,
  type StartedRun,
  startRun,
} from "@nightshift/execution";
import { createHttpPlanning } from "@nightshift/persistence/http";
import type { CliEnvironment } from "../environment.js";
import type { ProgramFiles } from "../program-files.js";
import type { Session } from "../session.js";

export const REPORT_FILE = "report.md";

export interface RunProgramOptions {
  readonly repoPath: string;
  /** Create the run and stop: a human's own session will orchestrate it, as before P7. */
  readonly attended: boolean;
  readonly harness?: string;
  readonly model?: string;
}

export interface RunProgramResult {
  readonly started: StartedRun | undefined;
  readonly exitCode: number;
}

/** The prerequisites of strands that depend on nothing: what the run needs to begin at all. */
export const firstStrandPrerequisites = (contract: ProgramContract): readonly string[] => [
  ...new Set(
    strandsOf(contract)
      .filter((strand) => strand.dependsOn.length === 0)
      .flatMap((strand) => strand.prerequisites),
  ),
];

const preflightFirstStrands = async (
  environment: CliEnvironment,
  session: Session,
  ratified: ProgramContract,
  repoPath: string,
): Promise<boolean> => {
  const needed = firstStrandPrerequisites(ratified);
  const later = prerequisitesOf(ratified).filter(
    (prerequisite) => prerequisite.status !== "satisfied" && !needed.includes(prerequisite.id),
  );
  const planning = createHttpPlanning({ transport: session.transport });
  const result = await runPreflight({
    contract: ratified,
    cwd: repoPath,
    record: planning.recordCheck,
    only: needed,
    clock: environment.clock,
  });
  for (const prerequisite of result.pending) {
    environment.err(`UNMET ${prerequisite.id}  ${prerequisite.description}`);
    for (const line of prerequisite.remediation.trimEnd().split("\n")) {
      environment.err(`    ${line}`);
    }
  }
  if (result.pending.length > 0) {
    environment.err(
      "The first strands need these, so nothing was started. Do them, then run this again.",
    );
    return false;
  }
  for (const prerequisite of later) {
    environment.out(
      `note: ${prerequisite.id} is not yet satisfied; only later strands need it, so the run starts ` +
        "and the checks that need it are deferred until it is.",
    );
  }
  return true;
};

const launchOrchestrator = async (
  environment: CliEnvironment,
  started: StartedRun,
  options: RunProgramOptions,
): Promise<void> => {
  const entry = environment.assets?.orchestratePath;
  if (environment.exec === undefined || entry === undefined) {
    throw new Error("this build of the CLI cannot start an orchestrator");
  }
  const { projectId, programId, runId } = started.run;
  const result = await environment.exec(
    process.execPath,
    [
      entry,
      "--project",
      projectId,
      "--program",
      programId,
      "--run",
      runId,
      "--repo",
      options.repoPath,
      ...(options.harness === undefined ? [] : ["--harness", options.harness]),
      ...(options.model === undefined ? [] : ["--model", options.model]),
    ],
    { cwd: options.repoPath },
  );
  if (result.exitCode !== 0) {
    const said = result.stderr.trim().split("\n").slice(-5).join("\n");
    environment.err(
      `the orchestrator process exited ${result.exitCode}${said === "" ? "" : `:\n${said}`}`,
    );
  }
};

export const runProgram = async (
  environment: CliEnvironment,
  session: Session,
  files: ProgramFiles,
  options: RunProgramOptions,
): Promise<RunProgramResult> => {
  const deps = {
    stores: session.stores,
    clock: environment.clock,
    ids: environment.ids,
    git: environment.git,
  };
  const ratified = await requireRatifiedPlan(session.stores, files.contract, files.planText);
  if (!(await preflightFirstStrands(environment, session, ratified, options.repoPath))) {
    return { started: undefined, exitCode: 1 };
  }

  const started = await startRun(deps, {
    program: files.contract,
    planText: files.planText,
    repoPath: options.repoPath,
  });
  environment.out(started.run.runId);
  environment.out(
    `run ${started.run.runId} of plan ${ratified.planHash?.slice(0, 12)} is pending ` +
      `at ${started.baseCommit.slice(0, 8)} on ${started.program.repository.programBranch}`,
  );

  const unattended =
    !options.attended &&
    environment.exec !== undefined &&
    environment.assets?.orchestratePath !== undefined;
  if (!unattended) {
    environment.out(
      `Open your orchestrator in ${options.repoPath} so the Nightshift MCP server can attach to this run.`,
    );
    return { started, exitCode: 0 };
  }

  environment.out("starting the orchestrator; this returns when the run has ended");
  await launchOrchestrator(environment, started, options);

  const scope = {
    projectId: started.run.projectId,
    programId: started.run.programId,
    runId: started.run.runId,
  };
  const report = await gatherReport(session.stores, scope);
  const reportPath = join(options.repoPath, files.directory, REPORT_FILE);
  await writeFile(reportPath, renderReport(report));

  const succeeded = report.strands.filter((strand) => strand.outcome === "succeeded").length;
  environment.out(
    `run ${report.run.runId} is ${report.run.status}: ${succeeded} of ${report.strands.length} strands succeeded`,
  );
  environment.out(`report: ${reportPath}`);
  return { started, exitCode: report.run.status === "succeeded" ? 0 : 1 };
};
