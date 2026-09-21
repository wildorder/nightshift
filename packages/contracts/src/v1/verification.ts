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
    /** Absent exactly when the step was deferred: a step that did not run has no exit code. */
    exitCode: z.int().optional(),
    durationMs: z.int().min(0),
    /** Full output lives in S3. Never inline it here (A-08). */
    logArtifactId: ArtifactIdSchema.optional(),
    /**
     * Set when the step **could not run**, naming the prerequisite it waits on
     * (D-P7-10). A step that ran and failed is a failure, never a deferral, which
     * is why this and an exit code cannot both be present.
     */
    deferred: z.strictObject({ prerequisiteId: PrerequisiteIdSchema }).optional(),
  })
  .refine((value) => (value.deferred === undefined) !== (value.exitCode === undefined), {
    message: "a step either ran and has an exit code, or was deferred and has none",
    path: ["exitCode"],
  });
export type VerificationCommandResult = z.infer<typeof VerificationCommandResultSchema>;

/**
 * The one outcome a set of command results can have. A failure outranks a
 * deferral: claiming a hurdle never hides a step that ran and failed (D-P7-10).
 */
export const outcomeOfCommands = (
  commands: readonly { readonly exitCode?: number | undefined; readonly deferred?: unknown }[],
): VerificationOutcome => {
  if (commands.some((command) => command.deferred === undefined && command.exitCode !== 0)) {
    return "failed";
  }
  return commands.some((command) => command.deferred !== undefined) ? "deferred" : "passed";
};

export const VerificationSchema = z
  .strictObject({
    ...runScoped,
    verificationId: VerificationIdSchema,
    executionNodeId: ExecutionNodeIdSchema,
    jobContractId: JobContractIdSchema,
    /** The agent whose work is under verification, not a verifying agent. */
    agentId: AgentIdSchema,
    commitSha: CommitShaSchema,
    /** Set when this verification evidences a specific program success criterion. */
    criterionId: z.string().min(1).optional(),
    commands: z.array(VerificationCommandResultSchema).min(1),
    outcome: VerificationOutcomeSchema,
    startedAt: IsoTimestampSchema,
    endedAt: IsoTimestampSchema,
  })
  .refine((value) => value.outcome === outcomeOfCommands(value.commands), {
    message:
      "outcome must agree with the commands: failed when any step that ran exited non-zero, otherwise deferred when any step could not run, otherwise passed",
    path: ["outcome"],
  });
export type Verification = z.infer<typeof VerificationSchema>;
