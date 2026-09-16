/**
 * Turning step results into the shape a `Verification` record carries.
 *
 * `VerificationSchema` cross-checks its own outcome: `passed` requires every
 * exit code to be zero. That rule is computed here, once, so the execution
 * layer cannot state an outcome its own evidence contradicts and then discover
 * it at the persistence boundary.
 */
import type {
  ArtifactId,
  VerificationCommandResult,
  VerificationOutcome,
} from "@nightshift/contracts";
import type { StepResult } from "./run.js";

/**
 * The `commands` array for a `Verification`, given a log artifact id per step.
 *
 * Output never travels inline (A-08): the record references an artifact and the
 * bytes live in S3. A step with no entry in the map yields a result with no
 * `logArtifactId` — the key is omitted rather than set to `undefined`, which is
 * what `exactOptionalPropertyTypes` and a `strictObject` schema both require.
 */
export const toVerificationCommands = (
  results: readonly StepResult[],
  logArtifactIds: ReadonlyMap<string, ArtifactId>,
): readonly VerificationCommandResult[] =>
  results.map((result) => {
    const base = {
      stepId: result.stepId,
      command: result.command,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
    };
    const logArtifactId = logArtifactIds.get(result.stepId);
    return logArtifactId === undefined ? base : { ...base, logArtifactId };
  });

/**
 * `passed` only when every exit code is zero.
 *
 * An empty result set is `failed`, not a vacuous pass: no evidence is not a
 * pass, and a `Verification` needs at least one command anyway. A Program
 * Contract always carries at least one verification step, so this is a guard
 * against a caller that lost the steps, not a real outcome.
 */
export const outcomeOf = (results: readonly StepResult[]): VerificationOutcome =>
  results.length > 0 && results.every((result) => result.exitCode === 0) ? "passed" : "failed";
