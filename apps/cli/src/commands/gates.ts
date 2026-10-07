/**
 * `nightshift gates {id}`, and the gate audit `nightshift run` does before it
 * creates a run.
 *
 * The program's setup and verification, run once on the program branch's head
 * in a fresh checkout, exactly as verification would run them (see
 * `auditGates`). Deterministic: commands and exit codes, no model. What it finds
 * is printed as it goes and summed up at the end: a gate that failed is red,
 * and no job can pass verification on that base; one that needs an unmet
 * prerequisite did not run.
 */
import type { ProgramContract } from "@nightshift/contracts";
import { prerequisitesOf } from "@nightshift/core";
import {
  auditGates,
  DEFAULT_VERIFICATION_TIMEOUT_MS,
  type GateAudit,
  outputTail,
  revParse,
} from "@nightshift/execution";
import type { CliEnvironment } from "../environment.js";
import { type ProgramFiles, readProgramFiles, resolveFrom } from "../program-files.js";
import { openSession, type Session } from "../session.js";

export interface GatesOptions {
  readonly id: string;
  readonly repo?: string;
}

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

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
    onStep: (result) => {
      const verdict =
        result.exitCode === 0
          ? "ok  "
          : result.timedOut
            ? "FAIL (timed out)"
            : `FAIL (exited ${result.exitCode})`;
      say(`  ${result.stepId.padEnd(width)}  ${verdict}  ${seconds(result.durationMs)}`);
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
  describeRed(environment, audit, sha);
  describeMissingSetup(say, audit.lockfilesWithoutSetup);
  if (!audit.red) say(`the gates pass on ${sha}`);
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
  const recorded = await session?.stores.programContracts
    .get(files.contract.projectId, files.contract.programId)
    .catch(() => undefined);
  if (recorded?.status === "ratified") return recorded;
  environment.out(
    "the plan is not ratified (or the control plane is out of reach): prerequisites count as the contract file states them",
  );
  return files.contract;
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
