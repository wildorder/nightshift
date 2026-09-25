/**
 * `nightshift resume {id}` (P7, T4; D-P7-10, SC-P7-08a).
 *
 * For when the human is back. A run that met a hurdle kept going on a
 * provisional line and ended `interrupted`, its deferred checks waiting. This:
 *
 * 1. runs **preflight**, every pending prerequisite, and stops with the
 *    remediations if anything is still unmet: a deferred check that still cannot
 *    run would only be deferred again;
 * 2. runs the deferred checks over the provisional commits **in order**, landing
 *    what passes on the program branch unchanged;
 * 3. on a failure, records it as one, discards what was built on it and says so;
 * 4. rewrites `report.md` from the control plane.
 *
 * Step 2 runs in `apps/mcp`'s `nightshift-resume`, a process of its own, because
 * deferred work the run's policy says to examine is examined there once its
 * checks pass (P8, D-P8-14), and an examiner is an agent the CLI may not start
 * (A-31). No orchestrator is started, and no model is asked anything but an
 * examiner or an arbiter. A CLI built without that entry point lands in
 * process, and refuses examined work rather than land it unexamined. The exit
 * code is 0 when everything deferred has landed.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Prerequisite, ProgramContract, Run } from "@nightshift/contracts";
import {
  createEventOutbox,
  deferredLine,
  gatherReport,
  type LandingEnvironment,
  type ResumeResult,
  renderReport,
  resumeDeferred,
  runPreflight,
} from "@nightshift/execution";
import {
  createHttpArtifactBodyStore,
  createHttpPlanning,
  createLocalPaths,
} from "@nightshift/persistence/http";
import type { CliEnvironment } from "../environment.js";
import { UsageError } from "../failures.js";
import { readProgramFiles, resolveFrom } from "../program-files.js";
import { openSession, type Session } from "../session.js";
import { REPORT_FILE } from "./run-program.js";

export interface ResumeOptions {
  readonly id: string;
  readonly repo?: string;
  /** The run to resume. Defaults to the program's latest run that has deferred work. */
  readonly run?: string;
}

const runsOf = async (session: Session, program: ProgramContract): Promise<Run[]> => {
  const scope = { projectId: program.projectId, programId: program.programId };
  const runs: Run[] = [];
  let cursor: string | undefined;
  do {
    const page = await session.stores.runs.listByProgram(
      scope,
      cursor === undefined ? {} : { cursor },
    );
    runs.push(...page.items);
    cursor = page.cursor;
  } while (cursor !== undefined);
  return runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
};

const reportStop = (environment: CliEnvironment, result: ResumeResult): void => {
  const stop = result.stoppedAt;
  if (stop === undefined) return;
  if (stop.kind === "refused") {
    environment.err(`could not land ${stop.nodeId}: ${stop.reason}`);
    environment.err(
      "What follows it is still deferred, on the provisional line. Resume again once that is fixed.",
    );
    return;
  }
  environment.err(`${stop.nodeId} did not pass its deferred checks: ${stop.reason}`);
  if (result.discarded.length > 0) {
    environment.err(
      `discarded ${result.discarded.length} built on it: ${result.discarded.join(", ")}. ` +
        "Plan the fix as the next program; the report says what was lost.",
    );
  }
};

const printUnmet = (environment: CliEnvironment, pending: readonly Prerequisite[]): void => {
  for (const prerequisite of pending) {
    environment.err(`UNMET ${prerequisite.id}  ${prerequisite.description}`);
    for (const line of prerequisite.remediation.trimEnd().split("\n")) {
      environment.err(`    ${line}`);
    }
  }
  environment.err(
    "The deferred checks wait on these, so nothing was resumed. Do them, then run this again.",
  );
};

/**
 * The deferred line landed by `nightshift-resume`, which can start an examiner,
 * or in process by `inProcess` when this CLI has no entry point for it.
 */
const landDeferred = async (
  environment: CliEnvironment,
  run: Run,
  repoPath: string,
  inProcess: () => Promise<ResumeResult>,
): Promise<ResumeResult> => {
  const entry = environment.assets?.resumePath;
  if (environment.exec === undefined || entry === undefined) return inProcess();
  const result = await environment.exec(
    process.execPath,
    [
      entry,
      "--project",
      run.projectId,
      "--program",
      run.programId,
      "--run",
      run.runId,
      "--repo",
      repoPath,
    ],
    { cwd: repoPath },
  );
  const last = result.stdout.trim().split("\n").at(-1) ?? "";
  if (result.exitCode !== 0 || last === "") {
    const said = result.stderr.trim().split("\n").slice(-5).join("\n");
    throw new Error(
      `the resume process exited ${result.exitCode}${said === "" ? "" : `:\n${said}`}`,
    );
  }
  return JSON.parse(last) as ResumeResult;
};

export const resume = async (
  environment: CliEnvironment,
  options: ResumeOptions,
): Promise<number> => {
  const repoPath = resolveFrom(environment.cwd, options.repo ?? environment.cwd);
  const files = await readProgramFiles(repoPath, options.id);
  const session = await openSession(environment);
  const planning = createHttpPlanning({ transport: session.transport });

  const program = await session.stores.programContracts.get(
    files.contract.projectId,
    files.contract.programId,
  );
  if (program === undefined) {
    throw new UsageError(`program \`${options.id}\` has never been ratified or run`);
  }

  const landingFor = (run: Run): LandingEnvironment => ({
    stores: session.stores,
    bodies: createHttpArtifactBodyStore({ transport: session.transport }),
    clock: environment.clock,
    ids: environment.ids,
    paths: createLocalPaths(environment.paths),
    git: environment.git,
    outbox: createEventOutbox({
      events: session.stores.events,
      scope: { projectId: run.projectId, programId: run.programId, runId: run.runId },
      clock: environment.clock,
      ids: environment.ids,
      // Its own writer: a resume is not the run's orchestrator, and says so (A-30).
      writerId: `resume-${environment.ids.next("evt")}`,
    }),
    prerequisites: planning,
  });
  const sessionFor = (run: Run) => ({
    scope: { projectId: run.projectId, programId: run.programId, runId: run.runId },
    program,
    repoPath,
  });

  // The run named, or the latest with anything on its provisional line here.
  const candidates = (await runsOf(session, program)).filter(
    (run) => options.run === undefined || run.runId === options.run,
  );
  let chosen: Run | undefined;
  for (const run of candidates) {
    if ((await deferredLine(landingFor(run), sessionFor(run))).length > 0) {
      chosen = run;
      break;
    }
  }
  if (chosen === undefined) {
    environment.out(
      options.run === undefined
        ? `nothing to resume: no run of \`${options.id}\` has deferred work in this repository`
        : `nothing to resume: run ${options.run} has no deferred work in this repository`,
    );
    return 0;
  }

  const preflight = await runPreflight({
    contract: program,
    cwd: repoPath,
    record: planning.recordCheck,
    clock: environment.clock,
  });
  if (preflight.pending.length > 0) {
    printUnmet(environment, preflight.pending);
    return 1;
  }

  const result = await landDeferred(environment, chosen, repoPath, async () => {
    const landing = landingFor(chosen as Run);
    try {
      return await resumeDeferred(landing, sessionFor(chosen as Run));
    } finally {
      await landing.outbox.flush(5_000).catch(() => {});
    }
  });

  if (result.blocked !== undefined) {
    environment.err(result.blocked);
    environment.err(
      "Nothing was touched: every deferred node is still deferred. Fix the checkout, then run this again.",
    );
    return 1;
  }
  environment.out(`run ${chosen.runId}: ${result.landed.length} landed on the program branch`);
  if (result.stoppedAt !== undefined) reportStop(environment, result);

  const report = await gatherReport(session.stores, sessionFor(chosen).scope);
  const reportPath = join(repoPath, files.directory, REPORT_FILE);
  await writeFile(reportPath, renderReport(report));
  environment.out(`report: ${reportPath}`);
  return result.stoppedAt === undefined ? 0 : 1;
};
