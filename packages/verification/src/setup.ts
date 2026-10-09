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
 *
 * An install step is skipped, and recorded as skipped, when the checkout's
 * installed tree was made for exactly these lockfiles, or can be seeded from a
 * reference checkout that was (D-P10-24; see `install.ts`).
 */
import { SETUP_STEP_ID_PREFIX, type SetupStep, type VerificationStep } from "@nightshift/contracts";
import { isInstallStep } from "@nightshift/core";
import { planInstall, RUNTIMES_ENV, runtimeHashes, writeInstallMarker } from "./install.js";
import { type RunVerificationInput, runVerificationSteps, type StepResult } from "./run.js";

/** A setup step as it is run and recorded: its id prefixed, so it cannot collide with a check's. */
export const setupAsStep = (step: SetupStep): VerificationStep => ({
  id: `${SETUP_STEP_ID_PREFIX}${step.id}`,
  command: step.command,
});

export type RunSetupInput = Omit<RunVerificationInput, "steps"> & {
  readonly setup: readonly SetupStep[];
  /**
   * A checkout whose installed tree may seed this one when their lockfiles
   * match (D-P10-24): the run's program checkout. Without it, a checkout with
   * no tree installs.
   */
  readonly reference?: string;
};

/** What a skipped install leaves in the record: its id, its command, and why it did not run. */
const skippedStep = (step: SetupStep, reason: string): StepResult => ({
  stepId: setupAsStep(step).id,
  command: step.command,
  exitCode: 0,
  durationMs: 0,
  output: new TextEncoder().encode(`[setup skipped] ${reason}\n`),
  timedOut: false,
});

/**
 * Runs setup in order, stopping at the first step that does not exit 0. Install
 * steps are skipped when the tree fits the lockfiles; when they run and pass,
 * the tree is marked with the lockfiles it was installed for.
 */
export const runSetupSteps = async (input: RunSetupInput): Promise<readonly StepResult[]> => {
  const { setup, reference, ...rest } = input;
  // The runtimes the steps run on: the caller's environment over the engine's.
  const runtimes = runtimeHashes(rest.env?.[RUNTIMES_ENV] ?? process.env[RUNTIMES_ENV]);
  const plan = await planInstall(rest.cwd, setup, reference, runtimes);
  const results: StepResult[] = [];
  let installed = false;
  for (const step of setup) {
    if (plan.skipInstalls && isInstallStep(step.command)) {
      results.push(skippedStep(step, plan.reason));
      continue;
    }
    const [result] = await runVerificationSteps({ ...rest, steps: [setupAsStep(step)] });
    if (result === undefined) break;
    results.push(result);
    if (result.exitCode !== 0) break;
    if (isInstallStep(step.command)) installed = true;
  }
  if (installed && !setupFailed(results)) await writeInstallMarker(rest.cwd, plan.hashes);
  return results;
};

export const setupFailed = (results: readonly StepResult[]): boolean =>
  results.some((result) => result.exitCode !== 0);

export type RunCheckoutInput = RunVerificationInput & {
  readonly setup: readonly SetupStep[];
  readonly reference?: string;
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
  const { setup: setupSteps, steps, reference, ...rest } = input;
  const setup = await runSetupSteps({
    ...rest,
    setup: setupSteps,
    ...(reference === undefined ? {} : { reference }),
  });
  if (setupFailed(setup)) return { setup, checks: [], setupFailed: true };
  const checks = await runVerificationSteps({ ...rest, steps });
  return { setup, checks, setupFailed: false };
};
