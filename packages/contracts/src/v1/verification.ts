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
  RoutingDecisionIdSchema,
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
    /**
     * The step's automatic rerun on the same checkout when it failed again
     * (D-P15-06). The command's own fields stay the first run, so every other
     * reader is unchanged; `flaky` is the opposite case, a rerun that passed.
     */
    rerun: z
      .strictObject({
        exitCode: z.int(),
        durationMs: z.int().min(0),
        logArtifactId: ArtifactIdSchema.optional(),
      })
      .optional(),
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
  )
  /** A failed rerun belongs to a step that ran and failed, and itself failed. */
  .refine(
    (value) =>
      value.rerun === undefined ||
      (value.exitCode !== undefined &&
        value.exitCode !== 0 &&
        value.flaky === undefined &&
        value.deferred === undefined &&
        value.skipped === undefined &&
        value.rerun.exitCode !== 0),
    {
      message:
        "rerun is only set on a step that ran and failed, never with flaky, deferred or skipped, and the rerun itself failed",
      path: ["rerun"],
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

/**
 * The verification phases, declared once. The order is the order the report
 * and Studio render: queue / candidate / end.
 */
export const VERIFICATION_PHASES = ["queue", "candidate", "run"] as const;
export type VerificationPhase = (typeof VERIFICATION_PHASES)[number];
export const VerificationPhaseSchema = z.enum(VERIFICATION_PHASES);

/**
 * Whether a verification of this phase names a job. Total over the phases, so a
 * new phase must state it.
 */
export const VERIFICATION_PHASE_HAS_JOB: Readonly<Record<VerificationPhase, boolean>> = {
  queue: true,
  candidate: true,
  run: false,
};

/**
 * Where a verification ran: on the operator's `laptop`, or on a `machine`
 * identified by its generation and runner image version.
 */
export const VerificationEnvironmentSchema = z.discriminatedUnion("where", [
  z.strictObject({ where: z.literal("laptop") }),
  z.strictObject({
    where: z.literal("machine"),
    generation: z.int().min(1),
    imageVersion: z.string().min(1),
  }),
]);
export type VerificationEnvironment = z.infer<typeof VerificationEnvironmentSchema>;

export const VerificationSchema = z
  .strictObject({
    ...runScoped,
    verificationId: VerificationIdSchema,
    executionNodeId: ExecutionNodeIdSchema,
    /** `null` exactly for a `run` verification: the program node has no job (A-57). */
    jobContractId: JobContractIdSchema.nullable(),
    /** The agent whose work is under verification, not a verifying agent. */
    agentId: AgentIdSchema,
    /**
     * P20: the routing decision of the work attempt whose commit this verified.
     * Absent when not known, and on every record written before it.
     */
    routingDecisionId: RoutingDecisionIdSchema.optional(),
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
    phase: VerificationPhaseSchema.optional(),
    /**
     * The commit the verified commit was checked against, or landed onto.
     * Absent when not known, and on every record written before it.
     */
    baseSha: CommitShaSchema.optional(),
    /**
     * The P15 gate fingerprint at the verified commit.
     * Absent on every record written before it.
     */
    gateFingerprint: z.string().min(1).optional(),
    /**
     * Where the verification ran. Absent when not recorded, and on every record
     * written before it.
     */
    environment: VerificationEnvironmentSchema.optional(),
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
  .refine(
    (value) =>
      (value.jobContractId !== null) === VERIFICATION_PHASE_HAS_JOB[value.phase ?? "queue"],
    {
      message: "a run verification has no job; every other verification names one",
      path: ["jobContractId"],
    },
  );
export type Verification = z.infer<typeof VerificationSchema>;

/**
 * The step ids this verification recorded as flaky (D-P15-06): the ones a
 * repair job opened off the blocking path should name in its `gates`.
 */
export const flakyStepIds = (verification: Pick<Verification, "commands">): string[] =>
  verification.commands
    .filter((command) => command.flaky !== undefined)
    .map((command) => command.stepId);
