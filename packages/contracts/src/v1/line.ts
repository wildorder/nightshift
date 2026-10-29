/**
 * The project line (Pipkin M1b, "the project line in the plane").
 *
 * A project may keep one development line, a branch every program's landed
 * work meets on, composed and checked by a single line owner: a machine the
 * plane starts when work is queued, which exits when the line has caught up.
 * Everything here is project scoped, keyed by the line's branch; none of it is
 * run scoped, and nothing the line does can fail a run.
 *
 * - `LineRecord`: the queue of ranges runs published, the batch the owner took,
 *   the compositions it made, what it parked, and the one push in flight.
 * - `ProjectSelfStartedUsage`: what the plane's own starts cost this month, for
 *   the project's cap.
 *
 * The rules are `core`'s (`rules/line.ts`); this is only the records.
 */
import { z } from "zod";
import { JobContractIdSchema, ProgramIdSchema, RunIdSchema, VerificationIdSchema } from "../ids.js";
import { CommitShaSchema, IsoTimestampSchema, projectScoped } from "./common.js";
import { CalendarMonthSchema } from "./compute-usage.js";
import { DispatchStatusSchema } from "./dispatch.js";
import { EffectivePolicySchema } from "./org-config.js";
import {
  outcomeOfCommands,
  VerificationCommandResultSchema,
  VerificationOutcomeSchema,
} from "./verification.js";

export { type LineConfig, LineConfigSchema } from "./line-config.js";

/** A line's branch is a project's key into its line, so it is the whole of the line's identity beside the project. */
export const LineBranchSchema = z.string().min(1);

/** The most compositions and parked entries a line record keeps, the newest. */
export const MAX_LINE_COMPOSITIONS = 50;
export const MAX_LINE_PARKED = 50;
/** One range of a program's landed work: `from` (exclusive, absent for its start) up to `upTo`. */
export const LineRangeSchema = z.strictObject({
  program: ProgramIdSchema,
  from: CommitShaSchema.optional(),
  upTo: CommitShaSchema,
});
export type LineRange = z.infer<typeof LineRangeSchema>;

/** A published range waiting for the owner. */
export const LineQueueEntrySchema = z.strictObject({
  program: ProgramIdSchema,
  upTo: CommitShaSchema,
  enqueuedAt: IsoTimestampSchema,
});
export type LineQueueEntry = z.infer<typeof LineQueueEntrySchema>;

/** The whole queue taken by one owner generation. */
export const LineBatchSchema = z.strictObject({
  batchId: z.string().min(1),
  entries: z.array(LineQueueEntrySchema).min(1),
  takenAt: IsoTimestampSchema,
  generation: z.int().min(1),
  /** The run that holds the batch, when a line run owns it; with `generation` it is the owner. */
  runId: RunIdSchema.optional(),
});
export type LineBatch = z.infer<typeof LineBatchSchema>;

/**
 * A verification made on the line: embedded in the composition, never stored in
 * the run-scoped verification store, and never landing evidence for a run.
 */
export const LineVerificationSchema = z
  .strictObject({
    verificationId: VerificationIdSchema,
    phase: z.literal("line"),
    commitSha: CommitShaSchema,
    baseSha: CommitShaSchema,
    commands: z.array(VerificationCommandResultSchema).min(1),
    outcome: VerificationOutcomeSchema,
    startedAt: IsoTimestampSchema,
    endedAt: IsoTimestampSchema,
  })
  .refine((value) => value.outcome === outcomeOfCommands(value.commands), {
    message:
      "outcome must agree with the commands: failed when any step that ran exited non-zero, otherwise deferred when any step could not run, otherwise passed; a skipped step decides nothing",
    path: ["outcome"],
  });
export type LineVerification = z.infer<typeof LineVerificationSchema>;

/** The most resolver attempts a composition may record. */
export const MAX_LINE_RESOLVER_ATTEMPTS = 3;

export const LineResolverSchema = z.strictObject({
  decision: z.enum(["none", "resolved", "gave_up"]),
  attempts: z.int().min(0).max(MAX_LINE_RESOLVER_ATTEMPTS),
  detail: z.string().min(1).optional(),
});
export type LineResolver = z.infer<typeof LineResolverSchema>;

/** The repair job that ran for a range: the line's run and the job contract that did the repairing. */
export const LineRepairRefSchema = z.strictObject({
  runId: RunIdSchema,
  jobContractId: JobContractIdSchema,
});
export type LineRepairRef = z.infer<typeof LineRepairRefSchema>;

export const LineCompositionSchema = z.strictObject({
  compositionId: z.string().min(1),
  commit: CommitShaSchema,
  parent: CommitShaSchema,
  ranges: z.array(LineRangeSchema).min(1),
  verification: LineVerificationSchema,
  resolver: LineResolverSchema.optional(),
  repair: LineRepairRefSchema.optional(),
  composedAt: IsoTimestampSchema,
  /** Set once the publisher has moved the line to this composition's commit. */
  pushed: z.strictObject({ at: IsoTimestampSchema }).optional(),
});
export type LineComposition = z.infer<typeof LineCompositionSchema>;

export const LineParkedSchema = z.strictObject({
  compositionId: z.string().min(1),
  ranges: z.array(LineRangeSchema).min(1),
  reason: z.string().min(1),
  commit: CommitShaSchema.optional(),
  verification: LineVerificationSchema.optional(),
  resolver: LineResolverSchema.optional(),
  repair: LineRepairRefSchema.optional(),
  parkedAt: IsoTimestampSchema,
});
export type LineParked = z.infer<typeof LineParkedSchema>;

/**
 * A line verification with its command results dropped, for an event payload
 * that would exceed the inline bound with them.
 */
export const LineVerificationSummarySchema = z.strictObject({
  verificationId: VerificationIdSchema,
  phase: z.literal("line"),
  commitSha: CommitShaSchema,
  baseSha: CommitShaSchema,
  outcome: VerificationOutcomeSchema,
  startedAt: IsoTimestampSchema,
  endedAt: IsoTimestampSchema,
  commandCount: z.int().min(0),
  /** The ids of the steps that ran and exited non-zero. */
  failedStepIds: z.array(z.string()),
});
export type LineVerificationSummary = z.infer<typeof LineVerificationSummarySchema>;

/** `line.composed`: the settled composition as recorded; its verification may be summarised when it would not fit inline. */
export const LineComposedPayloadSchema = LineCompositionSchema.extend({
  verification: z.union([LineVerificationSchema, LineVerificationSummarySchema]),
});
export type LineComposedPayload = z.infer<typeof LineComposedPayloadSchema>;

/** `line.parked`: one parked entry as recorded; its verification may be summarised likewise. */
export const LineParkedPayloadSchema = LineParkedSchema.extend({
  verification: z.union([LineVerificationSchema, LineVerificationSummarySchema]).optional(),
});
export type LineParkedPayload = z.infer<typeof LineParkedPayloadSchema>;

/** The summary of a verification: everything but its command results. */
export const summariseLineVerification = (
  verification: LineVerification,
): LineVerificationSummary => ({
  verificationId: verification.verificationId,
  phase: verification.phase,
  commitSha: verification.commitSha,
  baseSha: verification.baseSha,
  outcome: verification.outcome,
  startedAt: verification.startedAt,
  endedAt: verification.endedAt,
  commandCount: verification.commands.length,
  failedStepIds: verification.commands
    .filter((c) => c.deferred === undefined && c.skipped === undefined && c.exitCode !== 0)
    .map((c) => c.stepId),
});

/** What the resolver's fix was made of: the program's range, or the line's own main. */
export const LineUnitSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("main"), commit: CommitShaSchema }),
  z.strictObject({ kind: z.literal("range"), range: LineRangeSchema }),
]);
export type LineUnit = z.infer<typeof LineUnitSchema>;

export const LinePushStatusSchema = z.enum([
  "pending",
  "published",
  "conflict",
  "protected",
  "forbidden",
  "error",
]);
export type LinePushStatus = z.infer<typeof LinePushStatusSchema>;

/** One request to move the line: to `head`, from `expectedPredecessor`, the commits durable in a bundle first. */
export const LinePushSchema = z.strictObject({
  head: CommitShaSchema,
  expectedPredecessor: CommitShaSchema,
  bundleKey: z.string().min(1),
  generation: z.int().min(1),
  status: LinePushStatusSchema,
  requestedAt: IsoTimestampSchema,
  resolvedAt: IsoTimestampSchema.optional(),
  detail: z.string().min(1).optional(),
});
export type LinePush = z.infer<typeof LinePushSchema>;

export const LineWaitingReasonSchema = z.enum([
  "monthly_cap",
  "org_month_ceiling",
  "org_concurrency",
  "not_configured",
]);
export type LineWaitingReason = z.infer<typeof LineWaitingReasonSchema>;

export const LineWaitingSchema = z.strictObject({
  reason: LineWaitingReasonSchema,
  detail: z.string().min(1),
  since: IsoTimestampSchema,
});
export type LineWaiting = z.infer<typeof LineWaitingSchema>;

const LineRecordShape = z.strictObject({
  ...projectScoped,
  branch: LineBranchSchema,
  repositoryUrl: z.string().min(1),
  /** Compare-and-swap version: every write bumps it. */
  version: z.int().min(1),
  /** The line's head at GitHub, as last known. */
  head: CommitShaSchema.optional(),
  queue: z.array(LineQueueEntrySchema),
  batch: LineBatchSchema.optional(),
  /** Newest `MAX_LINE_COMPOSITIONS` kept. */
  compositions: z.array(LineCompositionSchema),
  /** Newest `MAX_LINE_PARKED` kept. */
  parked: z.array(LineParkedSchema),
  push: LinePushSchema.optional(),
  waiting: LineWaitingSchema.optional(),
  updatedAt: IsoTimestampSchema,
});

/**
 * A stored record may still carry `decisions` or `agents` from before the line
 * became a run of the line program; they are dropped on read.
 */
export const LineRecordSchema = z.preprocess((value) => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const { decisions: _decisions, agents: _agents, ...rest } = value as Record<string, unknown>;
  return rest;
}, LineRecordShape);
export type LineRecord = z.infer<typeof LineRecordShape>;

/** What the plane's own starts have metered this month for one project, against its cap. */
export const ProjectSelfStartedUsageSchema = z.strictObject({
  ...projectScoped,
  month: CalendarMonthSchema,
  meteredUsd: z.number().min(0),
  capUsd: z.number().min(0),
  /** When the metered spend first reached the cap this month. */
  reachedAt: IsoTimestampSchema.optional(),
  /**
   * What each line dispatch has already been charged to this row, keyed
   * `<branch>#<generation>`: the dispatch's cumulative metered dollars. A charge
   * is the dispatch's spend less this, so a failed or repeated write is repaired
   * or ignored rather than lost or doubled. Rows from before it have none.
   */
  charged: z.record(z.string(), z.number().min(0)).optional(),
  version: z.int().min(1),
  updatedAt: IsoTimestampSchema,
});
export type ProjectSelfStartedUsage = z.infer<typeof ProjectSelfStartedUsageSchema>;

/** `POST …/line/batch?branch=`. */
export const TakeLineBatchBodySchema = z.strictObject({
  generation: z.int().min(1),
});
export type TakeLineBatchBody = z.infer<typeof TakeLineBatchBodySchema>;

export const TakeLineBatchResponseSchema = z.strictObject({
  batch: LineBatchSchema.optional(),
});
export type TakeLineBatchResponse = z.infer<typeof TakeLineBatchResponseSchema>;

/** `POST …/line/compositions?branch=`. */
export const LineCompositionBodySchema = z.strictObject({
  batchId: z.string().min(1),
  commit: CommitShaSchema,
  parent: CommitShaSchema,
  ranges: z.array(LineRangeSchema).min(1),
  verification: LineVerificationSchema,
  resolver: LineResolverSchema.optional(),
  repair: LineRepairRefSchema.optional(),
});
export type LineCompositionBody = z.infer<typeof LineCompositionBodySchema>;

/** `POST …/line/parked?branch=`. */
export const LineParkBodySchema = z.strictObject({
  batchId: z.string().min(1),
  ranges: z.array(LineRangeSchema).min(1),
  reason: z.string().min(1),
  commit: CommitShaSchema.optional(),
  verification: LineVerificationSchema.optional(),
  resolver: LineResolverSchema.optional(),
  repair: LineRepairRefSchema.optional(),
});
export type LineParkBody = z.infer<typeof LineParkBodySchema>;

/**
 * `POST …/line/settle?branch=`: one batch settled with what the composition
 * engine produced, a composition and/or parked entries. Neither is allowed: a
 * batch whose ranges were all on the line already.
 */
/** `POST …/line/push?branch=`. */
export const LinePushBodySchema = LinePushSchema.pick({
  head: true,
  expectedPredecessor: true,
  bundleKey: true,
});
export type LinePushBody = z.infer<typeof LinePushBodySchema>;

export const LineSettleBodySchema = z
  .strictObject({
    batchId: z.string().min(1),
    composition: LineCompositionBodySchema.omit({ batchId: true }).optional(),
    /** The publication of the composition, recorded with it so a dead owner cannot lose it. */
    push: LinePushBodySchema.optional(),
    parked: z.array(LineParkBodySchema.omit({ batchId: true })),
  })
  .superRefine((body, ctx) => {
    const { composition, push } = body;
    if (composition === undefined) {
      if (push !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["push"],
          message: "a push needs a composition to publish",
        });
      }
      return;
    }
    if (push === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["push"],
        message: "a composition must be settled with its push",
      });
      return;
    }
    if (push.head !== composition.commit) {
      ctx.addIssue({
        code: "custom",
        path: ["push", "head"],
        message: "push.head must equal composition.commit",
      });
    }
    if (push.expectedPredecessor !== composition.parent) {
      ctx.addIssue({
        code: "custom",
        path: ["push", "expectedPredecessor"],
        message: "push.expectedPredecessor must equal composition.parent",
      });
    }
  });
export type LineSettleBody = z.infer<typeof LineSettleBodySchema>;

/** `POST …/line/bundle-upload-url?branch=`. */
export const LineBundleUploadUrlBodySchema = z.strictObject({
  generation: z.int().min(1),
  id: z.string().min(1),
});
export type LineBundleUploadUrlBody = z.infer<typeof LineBundleUploadUrlBodySchema>;

/** `GET …/line?branch=`. */
export const LineViewSchema = z.strictObject({
  record: LineRecordSchema,
  /** The line's program, whose runs are the line's owner sessions. */
  programId: ProgramIdSchema,
  /** The line program's latest run, with its dispatch's status, generation and metered spend; absent while the line has had none. */
  runId: RunIdSchema.optional(),
  dispatchStatus: DispatchStatusSchema.optional(),
  generation: z.int().min(1).optional(),
  meteredUsd: z.number().min(0).optional(),
  usage: ProjectSelfStartedUsageSchema.optional(),
  /** The policy the line's agents route under; absent while the org has no config. */
  policy: EffectivePolicySchema.optional(),
  /** The programs that feed this line, with their branches. */
  programs: z.array(z.strictObject({ program: ProgramIdSchema, branch: z.string().min(1) })),
});
export type LineView = z.infer<typeof LineViewSchema>;
