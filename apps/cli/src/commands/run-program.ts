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
 * 3. the gate audit (`gates.ts`): setup and every check, once, on the base. A
 *    gate that fails does not stop the run (P15, D-P15-03): the run is started
 *    on a red base, which it records as `gate.red` on its program node, and its
 *    first job is the repair; the engine holds the strands until it lands. A
 *    remote run's audit here is its reference (P16 D-06): after the remote
 *    checks, at exactly the base dispatched, with every prerequisite checked on
 *    this laptop. It goes with the dispatch, and its machine audits the base
 *    again and decides whether it is red; nothing here writes `gate.red` for it;
 * 4. the run, its program node, and the human's decisions (`startRun`), with
 *    each red gate's output kept on the program node;
 * 5. the headless root orchestrator, as a process, waited for;
 * 6. `report.md`, from the control plane alone.
 *
 * The exit code is 0 only when the run succeeded: anything parked is 1, and a
 * run whose only shortfall is deferred work is 3, so a script chaining programs
 * stops where a human would want to look and can tell which kind of stop it is.
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type ArtifactId,
  type CommitSha,
  type Decision,
  isExactRuntimeVersion,
  type Prerequisite,
  type ProgramContract,
} from "@nightshift/contracts";
import {
  gatherReport,
  irreversibleConfirmationContext,
  isMetAt,
  nowIso,
  prerequisitesOf,
  type RunReport,
  renderReport,
  strandsOf,
  unconfirmedCorrections,
} from "@nightshift/core";
import {
  type GateAudit,
  type GitRunner,
  type PreflightResult,
  recordRedBase,
  referenceAuditOf,
  requireRatifiedPlan,
  runPreflight,
  type StartedRun,
  type StartRunEnvironment,
  startRun,
  tryRevParse,
} from "@nightshift/execution";
import { createHttpArtifactBodyStore, createHttpPlanning } from "@nightshift/persistence/http";
import type { CliEnvironment } from "../environment.js";
import { UsageError } from "../failures.js";
import type { ProgramFiles } from "../program-files.js";
import type { Session } from "../session.js";
import { type AuditAt, auditProgramGates, describeAudit } from "./gates.js";
import { assertRemoteReady, dispatchRun, measureRuntime, type RemoteReadiness } from "./remote.js";

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

/** That only later strands need these, so the run starts and the checks that need them wait. */
const noteLaterUnmet = (
  say: (line: string) => void,
  later: readonly Pick<Prerequisite, "id">[],
): void => {
  for (const prerequisite of later) {
    say(
      `note: ${prerequisite.id} is not yet satisfied; only later strands need it, so the run starts ` +
        "and the checks that need it are deferred until it is.",
    );
  }
};

/** What preflight found, or `undefined` when the first strands' prerequisites stop the run. */
const preflightFirstStrands = async (
  environment: CliEnvironment,
  session: Session,
  ratified: ProgramContract,
  repoPath: string,
  /**
   * Say which later prerequisites are unmet. A remote run checks them on the
   * laptop before its reference audit, and says so from what it found then.
   */
  noteLater = true,
): Promise<PreflightResult | undefined> => {
  const needed = firstStrandPrerequisites(ratified);
  // A local run runs here, so the laptop's checks are the ones that count (P16, D-08).
  const laptop = { where: "laptop" } as const;
  const later = prerequisitesOf(ratified).filter(
    (prerequisite) => !isMetAt(prerequisite, laptop) && !needed.includes(prerequisite.id),
  );
  const planning = createHttpPlanning({ transport: session.transport });
  const result = await runPreflight({
    contract: ratified,
    cwd: repoPath,
    record: planning.recordCheck,
    site: laptop,
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
    return undefined;
  }
  if (noteLater) noteLaterUnmet(environment.out, later);
  return result;
};

/**
 * The prerequisites unmet on this laptop, now (P16 D-06): the reference audit
 * counts only what was checked here. Each one preflight has just checked keeps
 * that result; every other is checked again, satisfied or not, and recorded as
 * preflight records it. None of these stops the run: preflight already refused
 * for the first strands, and the rest only defer the checks that need them.
 */
const unmetOnThisLaptop = async (
  environment: CliEnvironment,
  session: Session,
  ratified: ProgramContract,
  repoPath: string,
  preflight: PreflightResult,
): Promise<ReadonlySet<string>> => {
  const status = new Map(
    preflight.checks.map((check) => [check.prerequisite.id, check.prerequisite.status]),
  );
  const rest = prerequisitesOf(ratified)
    .map((prerequisite) => prerequisite.id)
    .filter((id) => !status.has(id));
  if (rest.length > 0) {
    const planning = createHttpPlanning({ transport: session.transport });
    const rechecked = await runPreflight({
      contract: ratified,
      cwd: repoPath,
      record: planning.recordCheck,
      only: rest,
      recheck: true,
      clock: environment.clock,
    });
    for (const check of rechecked.checks) {
      status.set(check.prerequisite.id, check.prerequisite.status);
    }
  }
  const unmet = prerequisitesOf(ratified).filter(
    (prerequisite) => status.get(prerequisite.id) !== "satisfied",
  );
  // On stderr: the run id stays the first line of stdout.
  noteLaterUnmet(environment.err, unmet);
  return new Set(unmet.map((prerequisite) => prerequisite.id));
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

/**
 * The gate audit, said. A red one does not stop the run (D-P15-03): it is
 * returned, and the run records it and repairs it first.
 */
const auditBeforeStart = async (
  environment: CliEnvironment,
  ratified: ProgramContract,
  repoPath: string,
): Promise<GateAudit> => {
  const audit = await auditAndSay(environment, ratified, repoPath);
  if (audit.red) {
    environment.err(
      `The base is red, so the run starts anyway and its first job is a repair of ${audit.failing.join(", ")}; ` +
        "the strands wait for it to land.",
    );
  }
  return audit;
};

/** The gate audit and its conclusions, on stderr, all of it: the run id stays the first line of stdout. */
const auditAndSay = async (
  environment: CliEnvironment,
  ratified: ProgramContract,
  repoPath: string,
  at: AuditAt = {},
): Promise<GateAudit> => {
  const say = environment.err;
  const audit = await auditProgramGates(environment, ratified, repoPath, say, at);
  describeAudit(environment, audit, say);
  return audit;
};

/** The reference audit, kept until the run exists to hold its outputs. */
interface ReferenceEvidence {
  readonly audit: GateAudit;
  readonly node: string | undefined;
  readonly auditedAt: string;
}

/** `node --version` here, exact and without the `v`, as `run --remote` measures it; `undefined` when there is none. */
const nodeOnThisLaptop = async (
  environment: CliEnvironment,
  repoPath: string,
): Promise<string | undefined> => {
  const measured = await measureRuntime(environment.exec, repoPath, "node");
  return measured.kind === "version" && isExactRuntimeVersion("node", measured.version)
    ? measured.version
    : undefined;
};

/**
 * A remote run's reference audit (P16 D-06), on this laptop at exactly
 * `readiness.baseSha`, with the prerequisites as checked here. A red base
 * still dispatches: the machine audits the same base and must agree before
 * anything is repaired, so nothing here records `gate.red`.
 */
const referenceAuditBeforeStart = async (
  environment: CliEnvironment,
  session: Session,
  ratified: ProgramContract,
  repoPath: string,
  readiness: RemoteReadiness,
  preflight: PreflightResult,
): Promise<ReferenceEvidence> => {
  const unmet = await unmetOnThisLaptop(environment, session, ratified, repoPath, preflight);
  environment.err(
    "the reference audit: the gates run here first, and the machine audits the same base and compares",
  );
  const audit = await auditAndSay(environment, ratified, repoPath, {
    base: readiness.baseSha as CommitSha,
    unmet,
  });
  const auditedAt = nowIso(environment.clock);
  if (audit.red) {
    environment.err(
      `The base is red here (${audit.failing.join(", ")}), and the run is dispatched anyway: the machine ` +
        "audits the same base, and only if it agrees is the base red there and repaired first. " +
        "A gate red here and green there is the machine's to explain.",
    );
  }
  return { audit, node: await nodeOnThisLaptop(environment, repoPath), auditedAt };
};

/**
 * The run is made at the base audited and dispatched, or not at all (P16
 * D-06). A branch that moved during the audit is refused here, before
 * anything is written; `startRun` is then held to the audited commit, so a
 * move after this check cannot make the run start elsewhere.
 */
const requireBaseUnmoved = async (
  environment: CliEnvironment,
  repoPath: string,
  readiness: RemoteReadiness,
): Promise<void> => {
  const here = await tryRevParse(environment.git, repoPath, readiness.branch);
  const pushed = await tryRevParse(
    environment.git,
    repoPath,
    `refs/remotes/origin/${readiness.branch}`,
  );
  const moved = [here, pushed].find((sha) => sha !== readiness.baseSha);
  if (moved === undefined && here !== undefined) return;
  throw new UsageError(
    `${readiness.branch} moved from ${readiness.baseSha.slice(0, 12)} to ${(moved ?? "nothing").slice(0, 12)} ` +
      "while its gates were audited; nothing was started",
    "Run this again: the audit and the dispatch must be of the same commit.",
  );
};

/** `git`, except that the program branch resolves to `sha`: `startRun` reads its base so. */
const atAuditedBase =
  (git: GitRunner, branch: string, sha: string): GitRunner =>
  async (args, options) =>
    args.length === 2 && args[0] === "rev-parse" && args[1] === branch
      ? { stdout: `${sha}\n`, stderr: "", exitCode: 0 }
      : git(args, options);

/** Each red gate's last output, kept on the run's program node beside its `gate.red`. */
const keepRedOutput = async (
  environment: CliEnvironment,
  session: Session,
  started: StartedRun,
  audit: GateAudit | undefined,
): Promise<ReadonlyMap<string, ArtifactId>> => {
  if (audit?.red !== true) return new Map();
  const { projectId, programId, runId } = started.run;
  return recordRedBase(
    {
      stores: session.stores,
      bodies: createHttpArtifactBodyStore({ transport: session.transport }),
      clock: environment.clock,
      ids: environment.ids,
    },
    {
      scope: { projectId, programId, runId },
      nodeId: started.rootNode.executionNodeId,
      audit,
      writerId: `run-${runId}-gates`,
      // `startRun` wrote it, with the run's other start events; or, for a
      // remote run, the machine writes it if its own audit agrees (P16 D-06).
      event: false,
    },
  );
};

/** What is settled before the run exists: a local run's audit, or a remote run's readiness and reference. */
interface BeforeStart {
  readonly audit?: GateAudit;
  readonly remote?: { readonly readiness: RemoteReadiness; readonly reference: ReferenceEvidence };
}

const beforeStart = async (
  environment: CliEnvironment,
  session: Session,
  ratified: ProgramContract,
  options: RunProgramOptions,
  preflight: PreflightResult,
): Promise<BeforeStart> => {
  // The gates, before anything is created. A red base starts the run all the
  // same: its first job is the repair (D-P15-03).
  if (options.remote !== true) {
    return { audit: await auditBeforeStart(environment, ratified, options.repoPath) };
  }
  // P10: everything the checkout can say against a remote dispatch, before the
  // run exists (SC-P10-02). The ratified record, not the file: ratification
  // lives on the control plane, and contract.json's status stays `planning`.
  // A toolchain refusal (P16 D-03) comes here, before the long audit.
  const readiness = await assertRemoteReady(
    environment,
    ratified,
    options.repoPath,
    options.compute,
  );
  // P16 D-06: the reference audit, at the base dispatched.
  const reference = await referenceAuditBeforeStart(
    environment,
    session,
    ratified,
    options.repoPath,
    readiness,
    preflight,
  );
  await requireBaseUnmoved(environment, options.repoPath, readiness);
  return { remote: { readiness, reference } };
};

/**
 * The run, after what was settled before it. A remote run is made at the base
 * its reference audited and its dispatch names, whatever the branch says now.
 */
const startAfter = async (
  deps: StartRunEnvironment,
  files: ProgramFiles,
  options: RunProgramOptions,
  before: BeforeStart,
): Promise<StartedRun> => {
  const remote = before.remote;
  const started = await startRun(
    remote === undefined
      ? deps
      : {
          ...deps,
          git: atAuditedBase(deps.git, remote.readiness.branch, remote.readiness.baseSha),
        },
    {
      program: files.contract,
      planText: files.planText,
      repoPath: options.repoPath,
      location: remote === undefined ? "local" : "remote",
      // A remote run's red is the machine's to decide (P16 D-06).
      red: before.audit?.failing ?? [],
    },
  );
  if (remote !== undefined && started.baseCommit !== remote.readiness.baseSha) {
    throw new Error(
      `run ${started.run.runId} started at ${started.baseCommit}, not the audited ${remote.readiness.baseSha}`,
    );
  }
  return started;
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
  const preflight = await preflightFirstStrands(
    environment,
    session,
    ratified,
    options.repoPath,
    options.remote !== true,
  );
  if (preflight === undefined) {
    return { started: undefined, exitCode: 1 };
  }

  const confirming = await requireConfirmations(session, ratified, options);

  const before = await beforeStart(environment, session, ratified, options, preflight);
  const remote = before.remote;

  const started = await startAfter(deps, files, options, before);
  const outputs = await keepRedOutput(
    environment,
    session,
    started,
    before.audit ?? remote?.reference.audit,
  );
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
  if (remote !== undefined) {
    environment.out(started.run.runId);
    sayCarried();
    await dispatchRun(
      environment,
      session,
      started,
      remote.readiness,
      referenceAuditOf({ ...remote.reference, outputs }),
    );
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
