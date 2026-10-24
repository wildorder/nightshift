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
 * Before any of that, a remote run whose landings never reached GitHub has
 * them published (2026-10-14): the plane retries them from the run's stored
 * bundles, once the human has fixed what refused them. That is the latest run
 * unless `--run` names one, and needs no machine.
 *
 * A remote run's program branch here is first brought up to GitHub's, and
 * whatever the resume commits is pushed back (P21, F-01): its documents too.
 * When a remote run's machine could not get its final documentation commit to
 * the plane, that commit went with the machine; the documents are the control
 * plane's records, so the resume rebuilds them here and pushes them, with
 * nothing deferred to land.
 *
 * Step 2 runs in `apps/mcp`'s `nightshift-resume`, a process of its own, because
 * deferred work the run's policy says to examine is examined there once its
 * checks pass (P8, D-P8-14), and an examiner is an agent the CLI may not start
 * (A-31). No orchestrator is started, and no model is asked anything but an
 * examiner or an arbiter. A CLI built without that entry point lands in
 * process, and refuses examined work rather than land it unexamined. The exit
 * code is 0 when everything deferred has landed.
 */

import type { Prerequisite, ProgramContract, Run } from "@nightshift/contracts";
import { gatherReport, renderReport } from "@nightshift/core";
import {
  createEventOutbox,
  deferredLine,
  type LandingEnvironment,
  type ResumeResult,
  resumeDeferred,
  runPreflight,
  tryRevParse,
} from "@nightshift/execution";
import {
  createHttpArtifactBodyStore,
  createHttpPlanning,
  createLocalPaths,
} from "@nightshift/persistence/http";
import type { CliEnvironment } from "../environment.js";
import { UsageError } from "../failures.js";
import { followOrigin, publishProgramBranch } from "../program-branch.js";
import { resolveFrom } from "../program-files.js";
import { findProgram } from "../program-source.js";
import { openSession, type Session } from "../session.js";
import { republishRun, unpublishedOf } from "./republish.js";
import { writeReportUnlessTracked } from "./run-program.js";

export interface ResumeOptions {
  readonly id: string;
  readonly repo?: string;
  /** The run to resume. Defaults to the program's latest run that has deferred work. */
  readonly run?: string;
}

/** A run its machine or its orchestrator may still be working: not this command's to touch. */
const ACTIVE: ReadonlySet<Run["status"]> = new Set(["pending", "running"]);

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
  if (stop !== undefined) {
    environment.err(`could not land ${stop.nodeId}: ${stop.reason}`);
    environment.err(
      "What follows it is still deferred, on the provisional line. Resume again once that is fixed.",
    );
  }
  // P9 (D-P9-07): retried like any failed check; nothing was discarded.
  for (const failed of result.failed) {
    environment.err(`${failed.nodeId} did not land: ${failed.reason}`);
  }
  if (result.failed.length > 0) {
    environment.err(
      "Everything else that still verified has landed. What did not is yours to plan a correction for; the report says why each did not.",
    );
  }
};

/** A-63: says when the resume settled the run, which it decides from the run's records. */
const saySettled = (environment: CliEnvironment, run: Run, result: ResumeResult): void => {
  const ended = result as ResumeResult & {
    readonly settled?: boolean;
    readonly unsettled?: string;
  };
  if (ended.settled === true) {
    environment.out(`run ${run.runId} is succeeded: every strand succeeded and its end gates pass`);
  }
  if (ended.unsettled !== undefined) environment.out(ended.unsettled);
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
  const session = await openSession(environment);
  const files = await findProgram(environment, session, {
    repoPath,
    name: options.id,
    use: "ratified",
  });
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
      scope: {
        projectId: run.projectId,
        programId: run.programId,
        runId: run.runId,
      },
      clock: environment.clock,
      ids: environment.ids,
      // Its own writer: a resume is not the run's orchestrator, and says so (A-30).
      writerId: `resume-${environment.ids.next("evt")}`,
    }),
    prerequisites: planning,
  });
  const sessionFor = (run: Run) => ({
    scope: {
      projectId: run.projectId,
      programId: run.programId,
      runId: run.runId,
    },
    program,
    repoPath,
  });

  // The run named, or the latest with anything on its provisional line here.
  const candidates = (await runsOf(session, program)).filter(
    (run) => options.run === undefined || run.runId === options.run,
  );

  // A remote run's landings GitHub lacks go first: the latest run's, or the
  // named one's. An older run's are not retried behind a newer run's back.
  const newest = candidates[0];
  const branch = program.repository.programBranch;
  let republished = false;
  if (newest !== undefined && (await unpublishedOf(session, newest)).length > 0) {
    const outcome = await republishRun(environment, session, newest, branch);
    const report = await gatherReport(session.stores, sessionFor(newest).scope);
    const reportPath = await writeReportUnlessTracked(
      environment,
      repoPath,
      files.directory,
      renderReport(report),
    );
    environment.out(`report: ${reportPath}`);
    if (outcome !== "published") return 1;
    republished = true;
  }

  // A remote run's work is at GitHub, not here: whatever this resume commits
  // (a deferred landing, the run's documents) goes on top of what GitHub has,
  // and is pushed there, so none of it is held only on this machine.
  const remote = newest !== undefined && newest.location === "remote";
  if (remote) await followOrigin(environment.git, repoPath, branch, environment.out);
  const pushRemote = async (): Promise<void> => {
    if (!remote) return;
    const pushed = await publishProgramBranch(environment.git, repoPath, branch, {
      push: true,
      out: environment.out,
    });
    if (pushed.kind === "in-step") {
      environment.out(`GitHub's ${branch} is at ${pushed.head.slice(0, 12)}, as here`);
    }
  };

  let chosen: Run | undefined;
  for (const run of candidates) {
    if ((await deferredLine(landingFor(run), sessionFor(run))).length > 0) {
      chosen = run;
      break;
    }
  }
  if (chosen === undefined) {
    // An ended remote run with nothing deferred may still lack its documents
    // at GitHub (P21, D-03): its machine committed them at finish, and if that
    // commit never reached the plane it went with the machine. They are the
    // control plane's records, so they are rebuilt here and pushed; a run
    // whose documents GitHub already has commits nothing.
    // An interrupted run with nothing left to land may be finished all the
    // same (A-63): the resume process settles it from its records.
    if (
      newest !== undefined &&
      !ACTIVE.has(newest.status) &&
      (remote || newest.status === "interrupted")
    ) {
      if (environment.exec === undefined || environment.assets?.resumePath === undefined) {
        environment.err(
          `run ${newest.runId} can only be settled and its documents rebuilt by nightshift-resume, which this CLI was built without`,
        );
        return 1;
      }
      const before = await tryRevParse(environment.git, repoPath, branch);
      const ended = await landDeferred(environment, newest, repoPath, async () => ({
        landed: [],
        retried: [],
        failed: [],
      }));
      saySettled(environment, newest, ended);
      const after = await tryRevParse(environment.git, repoPath, branch);
      if (after !== undefined && after !== before) {
        environment.out(
          `run ${newest.runId}: its plan, contract and report are committed on ${branch} at ${after.slice(0, 12)}`,
        );
      }
      await pushRemote();
      return 0;
    }
    if (republished) return 0;
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
  environment.out(
    `run ${chosen.runId}: ${result.landed.length} landed on the program branch` +
      (result.retried.length === 0 ? "" : `, ${result.retried.length} of them after a retry`),
  );
  saySettled(environment, chosen, result);
  reportStop(environment, result);

  const report = await gatherReport(session.stores, sessionFor(chosen).scope);
  const reportPath = await writeReportUnlessTracked(
    environment,
    repoPath,
    files.directory,
    renderReport(report),
  );
  environment.out(`report: ${reportPath}`);
  await pushRemote();
  return result.stoppedAt === undefined && result.failed.length === 0 ? 0 : 1;
};
