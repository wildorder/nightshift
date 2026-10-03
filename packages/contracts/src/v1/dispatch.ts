/**
 * Dispatch — the machine side of one remote run (P10, D-P10-18).
 *
 * A run says what is executed; a dispatch says where, on what, and whether the
 * runner holding it is still the one that may write. It is run scoped like
 * every aggregate under a run, and separate from `Run` because the two have
 * different lifecycles: a run can be `running` through three machines.
 *
 * ## The generation
 *
 * Every write a runner sends carries the dispatch's `generation`, and the API
 * refuses one that is not current. That is the fence: a replacement bumps the
 * generation, so the old runner is refused rather than asked to stop. The rule
 * is `core`'s (`rules/dispatch.ts`); this is only the record.
 */
import { z } from "zod";
import { AgentIdSchema } from "../ids.js";
import { CommitShaSchema, IsoTimestampSchema, runScoped } from "./common.js";
import { ComputeTierSchema } from "./compute.js";

export const DispatchStatusSchema = z.enum([
  "requested",
  "provisioning",
  "ready",
  "running",
  "stopping",
  "stopped",
  "failed",
]);
export type DispatchStatus = z.infer<typeof DispatchStatusSchema>;

/** Why a machine was launched: the first time, a recovery, or a human's resume. */
export const DispatchAttemptReasonSchema = z.enum(["dispatch", "lease_lost", "resume"]);
export type DispatchAttemptReason = z.infer<typeof DispatchAttemptReasonSchema>;

export const DispatchAttemptSchema = z.strictObject({
  generation: z.int().min(1),
  reason: DispatchAttemptReasonSchema,
  startedAt: IsoTimestampSchema,
  endedAt: IsoTimestampSchema.optional(),
  instanceId: z.string().min(1).optional(),
  /** Seconds this machine has been metered for, from its heartbeats. */
  meteredSeconds: z.int().min(0).optional(),
});
export type DispatchAttempt = z.infer<typeof DispatchAttemptSchema>;

/** What was authorised: a repository, a branch, the exact base and the ratified plan (D-P10-02). */
export const DispatchInputSchema = z.strictObject({
  repositoryUrl: z.string().min(1),
  branch: z.string().min(1),
  baseSha: CommitShaSchema,
  planHash: z.string().min(1),
});
export type DispatchInput = z.infer<typeof DispatchInputSchema>;

export const DispatchSpendSchema = z.strictObject({
  /** Hours at the run's ceiling times the tier's price, plus the volume, at dispatch. */
  estimatedUsd: z.number().min(0),
  /** From the heartbeats so far. */
  meteredUsd: z.number().min(0),
  meteredSeconds: z.int().min(0),
});
export type DispatchSpend = z.infer<typeof DispatchSpendSchema>;

export const PublicationIntentStatusSchema = z.enum([
  "pending",
  "published",
  "conflict",
  "protected",
  "error",
]);
export type PublicationIntentStatus = z.infer<typeof PublicationIntentStatusSchema>;

/**
 * One request to move the program branch (D-P10-22): to `head`, from
 * `expectedPredecessor`, with the commits durable in a bundle first. The
 * publisher resolves it; a conflict is never retried with force.
 */
export const PublicationIntentSchema = z.strictObject({
  head: CommitShaSchema,
  expectedPredecessor: CommitShaSchema,
  /** The bundle's key in the run's prefix of the artifact bucket. */
  bundleKey: z.string().min(1),
  status: PublicationIntentStatusSchema,
  requestedAt: IsoTimestampSchema,
  resolvedAt: IsoTimestampSchema.optional(),
  detail: z.string().min(1).optional(),
});
export type PublicationIntent = z.infer<typeof PublicationIntentSchema>;

/** `POST …/runs/{runId}/publication`. */
export const PublicationIntentBodySchema = PublicationIntentSchema.pick({
  head: true,
  expectedPredecessor: true,
  bundleKey: true,
});
export type PublicationIntentBody = z.infer<typeof PublicationIntentBodySchema>;

/** Resolved intents are dropped past this many, the newest kept, so the record stays small. */
export const MAX_RESOLVED_INTENTS = 20;

export const DispatchPublicationSchema = z.strictObject({
  /** The program branch's head at GitHub, as last published. */
  head: CommitShaSchema.optional(),
  lastIntentAt: IsoTimestampSchema.optional(),
  /** Why publication cannot proceed: the branch moved, protection refused, the App was removed. */
  blocked: z.string().min(1).optional(),
  /** Pending intents, and the most recent resolved ones. */
  intents: z.array(PublicationIntentSchema),
});
export type DispatchPublication = z.infer<typeof DispatchPublicationSchema>;

export const DispatchCleanupSchema = z.strictObject({
  snapshotId: z.string().min(1).optional(),
  /** Set when EC2 reports the snapshot complete; until then the volume is kept. */
  snapshotTakenAt: IsoTimestampSchema.optional(),
  volumeDeleted: z.boolean(),
  failures: z.array(z.string().min(1)),
});
export type DispatchCleanup = z.infer<typeof DispatchCleanupSchema>;

export const DispatchFailureCodeSchema = z.enum([
  "provisioning_failed",
  "recovery_exhausted",
  "wall_clock",
  "run_cap",
  "cancelled",
  "input_refused",
]);
export type DispatchFailureCode = z.infer<typeof DispatchFailureCodeSchema>;

/**
 * Where the workspace lives and how fast its volume is (measured 2026-10-03).
 * `volume`: the EBS workspace as D-P10-15 designed it, with gp3's dials left
 * at the baseline unless `iops` and `throughputMiBps` say otherwise. `local`:
 * the instance's own NVMe, which does not survive the instance; the EBS
 * volume is still attached as the recovery point but holds nothing.
 */
export const DispatchWorkspaceSchema = z.strictObject({
  disk: z.enum(["volume", "local"]),
  /** gp3: 3,000 free, up to 16,000. */
  iops: z.int().min(3000).max(16000).optional(),
  /** gp3: 125 free, up to 1,000. */
  throughputMiBps: z.int().min(125).max(1000).optional(),
});
export type DispatchWorkspace = z.infer<typeof DispatchWorkspaceSchema>;

export const DispatchSchema = z.strictObject({
  ...runScoped,
  status: DispatchStatusSchema,
  tier: ComputeTierSchema,
  instanceType: z.string().min(1),
  usdPerHour: z.number().positive(),
  /** Absent means the EBS volume at gp3's baseline. */
  workspace: DispatchWorkspaceSchema.optional(),
  /** The Nightshift AMI the machine runs; recovery relaunches the same (D-P10-16). */
  amiVersion: z.string().min(1),
  availabilityZone: z.string().min(1).optional(),
  instanceId: z.string().min(1).optional(),
  volumeId: z.string().min(1).optional(),
  /** The fence. Starts at 1; a replacement increments it. */
  generation: z.int().min(1),
  leaseExpiresAt: IsoTimestampSchema.optional(),
  /** The caller's key: a retried dispatch under the same key is this dispatch. */
  idempotencyKey: z.string().min(1),
  /**
   * The identity the engine's token is minted for (D-P10-20). Not an `Agent`:
   * the engine is Nightshift, not an agent; it is an identifier the token's
   * `sub` carries and the record can be read by.
   */
  engineAgentId: AgentIdSchema,
  input: DispatchInputSchema,
  attempts: z.array(DispatchAttemptSchema).min(1),
  spend: DispatchSpendSchema,
  publication: DispatchPublicationSchema,
  cleanup: DispatchCleanupSchema,
  failure: z
    .strictObject({ code: DispatchFailureCodeSchema, message: z.string().min(1) })
    .optional(),
  /** The root orchestrator's harness session, so a replacement resumes it (D-P10-20). */
  rootSessionId: z.string().min(1).optional(),
  /** `sha256` per lockfile path, as the runner last reported them, for the warm cache (D-P10-15). */
  lockfileHashes: z.record(z.string().min(1), z.string().min(1)).optional(),
  requestedAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
});
export type Dispatch = z.infer<typeof DispatchSchema>;

/** `POST …/runs/{runId}/dispatch`. */
export const DispatchBodySchema = z.strictObject({
  tier: ComputeTierSchema,
  input: DispatchInputSchema,
  idempotencyKey: z.string().min(1),
});
export type DispatchBody = z.infer<typeof DispatchBodySchema>;

/** One sample the runner took, folded by the API into the run's `ComputeUtilization`. */
export const UtilizationSampleSchema = z.strictObject({
  memoryPct: z.number().min(0).max(100),
  cpuPct: z.number().min(0).max(100),
  diskPct: z.number().min(0).max(100),
  swapUsed: z.boolean(),
  /** Since boot. */
  oomKills: z.int().min(0),
});
export type UtilizationSample = z.infer<typeof UtilizationSampleSchema>;

/** What a heartbeat can report about where the runner has got to. */
export const HeartbeatReportSchema = z.enum(["ready", "running", "stopped"]);
export type HeartbeatReport = z.infer<typeof HeartbeatReportSchema>;

/** `POST …/runs/{runId}/dispatch/heartbeat`. */
export const HeartbeatBodySchema = z.strictObject({
  generation: z.int().min(1),
  /** A milestone reached since the last heartbeat, when there is one. */
  report: HeartbeatReportSchema.optional(),
  /** Seconds the machine has been metered for, since this attempt started. */
  meteredSeconds: z.int().min(0),
  samples: z.array(UtilizationSampleSchema),
  /** The first setup's duration, once, when it is known. */
  setupSeconds: z.number().min(0).optional(),
  /** `sha256` per lockfile path, for the warm cache's record (D-P10-15). */
  lockfileHashes: z.record(z.string().min(1), z.string().min(1)).optional(),
  rootSessionId: z.string().min(1).optional(),
});
export type HeartbeatBody = z.infer<typeof HeartbeatBodySchema>;

/**
 * What the runner is told. `credentials` carries the org's provider keys to
 * `engine` and nothing else (D-P10-23); it is present only while the dispatch
 * is `running` and the generation matched.
 */
export const HeartbeatResponseSchema = z.strictObject({
  generation: z.int().min(1),
  status: DispatchStatusSchema,
  leaseExpiresAt: IsoTimestampSchema,
  /** The renewed engine token, when the plane can mint one. */
  token: z.string().min(1).optional(),
  tokenExpiresAt: IsoTimestampSchema.optional(),
  /** The runner must stop: cancelled, over a ceiling, or superseded. */
  stop: z.boolean(),
  credentials: z.record(z.string().min(1), z.string().min(1)).optional(),
});
export type HeartbeatResponse = z.infer<typeof HeartbeatResponseSchema>;

/**
 * Peaks and counts over a run's machine (D-P10-14b). Folded from the
 * heartbeats' samples by the API, read by the right-sizing rule in `core`.
 */
export const ComputeUtilizationSchema = z.strictObject({
  ...runScoped,
  tier: ComputeTierSchema,
  samples: z.int().min(0),
  peakMemoryPct: z.number().min(0).max(100),
  peakCpuPct: z.number().min(0).max(100),
  /** The fraction of samples with CPU above 90%. */
  cpuAbove90Pct: z.number().min(0).max(1),
  peakDiskPct: z.number().min(0).max(100),
  oomKills: z.int().min(0),
  swapUsed: z.boolean(),
  setupSeconds: z.number().min(0).optional(),
  wallClockSeconds: z.int().min(0),
  updatedAt: IsoTimestampSchema,
});
export type ComputeUtilization = z.infer<typeof ComputeUtilizationSchema>;
