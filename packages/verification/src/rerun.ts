/**
 * Running a failed check once more, to tell a flake from a failure (P15, D-P15-06).
 *
 * A check that failed is run again exactly once, in the same directory, with
 * no setup before it: the caller has already prepared the checkout and does not
 * reset it. What it does with the two results (a flake when the rerun passed, a
 * failure when it did not) is the execution layer's to decide and record; this
 * module only says which checks qualify and runs them.
 *
 * A check qualifies when it ran and exited non-zero without *declaring* that it
 * could not run (exit 75 and a `NIGHTSHIFT_DEFER` line, see `defer.ts`): a
 * declared hurdle is a deferral, and running it again would only declare it
 * again. A check that never ran (waiting on a prerequisite) has no result here
 * at all, and a failed setup leaves no check results to rerun.
 */
import type { VerificationStep } from "@nightshift/contracts";
import { deferSignalOf } from "./defer.js";
import { type RunVerificationInput, runVerificationSteps, type StepResult } from "./run.js";

/** A check that failed once, and what it did when it was run again. */
export interface CheckRerun {
  readonly first: StepResult;
  readonly rerun: StepResult;
}

/** The results of checks that failed and did not declare a deferral, in order. */
export const rerunnableChecks = (results: readonly StepResult[]): readonly StepResult[] =>
  results.filter(
    (result) =>
      result.exitCode !== 0 &&
      deferSignalOf(result.exitCode, new TextDecoder().decode(result.output)) === undefined,
  );

export type RerunChecksInput = Omit<RunVerificationInput, "steps"> & {
  /** The checks as the contract defines them; only those with a rerunnable first result run. */
  readonly steps: readonly VerificationStep[];
  /** The first run's results. */
  readonly first: readonly StepResult[];
};

/** Reruns each rerunnable check once, in order, with no setup. Empty when none failed. */
export const rerunFailedChecks = async (
  input: RerunChecksInput,
): Promise<readonly CheckRerun[]> => {
  const { first, steps, ...rest } = input;
  const failed = rerunnableChecks(first);
  if (failed.length === 0) return [];
  const byId = new Map(steps.map((step) => [step.id, step]));
  const again = failed.flatMap((result) => {
    const step = byId.get(result.stepId);
    return step === undefined ? [] : [step];
  });
  const reruns = await runVerificationSteps({ ...rest, steps: again });
  return reruns.flatMap((rerun) => {
    const firstRun = failed.find((result) => result.stepId === rerun.stepId);
    return firstRun === undefined ? [] : [{ first: firstRun, rerun }];
  });
};
