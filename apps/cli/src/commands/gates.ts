/**
 * `nightshift gates {id}`, and the gate audit `nightshift run` does before it
 * creates a run.
 *
 * The program's setup and verification, run twice on the program branch's head
 * in a fresh checkout, exactly as verification would run them (see
 * `auditGates`). What it finds is printed as it goes and summed up at the end:
 * a gate that failed every time is red, and no job can pass verification on
 * that base; one that passed once and failed once is flaky; one that needs an
 * unmet prerequisite did not run.
 */
import type { ProgramContract } from "@nightshift/contracts";
import { prerequisitesOf } from "@nightshift/core";
import {
  type AuditedGate,
  auditGates,
  DEFAULT_VERIFICATION_TIMEOUT_MS,
  GATE_AUDIT_PASSES,
  type GateAudit,
  outputTail,
  revParse,
} from "@nightshift/execution";
import type { CliEnvironment } from "../environment.js";
import { readProgramFiles, resolveFrom } from "../program-files.js";
import { openSession } from "../session.js";

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
      `${GATE_AUDIT_PASSES} times in a fresh checkout, as verification runs them`,
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
    onStep: ({ pass, result }) => {
      const verdict =
        result.exitCode === 0
          ? "ok  "
          : result.timedOut
            ? "FAIL (timed out)"
            : `FAIL (exited ${result.exitCode})`;
      say(
        `  run ${pass}  ${result.stepId.padEnd(width)}  ${verdict}  ${seconds(result.durationMs)}`,
      );
    },
  });
};

const lastFailure = (gate: AuditedGate) =>
  [...gate.runs].reverse().find((run) => run.exitCode !== 0);

/** Each red gate, with the end of what it said the last time it failed. */
const describeRed = (environment: CliEnvironment, audit: GateAudit, sha: string): void => {
  for (const gate of audit.gates.filter((candidate) => candidate.verdict === "failed")) {
    environment.err(`RED   ${gate.id} failed every run on ${sha}: \`${gate.command}\``);
    const failed = lastFailure(gate);
    const said = failed === undefined ? [] : outputTail(failed).split("\n");
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
  if (audit.flaky.length > 0) {
    environment.err(
      `FLAKY ${audit.flaky.join(", ")} passed and failed on the same commit. A job's verification ` +
        "will fail for no reason in its work some of the time, and each retry is a new attempt.",
    );
  }
  describeMissingSetup(say, audit.lockfilesWithoutSetup);
  if (!audit.red && audit.flaky.length === 0) {
    say(`the gates pass on ${sha}, ${GATE_AUDIT_PASSES} runs out of ${GATE_AUDIT_PASSES}`);
  }
};

/**
 * Exit code 0 unless a gate is red. Flaky gates and a missing setup are said,
 * not counted: they are the human's to weigh.
 */
export const gates = async (
  environment: CliEnvironment,
  options: GatesOptions,
): Promise<number> => {
  const repoPath = resolveFrom(environment.cwd, options.repo ?? environment.cwd);
  const files = await readProgramFiles(repoPath, options.id);
  // The control plane's record when the plan is ratified, for its prerequisites'
  // statuses; the files on disk while it is still being planned.
  const session = await openSession(environment).catch(() => undefined);
  const recorded = await session?.stores.programContracts
    .get(files.contract.projectId, files.contract.programId)
    .catch(() => undefined);
  const contract = recorded?.status === "ratified" ? recorded : files.contract;
  if (contract !== recorded) {
    environment.out(
      "the plan is not ratified (or the control plane is out of reach): prerequisites count as the contract file states them",
    );
  }
  const audit = await auditProgramGates(environment, contract, repoPath);
  describeAudit(environment, audit);
  return audit.red ? 1 : 0;
};
