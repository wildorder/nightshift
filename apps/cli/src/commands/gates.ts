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
import type { ProgramContract } from "@nightshift/contracts";
import { prerequisitesOf } from "@nightshift/core";
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

export interface GatesOptions {
  readonly id: string;
  readonly repo?: string;
}

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

/** A step's progress verdict: a deferral (D-P7-10) is said as one, not as a failure. */
export const stepVerdict = (result: NonNullable<AuditedGate["result"]>): string => {
  if (result.exitCode === 0) return "ok  ";
  if (result.timedOut) return "FAIL (timed out)";
  return deferralOf(result) === undefined ? `FAIL (exited ${result.exitCode})` : "DEFERRED";
};

/** Audits `contract`'s gates on its program branch's head, printing each step as it ends. */
export const auditProgramGates = async (
  environment: CliEnvironment,
  contract: ProgramContract,
  repoPath: string,
  say: (line: string) => void = environment.out,
): Promise<GateAudit> => {
  const branch = contract.repository.programBranch;
  const base = await revParse(environment.git, repoPath, branch);
  say(
    `auditing the gates on ${branch} at ${base.slice(0, 8)}: setup and every check, ` +
      "in a fresh checkout, as verification runs them",
  );
  const unmet = new Set(
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

/** Exit code 0 unless a gate is red. A missing setup is said, not counted. */
export const gates = async (
  environment: CliEnvironment,
  options: GatesOptions,
): Promise<number> => {
  const repoPath = resolveFrom(environment.cwd, options.repo ?? environment.cwd);
  const files = await readProgramFiles(repoPath, options.id);
  const session = await openSession(environment).catch(() => undefined);
  const contract = await auditContractOf(environment, files, session);
  const audit = await auditProgramGates(environment, contract, repoPath);
  describeAudit(environment, audit);
  return audit.red ? 1 : 0;
};
