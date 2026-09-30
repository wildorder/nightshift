/**
 * Preparing a checkout, then checking it.
 *
 * Every checkout Nightshift creates starts without the repository's ignored
 * files: no installed dependencies, no generated code. A program's `setup`
 * steps are what make one usable (see `SetupStepSchema`), and they run here,
 * before the checks, in the same directory and the same sanitised environment.
 *
 * Unlike the checks, setup stops at its first failure, and when it fails no
 * check runs at all. Each setup step builds on the last, and a test suite run
 * without its dependencies fails for a reason that has nothing to do with the
 * work, which is exactly the misleading evidence this exists to prevent. The
 * setup results say what went wrong instead.
 */
import { SETUP_STEP_ID_PREFIX, type SetupStep, type VerificationStep } from "@nightshift/contracts";
import { type RunVerificationInput, runVerificationSteps, type StepResult } from "./run.js";

/** A setup step as it is run and recorded: its id prefixed, so it cannot collide with a check's. */
export const setupAsStep = (step: SetupStep): VerificationStep => ({
  id: `${SETUP_STEP_ID_PREFIX}${step.id}`,
  command: step.command,
});

export type RunSetupInput = Omit<RunVerificationInput, "steps"> & {
  readonly setup: readonly SetupStep[];
};

/** Runs setup in order, stopping at the first step that does not exit 0. */
export const runSetupSteps = async (input: RunSetupInput): Promise<readonly StepResult[]> => {
  const { setup, ...rest } = input;
  const results: StepResult[] = [];
  for (const step of setup) {
    const [result] = await runVerificationSteps({ ...rest, steps: [setupAsStep(step)] });
    if (result === undefined) break;
    results.push(result);
    if (result.exitCode !== 0) break;
  }
  return results;
};

export const setupFailed = (results: readonly StepResult[]): boolean =>
  results.some((result) => result.exitCode !== 0);

export type RunCheckoutInput = RunVerificationInput & {
  readonly setup: readonly SetupStep[];
};

export interface CheckoutResults {
  /** One per setup step that ran, in order; the last is the failure when `setupFailed`. */
  readonly setup: readonly StepResult[];
  /** One per check. Empty when setup failed: nothing was checked. */
  readonly checks: readonly StepResult[];
  readonly setupFailed: boolean;
}

/** Setup, then, only when it all passed, every check. */
export const runCheckoutSteps = async (input: RunCheckoutInput): Promise<CheckoutResults> => {
  const { setup: setupSteps, steps, ...rest } = input;
  const setup = await runSetupSteps({ ...rest, setup: setupSteps });
  if (setupFailed(setup)) return { setup, checks: [], setupFailed: true };
  const checks = await runVerificationSteps({ ...rest, steps });
  return { setup, checks, setupFailed: false };
};
