/**
 * `nightshift gates {id}`, and the gate audit `nightshift run` does before it
 * creates a run.
 *
 * The program's setup and verification, run once on the program branch's head
 * in a fresh checkout, exactly as verification would run them (see
 * `auditGates`). Deterministic: commands and exit codes, no model. What it finds
 * is printed as it goes and summed up at the end: a gate that failed is red,
 * and no job can pass verification on that base; one that deferred (exit 75
 * and a `NIGHTSHIFT_DEFER` line) said a human must supply something first, and
 * is neither red nor passed; one that needs an unmet prerequisite did not run.
 */
import type { CommitSha, ProgramContract } from "@nightshift/contracts";
import { SETUP_STEP_ID_PREFIX } from "@nightshift/contracts";
import {
  DEFAULT_LANDINGS,
  forecast,
  humanDuration,
  type LandingsSource,
  type MeasuredStep,
  PIN_FILES,
  prerequisitesOf,
  type Recommendation,
  type ResolvedCommand,
  RUNTIME_MARKER_FILES,
  type RuntimeFinding,
  recommend,
  resolveCommand,
  runtimeFindings,
  runtimesToMeasure,
  type VerificationPlan,
} from "@nightshift/core";
import {
  type AuditedGate,
  auditGates,
  DEFAULT_VERIFICATION_TIMEOUT_MS,
  deferralOf,
  type GateAudit,
  outputTail,
  revParse,
} from "@nightshift/execution";
import { createLocalPaths } from "@nightshift/persistence/http";
import type { CliEnvironment } from "../environment.js";
import { type ProgramFiles, readProgramFiles, resolveFrom } from "../program-files.js";
import { openSession, type Session } from "../session.js";
import { filesAt, measureRuntime } from "./remote.js";

export interface GatesOptions {
  readonly id: string;
  readonly repo?: string;
  /** The landings the projection assumes (P17, D-P17-02). Absent, the last run's, else the default. */
  readonly landings?: number;
}

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

/** A step's progress verdict: a deferral (D-P7-10) is said as one, not as a failure. */
export const stepVerdict = (result: NonNullable<AuditedGate["result"]>): string => {
  if (result.exitCode === 0) return "ok  ";
  if (result.timedOut) return "FAIL (timed out)";
  return deferralOf(result) === undefined ? `FAIL (exited ${result.exitCode})` : "DEFERRED";
};

/** Where an audit runs and what it counts as unmet, when not its defaults. */
export interface AuditAt {
  /** The commit audited. Absent, the program branch's head. */
  readonly base?: CommitSha;
  /**
   * The prerequisites not satisfied, as checked by the caller. Absent, those
   * `contract` does not record as satisfied.
   */
  readonly unmet?: ReadonlySet<string>;
}

/**
 * Audits `contract`'s gates on its program branch's head, or on `at.base`,
 * printing each step as it ends.
 */
export const auditProgramGates = async (
  environment: CliEnvironment,
  contract: ProgramContract,
  repoPath: string,
  say: (line: string) => void = environment.out,
  at: AuditAt = {},
): Promise<GateAudit> => {
  const branch = contract.repository.programBranch;
  const base = at.base ?? (await revParse(environment.git, repoPath, branch));
  say(
    `auditing the gates on ${branch} at ${base.slice(0, 8)}: setup and every check, ` +
      "in a fresh checkout, as verification runs them",
  );
  const unmet =
    at.unmet ??
    new Set(
      prerequisitesOf(contract)
        .filter((prerequisite) => prerequisite.status !== "satisfied")
        .map((prerequisite) => prerequisite.id),
    );
  const width = Math.max(
    ...(contract.setup ?? []).map((step) => `setup:${step.id}`.length),
    ...contract.verification.map((step) => step.id.length),
  );
  return auditGates({
    git: environment.git,
    repoPath,
    base,
    program: contract,
    unmet,
    timeoutMs: DEFAULT_VERIFICATION_TIMEOUT_MS,
    // The scratch goes where a run's would: short, under the state directory.
    paths: createLocalPaths(environment.paths),
    onStep: (result) => {
      say(
        `  ${result.stepId.padEnd(width)}  ${stepVerdict(result)}  ${seconds(result.durationMs)}`,
      );
    },
  });
};

/** Each red gate, with the end of what it said. */
const describeRed = (environment: CliEnvironment, audit: GateAudit, sha: string): void => {
  for (const gate of audit.gates.filter((candidate) => candidate.verdict === "failed")) {
    environment.err(`RED   ${gate.id} failed on ${sha}: \`${gate.command}\``);
    const said = gate.result === undefined ? [] : outputTail(gate.result).split("\n");
    for (const line of said) environment.err(`    ${line}`);
  }
  if (!audit.red) return;
  const verb = audit.failing.length === 1 ? "fails" : "fail";
  environment.err(
    `No job can pass verification on ${sha} while ${audit.failing.join(", ")} ${verb}: every job runs every gate.`,
  );
};

/** Each deferred gate, with what it said it is missing and the gates it left unrun. */
const describeDeferred = (say: (line: string) => void, audit: GateAudit): void => {
  for (const gate of audit.gates.filter((candidate) => candidate.verdict === "deferred")) {
    const deferral = gate.deferral;
    say(
      deferral === undefined
        ? `DEFERRED ${gate.id}`
        : `DEFERRED ${gate.id}: ${deferral.prerequisiteId} ${deferral.description}`,
    );
    if (deferral !== undefined && deferral.remediation !== "") {
      say(`    to fix: ${deferral.remediation}`);
    }
  }
  const unrun = audit.gates.filter((gate) => gate.verdict === "unrun").map((gate) => gate.id);
  if (unrun.length > 0 && audit.deferred.some((id) => id.startsWith("setup:"))) {
    say(`  not run: ${unrun.join(", ")}, behind the deferred setup`);
  }
};

const describeMissingSetup = (say: (line: string) => void, lockfiles: readonly string[]): void => {
  if (lockfiles.length === 0) return;
  say(
    `note: ${lockfiles.join(", ")} ${lockfiles.length === 1 ? "is" : "are"} committed and the program ` +
      "declares no setup, so every verification starts with nothing installed. Declare the install " +
      "as `setup` in nightshift.config.json: Nightshift runs it once per checkout and skips it when " +
      "the lockfiles have not changed.",
  );
};

/**
 * The audit's conclusions, after its progress lines. Problems go to stderr;
 * the rest to `say`, which `nightshift run` points at stderr too, so the run
 * id stays the first line of its output.
 */
export const describeAudit = (
  environment: CliEnvironment,
  audit: GateAudit,
  say: (line: string) => void = environment.out,
): void => {
  const sha = audit.base.slice(0, 8);
  for (const gate of audit.gates.filter((candidate) => candidate.verdict === "waiting")) {
    say(`  not run: ${gate.id} waits on ${gate.waitingOn.join(", ")}`);
  }
  describeDeferred(say, audit);
  describeRed(environment, audit, sha);
  describeMissingSetup(say, audit.lockfilesWithoutSetup);
  if (audit.red) return;
  // Deferred, or left unrun behind a deferred setup: not red, and not passed either.
  const unproven = audit.gates
    .filter((gate) => gate.verdict === "deferred" || gate.verdict === "unrun")
    .map((gate) => gate.id);
  if (unproven.length === 0) {
    say(`the gates pass on ${sha}`);
    return;
  }
  say(
    `no gate is red on ${sha}, but the gates do not pass yet: ${unproven.join(", ")} ` +
      `${unproven.length === 1 ? "is" : "are"} deferred or not run until a human supplies what the deferral names`,
  );
};

/**
 * The contract the gates are audited by: the control plane's record when the
 * plan is ratified, for its prerequisites' statuses (only `preflight` sets
 * them, there); the files on disk while it is still being planned. Shared by
 * `gates` and `gates --record`, so a record is of the audit `gates` would run.
 */
export const auditContractOf = async (
  environment: CliEnvironment,
  files: ProgramFiles,
  session: Session | undefined,
): Promise<ProgramContract> => {
  // Always the plan on disk: it is what `plan check` and ratification judge,
  // and while a ratified program is re-planned it differs from the record (a
  // new setup, a gate-health strand). The record is read only for what lives
  // on the control plane: which prerequisites preflight found satisfied. An
  // audit of the record instead fingerprinted the last ratified gates, and
  // `plan check` refused it as stale on the same commit (keki-backend,
  // 2026-10-07).
  const recorded = await session?.stores.programContracts
    .get(files.contract.projectId, files.contract.programId)
    .catch(() => undefined);
  if (recorded === undefined) {
    environment.out(
      "the control plane holds no record of this program (or is out of reach): prerequisites count as the contract file states them",
    );
    return files.contract;
  }
  const statusOf = new Map(
    prerequisitesOf(recorded).map((prerequisite) => [prerequisite.id, prerequisite]),
  );
  return {
    ...files.contract,
    ...(files.contract.prerequisites === undefined
      ? {}
      : {
          prerequisites: files.contract.prerequisites.map((prerequisite) => {
            const known = statusOf.get(prerequisite.id);
            return known === undefined
              ? prerequisite
              : {
                  ...prerequisite,
                  status: known.status,
                  ...(known.lastCheck === undefined ? {} : { lastCheck: known.lastCheck }),
                };
          }),
        }),
  };
};

// ── rule 8, declares its runtimes (P16 S-02, SC-08) ─────────────────────────

/** Every file rule 8 reads: the pin files, then the files that say a runtime is used. */
const RUNTIME_FILES: readonly string[] = [
  ...new Set([...PIN_FILES, ...Object.keys(RUNTIME_MARKER_FILES)]),
];

/**
 * Rule 8's mechanical audit at `sha`, the commit the gates were audited on:
 * the pin and marker files as committed there, never the working tree, and
 * each pinned runtime's version on this machine, measured as `run --remote`
 * measures it. A runtime that cannot be run or names no exact version counts
 * as not found. Deterministic: files and `--version`, no model.
 */
export const auditProgramRuntimes = async (
  environment: Pick<CliEnvironment, "git" | "exec">,
  repoPath: string,
  sha: string,
): Promise<RuntimeFinding[]> => {
  const files = await filesAt(environment.git, repoPath, sha, RUNTIME_FILES);
  const measured: Record<string, string | undefined> = {};
  for (const runtime of runtimesToMeasure(files)) {
    const measurement = await measureRuntime(environment.exec, repoPath, runtime);
    if (measurement.kind === "version") measured[runtime] = measurement.version;
  }
  return runtimeFindings(files, measured);
};

const describeRuntimeFinding = (finding: RuntimeFinding): string => {
  switch (finding.kind) {
    case "unpinned":
      return (
        `${finding.marker} says this repository uses ${finding.runtime}, and no file pins its version: ` +
        `pin ${finding.runtime} in one file`
      );
    case "conflicting":
      return (
        `${finding.a.source} pins ${finding.runtime} ${finding.a.spec} but ${finding.b.source} pins ` +
        `${finding.b.spec}: make them agree`
      );
    case "unmet":
      return finding.measured === undefined
        ? `${finding.source} pins ${finding.runtime} ${finding.spec}, and ${finding.runtime} was not found on this machine`
        : `${finding.source} pins ${finding.runtime} ${finding.spec}, but this machine runs ${finding.runtime} ${finding.measured}`;
  }
};

/**
 * Rule 8's findings, under their heading. Each is for the planning skill to
 * turn into a decision against rule 8; none makes a gate red.
 */
export const describeRuntimeFindings = (
  say: (line: string) => void,
  findings: readonly RuntimeFinding[],
  sha: string,
): void => {
  if (findings.length === 0) {
    say(
      `rule 8, declares its runtimes: every runtime used on ${sha.slice(0, 8)} is pinned and met`,
    );
    return;
  }
  say(
    `rule 8, declares its runtimes: ${findings.length} finding${findings.length === 1 ? "" : "s"} on ${sha.slice(0, 8)}`,
  );
  for (const finding of findings) say(`  RUNTIME ${describeRuntimeFinding(finding)}`);
};

// ── the verification plan (P17, D-P17-01 … D-P17-04, D-P17-08) ──────────────

/** What the audit measured, by step id; setup the reference seeded costs a landing nothing. */
export const measuredFromAudit = (audit: GateAudit): Map<string, MeasuredStep> => {
  const measured = new Map<string, MeasuredStep>();
  for (const gate of audit.gates) {
    if (gate.result === undefined) continue;
    const seeded =
      gate.kind === "setup" &&
      new TextDecoder().decode(gate.result.output).startsWith("[setup skipped]");
    measured.set(gate.id, {
      durationMs: gate.result.durationMs,
      quietMs: gate.result.quietMs,
      exitCode: gate.result.exitCode,
      ...(seeded ? { seeded } : {}),
    });
  }
  return measured;
};

/**
 * How many landings the projection assumes, and why that number: given, else
 * the last ended run's integrated jobs, else the default. Always said.
 */
export const landingsFor = async (
  session: Session | undefined,
  contract: ProgramContract,
  given: number | undefined,
): Promise<{ readonly count: number; readonly source: LandingsSource }> => {
  if (given !== undefined) return { count: given, source: "given" };
  if (session !== undefined) {
    const scope = { projectId: contract.projectId, programId: contract.programId };
    const runs = await session.stores.runs.listByProgram(scope).catch(() => undefined);
    const last = [...(runs?.items ?? [])]
      .filter((run) => run.endedAt !== undefined && run.endedAt !== null)
      .sort((a, b) => String(a.endedAt).localeCompare(String(b.endedAt)))
      .at(-1);
    if (last !== undefined) {
      const nodes = await session.stores.executionNodes
        .listByRun({ ...scope, runId: last.runId })
        .catch(() => undefined);
      const landed = (nodes?.items ?? []).filter(
        (node) => node.kind === "job" && node.status === "integrated",
      ).length;
      if (landed > 0) return { count: landed, source: "last run" };
    }
  }
  return { count: DEFAULT_LANDINGS, source: "default" };
};

/** Each gate's command resolved through the repository as committed at `sha` (D-P17-04). */
export const resolveGates = async (
  environment: Pick<CliEnvironment, "git">,
  repoPath: string,
  sha: string,
  contract: ProgramContract,
): Promise<Map<string, ResolvedCommand>> => {
  const read = async (path: string): Promise<string | undefined> => {
    const shown = await environment.git(["show", `${sha}:${path}`], { cwd: repoPath });
    return shown.exitCode === 0 ? shown.stdout : undefined;
  };
  const resolved = new Map<string, ResolvedCommand>();
  for (const step of contract.setup ?? []) {
    const id = `${SETUP_STEP_ID_PREFIX}${step.id}`;
    resolved.set(id, await resolveCommand(id, step.command, read));
  }
  for (const step of contract.verification) {
    resolved.set(step.id, await resolveCommand(step.id, step.command, read));
  }
  return resolved;
};

const KIND_LABEL = { setup: "setup  ", landing: "landing", end: "end    " } as const;

/** The plan, as §4.1 of P17 lays it out: measured numbers, labelled. */
export const describePlan = (
  say: (line: string) => void,
  plan: VerificationPlan,
  sha: string,
  machine: string,
): void => {
  say("");
  say(`verification plan at ${sha.slice(0, 8)}, measured once on this machine (${machine})`);
  say("");
  const width = Math.max(...plan.steps.map((step) => step.id.length), 8);
  let lastKind: string | undefined;
  for (const step of plan.steps) {
    const kind = step.kind === lastKind ? "       " : KIND_LABEL[step.kind];
    lastKind = step.kind;
    const measured = step.measured;
    const time =
      measured === undefined
        ? "not run".padStart(8)
        : humanDuration(measured.durationMs).padStart(8);
    const notes: string[] = [];
    if (measured?.seeded === true) notes.push("seeded from the program checkout");
    if (measured !== undefined && measured.quietMs >= 60_000)
      notes.push(`quiet for ${humanDuration(measured.quietMs)} before its first line`);
    if (step.kind === "end") notes.push("runs once when the run finishes (A-57)");
    say(
      `  ${kind}  ${step.id.padEnd(width)}  ${time}${notes.length === 0 ? "" : `   ${notes.join("; ")}`}`,
    );
  }
  say("");
  say(`  one landing         ${humanDuration(plan.landingMs).padStart(8)}   (every job)`);
  say(
    `  one examined job    ${humanDuration(plan.examinedJobMs).padStart(8)}   (candidate check, then the queue's)`,
  );
  say(
    `  end gates           ${(plan.endGatesMs === 0 ? "none" : humanDuration(plan.endGatesMs)).padStart(8)}`,
  );
  say("");
  const source =
    plan.landings.source === "given"
      ? "as given"
      : plan.landings.source === "last run"
        ? "the last run's; set with --landings"
        : "the default; set with --landings";
  say(
    `  projected: ${plan.landings.count} landings (${source}) ≈ ${humanDuration(plan.projectedMs)} of verification`,
  );
  if (plan.unmeasured.length > 0) {
    say(`  not in the total, not run by the audit: ${plan.unmeasured.join(", ")}`);
  }
};

/** Each recommendation: rule, evidence, formula, the fix, and the edit when there is one. */
export const describeRecommendations = (
  say: (line: string) => void,
  recommendations: readonly Recommendation[],
  contractPath: string,
): void => {
  say("");
  if (recommendations.every((recommendation) => recommendation.savingMs === undefined)) {
    say("recommendations: none; the catalogue found nothing to move or to keep alive");
  } else {
    say("recommendations, by time saved");
  }
  recommendations.forEach((recommendation, index) => {
    say("");
    const saving =
      recommendation.savingMs === undefined
        ? ""
        : `saves ≈ ${humanDuration(recommendation.savingMs)}`;
    say(`  ${index + 1}. ${recommendation.title.padEnd(52)} ${saving}`.trimEnd());
    if (recommendation.rule !== undefined) say(`     rule ${recommendation.rule}`);
    for (const line of recommendation.evidence) say(`     ${line}`);
    say(`     ${recommendation.formula}`);
    say(`     fix: ${recommendation.fix}`);
    if (recommendation.edit !== undefined) {
      const set = Object.entries(recommendation.edit.set)
        .map(([key, value]) => `"${key}": "${value}"`)
        .join(", ");
      say(`     edit ${contractPath}: on the step "${recommendation.edit.stepId}", set ${set}`);
    }
  });
};

export interface GatesResult {
  /** 0 unless a gate is red. Rule 8's findings and the recommendations are said, not counted. */
  readonly exitCode: number;
  readonly audit: GateAudit;
  readonly runtimeFindings: readonly RuntimeFinding[];
  readonly plan: VerificationPlan;
  readonly recommendations: readonly Recommendation[];
}

/**
 * Exit code 0 unless a gate is red. A missing setup, rule 8's findings, the
 * verification plan and its recommendations are said, not counted (P17: the
 * diagnostic never gets in the way and never edits).
 */
export const gates = async (
  environment: CliEnvironment,
  options: GatesOptions,
): Promise<GatesResult> => {
  const repoPath = resolveFrom(environment.cwd, options.repo ?? environment.cwd);
  const files = await readProgramFiles(repoPath, options.id);
  const session = await openSession(environment).catch(() => undefined);
  const contract = await auditContractOf(environment, files, session);
  const audit = await auditProgramGates(environment, contract, repoPath);
  describeAudit(environment, audit);
  const runtimes = await auditProgramRuntimes(environment, repoPath, audit.base);
  describeRuntimeFindings(environment.out, runtimes, audit.base);
  const plan = forecast({
    setup: contract.setup ?? [],
    verification: contract.verification,
    measured: measuredFromAudit(audit),
    landings: await landingsFor(session, contract, options.landings),
  });
  describePlan(environment.out, plan, audit.base, `${process.platform} ${process.arch}`);
  const recommendations = recommend(
    plan,
    await resolveGates(environment, repoPath, audit.base, contract),
  );
  describeRecommendations(environment.out, recommendations, files.contractPath);
  return { exitCode: audit.red ? 1 : 0, audit, runtimeFindings: runtimes, plan, recommendations };
};
