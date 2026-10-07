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
 * 3. the gate audit (`gates.ts`), for a run on this machine: setup and every
 *    check, once, on the base. A gate that fails stops the run here, because no
 *    job could pass verification. A remote run is audited on its own machine;
 * 4. the run, its program node, and the human's decisions (`startRun`);
 * 5. the headless root orchestrator, as a process, waited for;
 * 6. `report.md`, from the control plane alone.
 *
 * The exit code is 0 only when the run succeeded: anything parked is 1, and a
 * run whose only shortfall is deferred work is 3, so a script chaining programs
 * stops where a human would want to look and can tell which kind of stop it is.
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Decision, ProgramContract } from "@nightshift/contracts";
import {
  gatherReport,
  irreversibleConfirmationContext,
  nowIso,
  prerequisitesOf,
  type RunReport,
  renderReport,
  strandsOf,
  unconfirmedCorrections,
} from "@nightshift/core";
import {
  requireRatifiedPlan,
  runPreflight,
  type StartedRun,
  startRun,
} from "@nightshift/execution";
import { createHttpPlanning } from "@nightshift/persistence/http";
import type { CliEnvironment } from "../environment.js";
import { UsageError } from "../failures.js";
import type { ProgramFiles } from "../program-files.js";
import type { Session } from "../session.js";
import { auditProgramGates, describeAudit } from "./gates.js";
import { assertRemoteReady, dispatchRun } from "./remote.js";

export const REPORT_FILE = "report.md";

export interface RunProgramOptions {
  readonly repoPath: string;
  /** Create the run and stop: a human's own session will orchestrate it, as before P7. */
  readonly attended: boolean;
  readonly harness?: string;
  readonly model?: string;
  /**
   * P9 (D-P9-05): the corrected decisions whose effects reach outside the
   * repository, which the owner confirms this correction may run over.
   */
  readonly confirmIrreversible?: readonly string[];
  /** P10: dispatch the run to a machine of its own instead of orchestrating here. */
  readonly remote?: boolean;
  readonly compute?: string;
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

/**
 * The corrected decisions of a class the owner confirms (D-P9-05), refused
 * unless each is named in `--confirm-irreversible`. Returns those to record.
 */
const requireConfirmations = async (
  session: Session,
  program: ProgramContract,
  options: RunProgramOptions,
): Promise<readonly Decision[]> => {
  const corrected: Decision[] = [];
  for (const target of program.corrects ?? []) {
    const decision = await session.stores.decisions.get(
      { projectId: program.projectId, programId: target.programId, runId: target.runId },
      target.decisionId,
    );
    if (decision !== undefined) corrected.push(decision);
  }
  const confirmed = new Set(options.confirmIrreversible ?? []);
  const needing = unconfirmedCorrections(corrected, []);
  const missing = needing.filter((decision) => !confirmed.has(decision.decisionId));
  if (missing.length > 0) {
    throw new UsageError(
      `this correction reverses ${missing.map((decision) => `${decision.decisionId} (${decision.reversibility})`).join(", ")}, ` +
        "whose effects reach outside the repository. Nothing was started.",
      `Confirm that the correction may run anyway: ${missing.map((decision) => `--confirm-irreversible ${decision.decisionId}`).join(" ")}`,
    );
  }
  return needing;
};

/** The owner's go-ahead, recorded on the correction's run (D-P9-05). */
const recordConfirmations = async (
  environment: CliEnvironment,
  session: Session,
  started: StartedRun,
  confirmed: readonly Decision[],
): Promise<void> => {
  for (const decision of confirmed) {
    await session.stores.decisions.put({
      schemaVersion: 1,
      projectId: started.run.projectId,
      programId: started.run.programId,
      runId: started.run.runId,
      decisionId: environment.ids.next("dec"),
      executionNodeId: started.rootNode.executionNodeId,
      agentId: null,
      context: irreversibleConfirmationContext(decision.decisionId),
      alternatives: [
        { summary: "Do not run the correction", rejectedBecause: "the owner confirmed it" },
      ],
      choice: "Run the correction",
      rationale: `Confirmed with --confirm-irreversible ${decision.decisionId}.`,
      reversibility: decision.reversibility,
      checkpointBefore: started.checkpoint.checkpointId,
      affectedNodes: [],
      authority: "human",
      supersedesDecisionId: null,
      createdAt: nowIso(environment.clock),
    });
    environment.out(`recorded your confirmation to correct ${decision.decisionId}`);
  }
};

/** The gate audit, said; false when a gate is red. */
const gatesAllowStart = async (
  environment: CliEnvironment,
  ratified: ProgramContract,
  repoPath: string,
): Promise<boolean> => {
  // On stderr, all of it: the run id stays the first line of stdout.
  const say = environment.err;
  const audit = await auditProgramGates(environment, ratified, repoPath, say);
  describeAudit(environment, audit, say);
  if (!audit.red) return true;
  environment.err("Nothing was started. Fix the base, then run this again.");
  return false;
};

/** Deferred work and nothing worse: its own code, so a script can tell "come back" from "it broke". */
export const EXIT_DEFERRED = 3;

/** 0 only when the run succeeded. Anything parked or failed is 1; only-deferred is {@link EXIT_DEFERRED}. */
const exitCodeFor = (report: RunReport): number => {
  if (report.run.status === "succeeded") return 0;
  const broke = report.strands.some(
    (strand) => strand.outcome !== "succeeded" && strand.outcome !== "provisional",
  );
  return broke ? 1 : EXIT_DEFERRED;
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

  const confirming = await requireConfirmations(session, ratified, options);

  // The gates, before anything is created. A remote run is audited on the
  // machine that will run it, which is the one whose gates matter.
  if (
    options.remote !== true &&
    !(await gatesAllowStart(environment, ratified, options.repoPath))
  ) {
    return { started: undefined, exitCode: 1 };
  }

  // P10: everything the checkout can say against a remote dispatch, before the
  // run exists (SC-P10-02). The ratified record, not the file: ratification
  // lives on the control plane, and contract.json's status stays `planning`.
  const readiness =
    options.remote === true
      ? await assertRemoteReady(environment, ratified, options.repoPath, options.compute)
      : undefined;

  const started = await startRun(deps, {
    program: files.contract,
    planText: files.planText,
    repoPath: options.repoPath,
    location: readiness === undefined ? "local" : "remote",
  });
  await recordConfirmations(environment, session, started, confirming);
  const sayCarried = (): void => {
    for (const carried of started.run.carriedStrands ?? []) {
      environment.out(
        `carried over: ${carried.strandId} was built by run ${carried.fromRunId} under this same plan, ` +
          `and its ${carried.landed.length} landed commit${carried.landed.length === 1 ? " is" : "s are"} ` +
          `on ${started.program.repository.programBranch}; it is not built again`,
      );
    }
  };
  if (readiness !== undefined) {
    environment.out(started.run.runId);
    sayCarried();
    await dispatchRun(environment, session, started, readiness);
    return { started, exitCode: 0 };
  }
  environment.out(started.run.runId);
  sayCarried();
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

  const deferred = report.strands.filter((strand) => strand.outcome === "provisional");
  if (deferred.length > 0) {
    const waitingOn = [...new Set(deferred.flatMap((strand) => strand.waitingOn))];
    environment.out(
      `deferred: ${deferred.map((strand) => strand.id).join(", ")} ${deferred.length === 1 ? "is" : "are"} done on the ` +
        `provisional line, waiting on ${waitingOn.length === 0 ? "a human prerequisite" : waitingOn.join(", ")}. ` +
        `Nothing of ${deferred.length === 1 ? "it" : "them"} is on the program branch. When it is done: ` +
        `\`nightshift preflight ${files.id}\`, then \`nightshift resume ${files.id}\`.`,
    );
  }
  return { started, exitCode: exitCodeFor(report) };
};
