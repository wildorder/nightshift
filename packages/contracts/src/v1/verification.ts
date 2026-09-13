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

export const VerificationOutcomeSchema = z.enum(["passed", "failed"]);
export type VerificationOutcome = z.infer<typeof VerificationOutcomeSchema>;

/** The result of running one `VerificationStep` from the Program Contract. */
export const VerificationCommandResultSchema = z.strictObject({
  /** Matches `VerificationStep.id` on the Program Contract. */
  stepId: z.string().min(1),
  command: z.string().min(1),
  exitCode: z.int(),
  durationMs: z.int().min(0),
  /** Full output lives in S3. Never inline it here (A-08). */
  logArtifactId: ArtifactIdSchema.optional(),
});
export type VerificationCommandResult = z.infer<typeof VerificationCommandResultSchema>;

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
  .refine(
    (value) =>
      value.outcome === "passed"
        ? value.commands.every((command) => command.exitCode === 0)
        : value.commands.some((command) => command.exitCode !== 0),
    {
      message:
        "outcome must agree with the command exit codes: passed requires every exit code 0, failed requires at least one non-zero",
      path: ["outcome"],
    },
  );
export type Verification = z.infer<typeof VerificationSchema>;
