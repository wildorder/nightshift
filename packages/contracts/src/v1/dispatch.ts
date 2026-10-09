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
import { AgentIdSchema, ArtifactIdSchema } from "../ids.js";
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

/**
 * Whether `version` names exactly one release of `runtime` (P16 D-03), as the
 * runtime's own `--version` reports it. A partial version (`22`, `3.12`) is a
 * pin, not a version: it would leave the patch to the machine, which may then
 * run a different build from the one the audit certified.
 *
 * - node, java and any runtime not listed: `X.Y.Z` (java may add a fourth
 *   component; its GA releases report `21`, which the CLI's parser reads as
 *   `21.0.0`);
 * - python: `X.Y.Z`, optionally a pre-release (`3.13.0rc1`);
 * - ruby: `X.Y.Z`, optionally a pre-release (`3.4.0preview1`);
 * - go: `X.Y.Z`; `X.Y` only before Go 1.21, whose first releases were named
 *   so (`go1.20`), or with a pre-release (`1.22rc1`);
 * - rust: `X.Y.Z`, optionally `-beta.N` or `-nightly`.
 */
export const isExactRuntimeVersion = (runtime: string, version: string): boolean => {
  switch (runtime) {
    case "python":
      return /^\d+\.\d+\.\d+(?:(?:a|b|rc)\d+)?$/.test(version);
    case "ruby":
      return /^\d+\.\d+\.\d+(?:-?(?:preview|rc)\d+)?$/.test(version);
    case "go": {
      const match = /^(\d+)\.(\d+)(\.\d+)?((?:rc|beta)\d+)?$/.exec(version);
      if (match === null) return false;
      if (match[3] !== undefined || match[4] !== undefined) return true;
      return Number(match[1]) === 1 && Number(match[2]) < 21;
    }
    case "java":
      return /^\d+\.\d+\.\d+(?:\.\d+)*$/.test(version);
    case "rust":
      return /^\d+\.\d+\.\d+(?:-(?:beta(?:\.\d+)?|nightly))?$/.test(version);
    default:
      return /^\d+\.\d+\.\d+$/.test(version);
  }
};

/** Where a runtime's version came from: the project's pin, or the image when the project pins none. */
export const RuntimeVersionSourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("pin"),
    /** The pin file, repository-root relative; `package.json#volta.node` for a field. */
    file: z.string().min(1),
    /** The pin's text: a version, a partial version or a range. */
    spec: z.string().min(1),
  }),
  z.strictObject({ kind: z.literal("image") }),
]);
export type RuntimeVersionSource = z.infer<typeof RuntimeVersionSourceSchema>;

/** One runtime the machine installs, at the exact version the reference audit ran on (P16 D-03). */
export const RuntimeVersionSchema = z
  .strictObject({
    /** mise's tool name: `node`, `python`, `ruby`, `go`, `java`, `rust`. */
    runtime: z.string().regex(/^[a-z][a-z0-9-]*$/),
    /** Exact, never a pin or a range: see `isExactRuntimeVersion`. */
    version: z.string().min(1),
    source: RuntimeVersionSourceSchema,
  })
  .refine((value) => isExactRuntimeVersion(value.runtime, value.version), {
    message: "version must be an exact version of the runtime, not a partial version or a range",
    path: ["version"],
  });
export type RuntimeVersion = z.infer<typeof RuntimeVersionSchema>;

/** The runtimes a dispatch carries, one entry per runtime. */
export const DispatchToolchainSchema = z
  .array(RuntimeVersionSchema)
  .refine(
    (toolchain) => new Set(toolchain.map((entry) => entry.runtime)).size === toolchain.length,
    { message: "a runtime appears at most once" },
  );
export type DispatchToolchain = z.infer<typeof DispatchToolchainSchema>;

/**
 * One gate's verdict in the reference audit, as the gate audit gave it:
 *
 * - `passed`, `failed`: the laptop's evidence, which the machine must agree with;
 * - `deferred`, `waiting`, `unrun`: no evidence from the laptop (a deferral, an
 *   unmet prerequisite, or a setup that failed before it), so the machine's own
 *   result stands.
 */
export const ReferenceGateVerdictSchema = z.enum([
  "passed",
  "failed",
  "deferred",
  "waiting",
  "unrun",
]);
export type ReferenceGateVerdict = z.infer<typeof ReferenceGateVerdictSchema>;

/** A gate with this verdict ran, so it has an output: `passed`, `failed` or `deferred`. */
export const referenceGateRan = (verdict: ReferenceGateVerdict): boolean =>
  verdict === "passed" || verdict === "failed" || verdict === "deferred";

/** The most of one gate's output a reference audit carries inline. */
export const MAX_REFERENCE_OUTPUT_TAIL_CHARS = 2000;

export const ReferenceGateSchema = z.strictObject({
  /** The gate's id as the audit names it: `setup:<id>` for a setup step. */
  id: z.string().min(1),
  kind: z.enum(["setup", "check"]),
  verdict: ReferenceGateVerdictSchema,
  /**
   * The artifact, on the run's program node, holding the gate's output tail.
   * Any gate that ran may carry one (P16 D-07), so a fault can show the
   * laptop's output beside the machine's; earlier references kept only a failed
   * gate's.
   */
  outputArtifactId: ArtifactIdSchema.optional(),
  /**
   * The last of that output, inline, so the machine can show it beside its own
   * when the gate faults without reading the artifact back: a machine's body
   * store can write but not read (P16 D-07).
   */
  outputTail: z.string().max(MAX_REFERENCE_OUTPUT_TAIL_CHARS).optional(),
});
export type ReferenceGate = z.infer<typeof ReferenceGateSchema>;

/**
 * The reference audit (P16 D-06): the gate audit `run --remote` ran on the
 * laptop at the base it dispatches, with the laptop's own prerequisite checks.
 * The machine audits the same base and compares its verdicts with these.
 */
export const ReferenceAuditSchema = z
  .strictObject({
    /** The commit audited: the dispatch's `baseSha`. */
    base: CommitShaSchema,
    /** The Node the audit ran on, exact, as `node --version` reports it without the `v`. Absent when there was none. */
    node: z.string().min(1).optional(),
    auditedAt: IsoTimestampSchema,
    gates: z.array(ReferenceGateSchema),
  })
  .refine((value) => value.node === undefined || isExactRuntimeVersion("node", value.node), {
    message: "node must be an exact Node version (X.Y.Z, without the v)",
    path: ["node"],
  })
  .refine((value) => new Set(value.gates.map((gate) => gate.id)).size === value.gates.length, {
    message: "a gate appears at most once",
    path: ["gates"],
  })
  .refine(
    (value) =>
      value.gates.every(
        (gate) => gate.outputArtifactId === undefined || referenceGateRan(gate.verdict),
      ),
    { message: "only a gate that ran carries an output artifact", path: ["gates"] },
  )
  .refine(
    (value) =>
      value.gates.every((gate) => gate.outputTail === undefined || referenceGateRan(gate.verdict)),
    { message: "only a gate that ran carries an output tail", path: ["gates"] },
  );
export type ReferenceAudit = z.infer<typeof ReferenceAuditSchema>;

/** What was authorised: a repository, a branch, the exact base and the ratified plan (D-P10-02). */
export const DispatchInputSchema = z
  .strictObject({
    repositoryUrl: z.string().min(1),
    branch: z.string().min(1),
    baseSha: CommitShaSchema,
    planHash: z.string().min(1),
    /** The runtime versions the machine installs (P16 D-03). Absent on dispatches from before P16. */
    toolchain: DispatchToolchainSchema.optional(),
    /** The laptop's gate audit of `baseSha` (P16 D-06). Absent on dispatches from before it. */
    reference: ReferenceAuditSchema.optional(),
  })
  .refine((value) => value.reference === undefined || value.reference.base === value.baseSha, {
    message: "the reference audit must be of the base dispatched",
    path: ["reference", "base"],
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
  /** The runner could not prepare the workspace: mount, clone, checkout or setup (P16 SC-07). */
  "setup_failed",
  /** A gate green in the reference audit is red on the machine (P16 D-07). */
  "environment_fault",
]);
export type DispatchFailureCode = z.infer<typeof DispatchFailureCodeSchema>;

/**
 * The failures a runner may report itself, through its heartbeat (P16 SC-07,
 * D-07). Every other code is the plane's to write: a runner cannot say it was
 * cancelled or ran over a cap.
 */
export const RunnerFailureCodeSchema = DispatchFailureCodeSchema.extract([
  "setup_failed",
  "environment_fault",
]);
export type RunnerFailureCode = z.infer<typeof RunnerFailureCodeSchema>;

/** Why a dispatch ended `failed`, as its record holds it. */
export const DispatchFailureSchema = z.strictObject({
  code: DispatchFailureCodeSchema,
  message: z.string().min(1),
});
export type DispatchFailure = z.infer<typeof DispatchFailureSchema>;

/** A failure the runner reports with its `stopped`: one of its own codes, and the cause. */
export const RunnerFailureSchema = z.strictObject({
  code: RunnerFailureCodeSchema,
  message: z.string().min(1),
});
export type RunnerFailure = z.infer<typeof RunnerFailureSchema>;

/**
 * Where the workspace lives and how fast its volume is (D-P10-27). Absent or
 * `local`: the instance's own NVMe when it has one, with the EBS volume
 * mounted beside it as the durability sidecar the runner copies to. `volume`:
 * the EBS volume itself as D-P10-15 designed it, with gp3's dials left at the
 * baseline unless `iops` and `throughputMiBps` say otherwise.
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
  /** Absent means the local disk when there is one, else the volume at gp3's baseline. */
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
  failure: DispatchFailureSchema.optional(),
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
export const HeartbeatBodySchema = z
  .strictObject({
    generation: z.int().min(1),
    /** A milestone reached since the last heartbeat, when there is one. */
    report: HeartbeatReportSchema.optional(),
    /**
     * Why the runner stopped, when it stopped because it could not go on (P16
     * SC-07, D-07): the dispatch ends `failed` with it. Only with `stopped`.
     */
    failure: RunnerFailureSchema.optional(),
    /** Seconds the machine has been metered for, since this attempt started. */
    meteredSeconds: z.int().min(0),
    samples: z.array(UtilizationSampleSchema),
    /** The first setup's duration, once, when it is known. */
    setupSeconds: z.number().min(0).optional(),
    /** `sha256` per lockfile path, for the warm cache's record (D-P10-15). */
    lockfileHashes: z.record(z.string().min(1), z.string().min(1)).optional(),
    rootSessionId: z.string().min(1).optional(),
  })
  .refine((body) => body.failure === undefined || body.report === "stopped", {
    message: "a failure is reported only with `stopped`",
    path: ["failure"],
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
