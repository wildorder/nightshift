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
 * - `LineDispatch`: the owner's machine, shaped like a run `Dispatch` and
 *   fenced by the same generation, which keeps increasing across dispatches.
 * - `ProjectSelfStartedUsage`: what the plane's own starts cost this month, for
 *   the project's cap.
 *
 * The rules are `core`'s (`rules/line.ts`); this is only the records.
 */
import { z } from "zod";
import {
  AgentIdSchema,
  JobContractIdSchema,
  ProgramIdSchema,
  RunIdSchema,
  VerificationIdSchema,
} from "../ids.js";
import { CommitShaSchema, IsoTimestampSchema, projectScoped } from "./common.js";
import { ComputeTierSchema } from "./compute.js";
import { CalendarMonthSchema } from "./compute-usage.js";
import {
  DispatchAttemptSchema,
  DispatchCleanupSchema,
  DispatchProgressSchema,
  DispatchSpendSchema,
  DispatchStatusSchema,
  DispatchWorkspaceSchema,
  HeartbeatBodySchema,
  HeartbeatResponseSchema,
  RunnerStageSchema,
} from "./dispatch.js";
import { EffectivePolicySchema } from "./org-config.js";
import { RouteTargetSchema } from "./routing-decision.js";
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
/** The most resolver decisions a line record keeps, and agent announcements a line dispatch keeps, the newest. */
export const MAX_LINE_DECISIONS = 50;
export const MAX_LINE_AGENTS = 50;

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

/** What the resolver's fix was made of: the program's range, or the line's own main. */
export const LineUnitSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("main"), commit: CommitShaSchema }),
  z.strictObject({ kind: z.literal("range"), range: LineRangeSchema }),
]);
export type LineUnit = z.infer<typeof LineUnitSchema>;

/** The body of a resolver's decision, as the execution's `LineResolverDecision`. */
export const LineResolverDecisionBodySchema = z.strictObject({
  authority: z.literal("line"),
  unit: LineUnitSchema,
  base: CommitShaSchema,
  commit: CommitShaSchema,
  context: z.string(),
  alternatives: z.array(
    z.strictObject({ summary: z.string(), rejectedBecause: z.string().optional() }),
  ),
  choice: z.string(),
  rationale: z.string(),
  reversibility: z.literal("reversible"),
  resolverModel: z.string(),
  examinerModel: z.string(),
  attempts: z.int().min(0),
  verificationId: VerificationIdSchema,
  decidedAt: IsoTimestampSchema,
});
export type LineResolverDecisionBody = z.infer<typeof LineResolverDecisionBodySchema>;

/** A resolver decision stored on the line record: recorded as a decision for later review (D-03). */
export const LineDecisionSchema = LineResolverDecisionBodySchema.extend({
  decisionId: z.string().min(1),
  /** The owner generation that recorded it. */
  generation: z.int().min(1),
});
export type LineDecision = z.infer<typeof LineDecisionSchema>;

/** `POST …/line/decisions?branch=`. */
export const LineDecisionBodySchema = LineResolverDecisionBodySchema.extend({
  generation: z.int().min(1),
});
export type LineDecisionBody = z.infer<typeof LineDecisionBodySchema>;

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

export const LineRecordSchema = z.strictObject({
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
  /** Newest `MAX_LINE_DECISIONS` kept. Records from before decisions have none. */
  decisions: z.array(LineDecisionSchema).optional(),
  updatedAt: IsoTimestampSchema,
});
export type LineRecord = z.infer<typeof LineRecordSchema>;

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

export const LineDispatchFailureCodeSchema = z.enum([
  "provisioning_failed",
  "recovery_exhausted",
  "wall_clock",
  "run_cap",
  "line_cap",
  "org_month",
  "cancelled",
  "setup_failed",
  "environment_fault",
  "routes_limited",
]);
export type LineDispatchFailureCode = z.infer<typeof LineDispatchFailureCodeSchema>;

export const LineDispatchFailureSchema = z.strictObject({
  code: LineDispatchFailureCodeSchema,
  message: z.string().min(1),
});
export type LineDispatchFailure = z.infer<typeof LineDispatchFailureSchema>;

/**
 * The cleanup of a line dispatch: a run's, and `settledAt` once the instance is
 * terminated and the volume deleted, or nothing was ever launched. A new
 * dispatch of the line is stored only after the last one settled.
 */
export const LineDispatchCleanupSchema = DispatchCleanupSchema.extend({
  settledAt: IsoTimestampSchema.optional(),
});
export type LineDispatchCleanup = z.infer<typeof LineDispatchCleanupSchema>;

/** An agent the line owner announced before running it (A-04: nothing executes without a recorded identity). */
export const LineAgentSchema = z.strictObject({
  agentId: AgentIdSchema,
  generation: z.int().min(1),
  role: z.enum(["line_resolver", "line_examiner"]),
  model: RouteTargetSchema,
  announcedAt: IsoTimestampSchema,
});
export type LineAgent = z.infer<typeof LineAgentSchema>;

export const LineDispatchSchema = z.strictObject({
  ...projectScoped,
  branch: LineBranchSchema,
  /** Compare-and-swap version. */
  version: z.int().min(1),
  status: DispatchStatusSchema,
  tier: ComputeTierSchema,
  instanceType: z.string().min(1),
  usdPerHour: z.number().positive(),
  workspace: DispatchWorkspaceSchema.optional(),
  amiVersion: z.string().min(1),
  availabilityZone: z.string().min(1).optional(),
  instanceId: z.string().min(1).optional(),
  volumeId: z.string().min(1).optional(),
  /** The fence. Keeps increasing across successive dispatches of one line. */
  generation: z.int().min(1),
  leaseExpiresAt: IsoTimestampSchema.optional(),
  /** The identity the line owner's token is minted for. */
  engineAgentId: AgentIdSchema,
  attempts: z.array(DispatchAttemptSchema).min(1),
  spend: DispatchSpendSchema,
  cleanup: LineDispatchCleanupSchema,
  failure: LineDispatchFailureSchema.optional(),
  /** Newest `MAX_LINE_AGENTS` kept. Dispatches from before announcements have none. */
  agents: z.array(LineAgentSchema).optional(),
  progress: DispatchProgressSchema.optional(),
  stages: z
    .array(
      z.strictObject({
        generation: z.int().min(1),
        stage: RunnerStageSchema,
        startedAt: IsoTimestampSchema,
      }),
    )
    .max(64)
    .optional(),
  priceBasis: z
    .strictObject({
      usdPerHour: z.number().min(0),
      volumeUsdPerHour: z.number().min(0),
      source: z.string().max(200),
      asOf: z.string().max(40),
      region: z.string().max(40),
    })
    .optional(),
  requestedAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
});
export type LineDispatch = z.infer<typeof LineDispatchSchema>;

/** `POST …/line/batch?branch=`. */
export const TakeLineBatchBodySchema = z.strictObject({
  generation: z.int().min(1),
});
export type TakeLineBatchBody = z.infer<typeof TakeLineBatchBodySchema>;

export const TakeLineBatchResponseSchema = z.strictObject({
  batch: LineBatchSchema.optional(),
});
export type TakeLineBatchResponse = z.infer<typeof TakeLineBatchResponseSchema>;

/** `POST …/line/agents?branch=`. */
export const LineAgentBodySchema = z.strictObject({
  generation: z.int().min(1),
  agent: LineAgentSchema.omit({ generation: true }),
});
export type LineAgentBody = z.infer<typeof LineAgentBodySchema>;

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

/** `POST …/line/heartbeat?branch=`: a run's heartbeat, where it fits. */
export const LineHeartbeatBodySchema = HeartbeatBodySchema;
export type LineHeartbeatBody = z.infer<typeof LineHeartbeatBodySchema>;
export const LineHeartbeatResponseSchema = HeartbeatResponseSchema;
export type LineHeartbeatResponse = z.infer<typeof LineHeartbeatResponseSchema>;

/** `GET …/line?branch=`. */
export const LineViewSchema = z.strictObject({
  record: LineRecordSchema,
  dispatch: LineDispatchSchema.optional(),
  usage: ProjectSelfStartedUsageSchema.optional(),
  /** The policy the line's agents route under; absent while the org has no config. */
  policy: EffectivePolicySchema.optional(),
  /** The programs that feed this line, with their branches. */
  programs: z.array(z.strictObject({ program: ProgramIdSchema, branch: z.string().min(1) })),
});
export type LineView = z.infer<typeof LineViewSchema>;
