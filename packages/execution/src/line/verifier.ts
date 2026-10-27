/**
 * The real adapter of {@link LineVerifierPort}: a project's landing checks run
 * on a line candidate.
 *
 * It needs no run session and no run-scoped store: the record it returns is
 * embedded in the composition, never stored as a run's `Verification`, and its
 * `line` phase is never landing evidence (core's `isLandingEvidence`).
 */
import {
  type ArtifactId,
  type CommitSha,
  type LineVerification,
  LineVerificationSchema,
  outcomeOfCommands,
  type VerificationCommandResult,
  VerificationIdSchema,
  type VerificationStep,
} from "@nightshift/contracts";
import { type Clock, type IdGenerator, nowIso } from "@nightshift/core";
import {
  runCheckoutSteps,
  type StepResult,
  setupAsStep,
  TIMEOUT_EXIT_CODE,
  toVerificationCommands,
  verificationFacts,
} from "@nightshift/verification";
import { type GateDefinitions, landingSteps } from "../gate-repair.js";
import { pristineCheckout } from "../git/operations.js";
import type { GitRunner } from "../git/runner.js";
import { discardScratch, freshScratch, projectStepEnv, type ScratchPaths } from "../scratch.js";
import { LINE_LOG_TAIL_CHARS, type LineCommandLog, type LineVerifierPort } from "./ports.js";

export interface LineVerifierOptions {
  /** The project's gates: its setup, then its landing steps (never the `at: "end"` ones). */
  gates: GateDefinitions;
  /** Mints the record's `verificationId`. */
  ids: IdGenerator;
  /** Times the record, and measures the deadline. */
  clock: Clock;
  /** Runs the git that returns a worktree to exactly the commit. */
  runner: GitRunner;
  /** Where each worktree's scratch directory lives. */
  paths: ScratchPaths;
  /** The project environment every step is given, over the sanitised base. */
  env?: Readonly<Record<string, string>>;
  /** Removes what project code wrote into a scratch, when the engine needs it done as another user. */
  reclaim?: (dir: string) => Promise<void>;
  /**
   * Keeps a step's whole output and returns its artifact id. Without it a
   * command carries no `logArtifactId`; output is never inlined in the record.
   */
  recordLog?: (input: {
    verificationId: string;
    stepId: string;
    output: Uint8Array;
  }) => Promise<ArtifactId | undefined>;
}

const decoder = new TextDecoder();

const tailOf = (output: Uint8Array): string => decoder.decode(output).slice(-LINE_LOG_TAIL_CHARS);

export const createLineVerifier = (options: LineVerifierOptions): LineVerifierPort => ({
  async verify({ worktree, commit, base, deadline }) {
    const { gates, clock } = options;
    const verificationId = VerificationIdSchema.parse(options.ids.next("ver"));
    const startedAt = nowIso(clock);
    const deadlineMs = deadline === undefined ? undefined : Date.parse(deadline);
    const remainingMs = (): number | undefined =>
      deadlineMs === undefined ? undefined : deadlineMs - clock.now();

    // Exactly the commit, ignored files included: nothing an agent left decides this.
    await pristineCheckout(options.runner, worktree.path, commit);

    const env = {
      ...(options.env ?? {}),
      ...verificationFacts({ verificationId, headSha: commit, baseSha: base }),
    };
    const results: StepResult[] = [];
    const scratch = await freshScratch(options.paths, worktree.path, options.reclaim);
    let timedOut = false;
    let notRun: { stepId: string; command: string } | undefined;
    try {
      // Each step is run on its own so the deadline is checked before it and
      // bounds it. Setup stops the run at its first failure, as it does everywhere.
      const steps: { step: VerificationStep; isSetup: boolean }[] = [
        ...gates.setup.map((s) => ({ step: setupAsStep(s), isSetup: true })),
        ...landingSteps(gates).map((s) => ({ step: s, isSetup: false })),
      ];
      for (const { step, isSetup } of steps) {
        const left = remainingMs();
        if (left !== undefined && left <= 0) {
          timedOut = true;
          notRun = { stepId: step.id, command: step.command };
          break;
        }
        // The step's own timeout, cut to the budget left. Fractional seconds are
        // fine for the runner, which only multiplies by 1000.
        const declared = step.timeoutSeconds ?? Number.POSITIVE_INFINITY;
        const budget = left === undefined ? declared : Math.min(declared, left / 1000);
        const bounded: VerificationStep =
          budget === Number.POSITIVE_INFINITY ? step : { ...step, timeoutSeconds: budget };
        const checkout = await runCheckoutSteps({
          setup: [],
          steps: [bounded],
          cwd: worktree.path,
          env: projectStepEnv(env, scratch),
          clock,
        });
        const [result] = checkout.checks;
        if (result === undefined) break;
        results.push(result);
        if (result.timedOut && budget < declared) timedOut = true;
        if (result.exitCode !== 0 && (isSetup || result.timedOut)) break;
      }
    } finally {
      await discardScratch(options.paths, worktree.path, options.reclaim);
    }

    const logArtifactIds = new Map<string, ArtifactId>();
    if (options.recordLog !== undefined) {
      for (const result of results) {
        const id = await options.recordLog({
          verificationId,
          stepId: result.stepId,
          output: result.output,
        });
        if (id !== undefined) logArtifactIds.set(result.stepId, id);
      }
    }
    const commands: VerificationCommandResult[] = [
      ...toVerificationCommands(results, logArtifactIds),
    ];
    const logs: LineCommandLog[] = results.map((result) => ({
      stepId: result.stepId,
      command: result.command,
      exitCode: result.exitCode,
      tail: tailOf(result.output),
    }));
    if (notRun !== undefined) {
      // The deadline passed before this step could start. The contract's skipped
      // and deferred forms need a decision or a prerequisite that do not exist
      // here, so the record ends at the step with the timeout's own exit code,
      // which keeps the outcome from reading as passed.
      commands.push({ ...notRun, exitCode: TIMEOUT_EXIT_CODE, durationMs: 0 });
      logs.push({
        ...notRun,
        exitCode: TIMEOUT_EXIT_CODE,
        tail: "nightshift: the composition's deadline passed before this step could start\n",
      });
    }

    if (commands.length === 0) {
      throw new Error("the project has no setup or landing steps, so there is nothing to verify");
    }
    const verification: LineVerification = LineVerificationSchema.parse({
      verificationId,
      phase: "line",
      commitSha: commit as CommitSha,
      baseSha: base,
      commands,
      outcome: outcomeOfCommands(commands),
      startedAt,
      endedAt: nowIso(clock),
    });
    return { verification, logs, timedOut };
  },
});
