/**
 * Preflight: the only thing that ever marks a human prerequisite satisfied
 * (P7, D-P7-05, SC-P7-05).
 *
 * Deterministic, and no model is asked anything. Every pending prerequisite's
 * `verifyCommand` is run **verbatim** as a subprocess, with the verification
 * runner's sanitised environment and a timeout, and what is recorded is the exit
 * code: zero satisfies it, anything else leaves it pending, and the human is
 * shown the remediation they wrote at planning time. A command is in the same
 * trust class as the program's verification steps, which is why it was reviewed
 * when the plan was.
 *
 * A failed check is recorded too. "Satisfied" is what the *last* check said, so
 * a credential that has since been revoked stops counting the next time anyone
 * looks.
 */
import type { Prerequisite, ProgramContract } from "@nightshift/contracts";
import { type Clock, type ProgramScope, prerequisitesOf } from "@nightshift/core";
import { runVerificationSteps, type SpawnLike } from "@nightshift/verification";

/** Long enough for a cloud CLI to answer on a bad connection; short enough that a prompt waiting on stdin ends. */
export const PREFLIGHT_TIMEOUT_MS = 60_000;

export interface PreflightCheck {
  readonly prerequisite: Prerequisite;
  readonly exitCode: number;
  readonly timedOut: boolean;
  /** The command's combined output, for the human who has to work out why. */
  readonly output: string;
}

export interface PreflightResult {
  /** One per prerequisite that was run, in the contract's order. */
  readonly checks: readonly PreflightCheck[];
  /** Already satisfied, and not run again unless `recheck` was asked for. */
  readonly skipped: readonly Prerequisite[];
  /** Still unmet after this run. Empty means the run may start. */
  readonly pending: readonly Prerequisite[];
}

export interface PreflightInput {
  readonly contract: ProgramContract;
  /** The repository root: where a `verifyCommand` is run. */
  readonly cwd: string;
  /** Records one exit code. The control plane decides what status follows from it. */
  readonly record: (
    scope: ProgramScope,
    prerequisiteId: string,
    exitCode: number,
  ) => Promise<Prerequisite>;
  /** Only these, when given: a run checks what its first strands need. */
  readonly only?: readonly string[];
  /** Run satisfied prerequisites again as well. */
  readonly recheck?: boolean;
  readonly timeoutMs?: number;
  readonly spawn?: SpawnLike;
  readonly clock?: Clock;
}

export const runPreflight = async (input: PreflightInput): Promise<PreflightResult> => {
  const scope = { projectId: input.contract.projectId, programId: input.contract.programId };
  const considered = prerequisitesOf(input.contract).filter(
    (prerequisite) => input.only === undefined || input.only.includes(prerequisite.id),
  );
  const toRun = considered.filter(
    (prerequisite) => input.recheck === true || prerequisite.status !== "satisfied",
  );
  const skipped = considered.filter((prerequisite) => !toRun.includes(prerequisite));

  const results = await runVerificationSteps({
    steps: toRun.map((prerequisite) => ({
      id: prerequisite.id,
      command: prerequisite.verifyCommand,
    })),
    cwd: input.cwd,
    timeoutMs: input.timeoutMs ?? PREFLIGHT_TIMEOUT_MS,
    ...(input.spawn === undefined ? {} : { spawn: input.spawn }),
    ...(input.clock === undefined ? {} : { clock: input.clock }),
  });

  const checks: PreflightCheck[] = [];
  for (const result of results) {
    const recorded = await input.record(scope, result.stepId, result.exitCode);
    checks.push({
      prerequisite: recorded,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      output: new TextDecoder().decode(result.output),
    });
  }
  return {
    checks,
    skipped,
    pending: checks
      .map((check) => check.prerequisite)
      .filter((prerequisite) => prerequisite.status !== "satisfied"),
  };
};
