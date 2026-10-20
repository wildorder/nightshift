/**
 * Verification — deterministic, Nightshift-owned evidence (A-05).
 *
 * A worker may report completion; only this record can make a node `verified`,
 * and `core` refuses to mark a node verified without one whose job, commit and
 * ownership chain match. Logs live in S3 and are referenced, never inlined
 * (A-08).
 */
import { z } from "zod";
import {
  AgentIdSchema,
  ArtifactIdSchema,
  DecisionIdSchema,
  ExecutionNodeIdSchema,
  JobContractIdSchema,
  VerificationIdSchema,
} from "../ids.js";
import { CommitShaSchema, IsoTimestampSchema, runScoped } from "./common.js";
import { PrerequisiteIdSchema } from "./plan.js";

/**
 * `deferred` (P7, D-P7-10): every step that could run passed, and at least one
 * could not run for an unmet human prerequisite. It is not `passed`, and `core`
 * accepts only `passed` as evidence, so it verifies nothing.
 */
export const VerificationOutcomeSchema = z.enum(["passed", "failed", "deferred"]);
export type VerificationOutcome = z.infer<typeof VerificationOutcomeSchema>;

/** The result of running one `VerificationStep` from the Program Contract. */
export const VerificationCommandResultSchema = z
  .strictObject({
    /** Matches `VerificationStep.id` on the Program Contract. */
    stepId: z.string().min(1),
    command: z.string().min(1),
    /** Absent exactly when the step was deferred or skipped: a step that did not run has no exit code. */
    exitCode: z.int().optional(),
    durationMs: z.int().min(0),
    /**
     * How long the step was quiet before its first output (P17, D-P17-05);
     * absent on records written before it was measured, and on a deferred or skipped step.
     */
    quietMs: z.int().min(0).optional(),
    /** Full output lives in S3. Never inline it here (A-08). */
    logArtifactId: ArtifactIdSchema.optional(),
    /**
     * Set when the step **could not run**, naming the prerequisite it waits on
     * (D-P7-10). A step that ran and failed is a failure, never a deferral, which
     * is why this and an exit code cannot both be present.
     */
    deferred: z.strictObject({ prerequisiteId: PrerequisiteIdSchema }).optional(),
    /**
     * P15 (D-P15-06): set when this check failed and then passed when
     * verification reran it once on the same pristine checkout. The step's own
     * `exitCode`/`durationMs`/`logArtifactId` are the rerun's; these three are
     * the failed first run that make it flaky rather than simply green.
     */
    flaky: z
      .strictObject({
        firstExitCode: z.int(),
        firstDurationMs: z.int().min(0),
        firstLogArtifactId: ArtifactIdSchema.optional(),
      })
      .optional(),
    /**
     * Set when the run's orchestrator skipped the step by a recorded decision
     * (P19, D-05/D-06). The step did not run, so it has no exit code, no
     * quietMs, no deferred and no flaky.
     */
    skipped: z.strictObject({ decisionId: DecisionIdSchema }).optional(),
  })
  .refine(
    (value) => {
      const ran = value.exitCode !== undefined;
      const deferred = value.deferred !== undefined;
      const skipped = value.skipped !== undefined;
      if (skipped) return !ran && !deferred && value.quietMs === undefined;
      return ran !== deferred;
    },
    {
      message:
        "a step either ran and has an exit code, was deferred and has none, or was skipped and has neither an exit code, a deferral nor a quietMs",
      path: ["exitCode"],
    },
  )
  /** A flake is a failure that then passed; it cannot be recorded on a step that did neither. */
  .refine(
    (value) =>
      value.flaky === undefined || (value.exitCode === 0 && value.flaky.firstExitCode !== 0),
    {
      message: "flaky is only set on a step whose rerun passed after a first run that failed",
      path: ["flaky"],
    },
  );
export type VerificationCommandResult = z.infer<typeof VerificationCommandResultSchema>;

/**
 * The one outcome a set of command results can have. A failure outranks a
 * deferral: claiming a hurdle never hides a step that ran and failed (D-P7-10).
 * A skipped step (P19) did not run and never decides the outcome. A flaky command's own `exitCode` is 0, so it already counts as passed here;
 * D-P15-06 asks only that the flake not climb the route, not that it change
 * the outcome.
 */
export const outcomeOfCommands = (
  commands: readonly {
    readonly exitCode?: number | undefined;
    readonly deferred?: unknown;
    readonly skipped?: unknown;
  }[],
): VerificationOutcome => {
  if (
    commands.some(
      (command) =>
        command.deferred === undefined && command.skipped === undefined && command.exitCode !== 0,
    )
  ) {
    return "failed";
  }
  return commands.some((command) => command.deferred !== undefined) ? "deferred" : "passed";
};

export const VerificationSchema = z
  .strictObject({
    ...runScoped,
    verificationId: VerificationIdSchema,
    executionNodeId: ExecutionNodeIdSchema,
    /** `null` exactly for a `run` verification: the program node has no job (A-57). */
    jobContractId: JobContractIdSchema.nullable(),
    /** The agent whose work is under verification, not a verifying agent. */
    agentId: AgentIdSchema,
    commitSha: CommitShaSchema,
    /**
     * P8 (D-P8-09): `candidate` is the check an examined job's snapshot gets on
     * its own base, beside the merge queue, before it is examined. It verifies
     * nothing on its own: only a `queue` verification on the program head can
     * make a node `verified`. Absent reads as `queue`.
     *
     * `run` (A-57): the run's end gates, the steps declared `at: "end"`, on the
     * program head once the work has landed. Recorded on the program node; it
     * verifies no job, and `succeeded` is refused until it has passed.
     */
    phase: z.enum(["candidate", "queue", "run"]).optional(),
    /** Set when this verification evidences a specific program success criterion. */
    criterionId: z.string().min(1).optional(),
    commands: z.array(VerificationCommandResultSchema).min(1),
    outcome: VerificationOutcomeSchema,
    startedAt: IsoTimestampSchema,
    endedAt: IsoTimestampSchema,
  })
  .refine((value) => value.outcome === outcomeOfCommands(value.commands), {
    message:
      "outcome must agree with the commands: failed when any step that ran exited non-zero, otherwise deferred when any step could not run, otherwise passed; a skipped step decides nothing",
    path: ["outcome"],
  })
  .refine((value) => (value.jobContractId === null) === (value.phase === "run"), {
    message: "a run verification has no job; every other verification names one",
    path: ["jobContractId"],
  });
export type Verification = z.infer<typeof VerificationSchema>;

/**
 * The step ids this verification recorded as flaky (D-P15-06): the ones a
 * repair job opened off the blocking path should name in its `gates`.
 */
export const flakyStepIds = (verification: Pick<Verification, "commands">): string[] =>
  verification.commands
    .filter((command) => command.flaky !== undefined)
    .map((command) => command.stepId);
