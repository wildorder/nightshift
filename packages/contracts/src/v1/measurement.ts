/**
 * Measurement records (P20): what an agent's execution cost, and how well that
 * is known.
 *
 * Three kinds of usage evidence overlap: per-request events, cumulative
 * snapshots and terminal summaries. They are **reconciliation sources, never
 * values to add**. A session-scoped total spans launches (and, when an answerer
 * reuses a session, agents), so it is reconciled against a baseline and never
 * summed with earlier segments. A native child's usage (a provider sub-agent)
 * belongs to the launching Nightshift execution: a child identifier is kept
 * only for reconciliation and confers no execution identity.
 *
 * Observations are metadata only: counters, identifiers and timings. No
 * prompts, tool arguments or results, or response bodies. Everything is
 * additive: a record that says nothing about a figure means "not reported".
 */
import { z } from "zod";
import {
  AgentIdSchema,
  ArtifactIdSchema,
  ExecutionNodeIdSchema,
  MeasurementSummaryIdSchema,
  RoutingDecisionIdSchema,
} from "../ids.js";
import { AgentRoleSchema } from "./agent.js";
import { IsoTimestampSchema, runScoped, SchemaVersionSchema } from "./common.js";
import { CostSourceSchema, RouteTargetSchema } from "./routing-decision.js";

const counter = () => z.int().min(0).optional();

/**
 * Token counters. An absent counter means "not reported", never zero. Cache
 * read/write are subsets of input; reasoning is a subset of output where the
 * provider defines it so. Context-window capacity is never a counter.
 */
export const MeasurementCountersSchema = z.strictObject({
  inputTokens: counter(),
  cacheReadTokens: counter(),
  cacheWriteTokens: counter(),
  outputTokens: counter(),
  reasoningTokens: counter(),
  /**
   * Whether `inputTokens` already contains the cache read/write tokens: true is
   * normalized inclusive input; false is exclusive input, as Claude's
   * `input_tokens` is. Absent means the convention is unknown and must not be
   * asserted.
   */
  inputIncludesCache: z.boolean().optional(),
  /**
   * Provider-reported dollars for the same population as the token counters:
   * scoped, baselined and reconciled with them, never summed across a session.
   */
  reportedUsd: z.number().min(0).optional(),
});
export type MeasurementCounters = z.infer<typeof MeasurementCountersSchema>;

/**
 * What a total covers: one request; this launch (one `harness.start`) so far;
 * the provider session so far (spans resumes, and can span agents when a
 * session is reused by an answerer).
 */
export const CounterScopeSchema = z.enum(["request", "launch", "session"]);
export type CounterScope = z.infer<typeof CounterScopeSchema>;

export const MeasurementCoverageSchema = z.enum(["complete", "partial", "unknown", "legacy"]);
export type MeasurementCoverage = z.infer<typeof MeasurementCoverageSchema>;

/** A known hole in the evidence. Repeats of one reason coalesce into one entry with a count. */
export const CoverageGapSchema = z.strictObject({
  reason: z.enum([
    "receipt_lost",
    "journal_lost",
    "delivery_failed",
    "adapter_unsupported",
    "stopped_before_flush",
    "native_child_unscoped",
    "baseline_unknown",
    "discrepancy",
    "other",
  ]),
  detail: z.string().max(400).optional(),
  from: IsoTimestampSchema.optional(),
  to: IsoTimestampSchema.optional(),
  count: z.int().min(1).default(1),
});
export type CoverageGap = z.infer<typeof CoverageGapSchema>;

/** One launch (one `harness.start`) of an agent, and the segment of its session it is. */
export const LaunchRefSchema = z.strictObject({
  agentId: AgentIdSchema,
  launchId: z.string().min(1).max(100),
  segment: z.int().min(0),
});
export type LaunchRef = z.infer<typeof LaunchRefSchema>;

/** Largest serialized observation accepted; larger evidence belongs in an artifact. */
export const MAX_OBSERVATION_BYTES = 4096;

/** UTF-8 byte length of an observation's JSON form. */
export const observationBytes = (observation: unknown): number =>
  new TextEncoder().encode(JSON.stringify(observation)).length;

const observationCommon = {
  /** Stable and supplied by the emitter, so a redelivered observation is recognised. */
  observationId: z.string().min(1).max(200),
  ...runScoped,
  executionNodeId: ExecutionNodeIdSchema,
  agentId: AgentIdSchema.optional(),
  launch: LaunchRefSchema.optional(),
  source: z.enum(["harness", "engine"]),
  provenance: z.strictObject({
    adapter: z.string().min(1),
    version: z.string().optional(),
    note: z.string().max(400).optional(),
  }),
  /** Source time. Absent when the source gave none; never guessed. */
  occurredAt: IsoTimestampSchema.optional(),
  receivedAt: IsoTimestampSchema,
  inclusion: z.enum(["self", "includes_children", "unknown"]),
  /**
   * A provider child identifier recorded for reconciliation; it confers no
   * Nightshift execution identity.
   */
  childRef: z
    .strictObject({
      kind: z.enum(["session", "agent", "request"]),
      id: z.string(),
    })
    .optional(),
} as const;

/** One request's usage. Overlaps the snapshots and summary; never add them together. */
export const RequestObservationSchema = z.strictObject({
  ...observationCommon,
  kind: z.literal("request"),
  counters: MeasurementCountersSchema,
  requestId: z.string().optional(),
  sessionId: z.string().optional(),
  model: z.string().optional(),
  contextWindowTokens: z.int().min(0).optional(),
  durationMs: z.int().min(0).optional(),
  reportedCostUsd: z.number().min(0).optional(),
});

/** A running total for the launch or the session so far. Supersedes earlier snapshots of its scope. */
export type RequestObservation = z.infer<typeof RequestObservationSchema>;

export const CumulativeSnapshotObservationSchema = z.strictObject({
  ...observationCommon,
  kind: z.literal("cumulative_snapshot"),
  counters: MeasurementCountersSchema,
  counterScope: z.enum(["launch", "session"]),
  sessionId: z.string().optional(),
  model: z.string().optional(),
});

/** The harness's closing account of a launch or session; counters may be empty. */
export const TerminalSummaryObservationSchema = z.strictObject({
  ...observationCommon,
  kind: z.literal("terminal_summary"),
  counters: MeasurementCountersSchema,
  counterScope: z.enum(["launch", "session"]),
  exitKind: z.enum(["completed", "failed", "cancelled", "interrupted"]),
  model: z.string().optional(),
  coverage: z.enum(["complete", "partial", "unknown"]),
  reportedCostUsd: z.number().min(0).optional(),
  durationMs: z.int().min(0).optional(),
});

/** A phase transition in the agent's lifecycle, for delay and rework accounting. */
export const LifecycleObservationSchema = z.strictObject({
  ...observationCommon,
  kind: z.literal("lifecycle"),
  operationId: z.string(),
  attempt: z.int().min(1).optional(),
  phase: z.string().max(100),
  transition: z.enum(["start", "end", "note"]),
  reason: z.string().max(400).optional(),
  blockers: z.array(z.strictObject({ kind: z.string(), ref: z.string() })).max(32),
  /**
   * Causal references (a commit, verification, examination, finding, decision,
   * routing decision, node, dispatch). Distinct from `blockers`, which say what
   * a wait is waiting on.
   */
  refs: z
    .array(z.strictObject({ kind: z.string(), ref: z.string() }))
    .max(32)
    .optional(),
  parentOperationId: z.string().optional(),
});

export type LifecycleObservation = z.infer<typeof LifecycleObservationSchema>;

export const MeasurementObservationSchema = z
  .discriminatedUnion("kind", [
    RequestObservationSchema,
    CumulativeSnapshotObservationSchema,
    TerminalSummaryObservationSchema,
    LifecycleObservationSchema,
  ])
  .refine((value) => observationBytes(value) <= MAX_OBSERVATION_BYTES, {
    message: `observation exceeds ${MAX_OBSERVATION_BYTES} bytes; larger evidence is not an observation`,
  });
export type MeasurementObservation = z.infer<typeof MeasurementObservationSchema>;

/** What orders two aggregate sources: source time, then receipt time, then identifier. */
const SourceKeySchema = z.strictObject({
  occurredAt: IsoTimestampSchema.optional(),
  receivedAt: IsoTimestampSchema,
  observationId: z.string(),
});

const reconciledCoverage = z.enum(["complete", "partial", "unknown"]);

/** One launch's share of the agent's usage, with the sources it was reconciled from. */
export const SegmentSchema = z.strictObject({
  launchId: z.string().min(1).max(100),
  segment: z.int().min(0),
  sessionId: z.string().optional(),
  resumedSession: z.boolean(),
  /**
   * True from the segment's start until its exit has been recorded AND
   * published. Recovery treats an open segment with no journal as lost evidence.
   */
  open: z.boolean(),
  exitKind: z.enum(["completed", "failed", "cancelled", "interrupted"]).optional(),
  /** The segment's reconciled share. */
  counters: MeasurementCountersSchema,
  coverage: MeasurementCoverageSchema,
  /** The session-scoped value this segment's session sources are measured from. */
  baseline: MeasurementCountersSchema.optional(),
  /** Running reconciliation sources, so the segment can be refolded without retaining observations. */
  sources: z.strictObject({
    requests: MeasurementCountersSchema,
    requestCount: z.int().min(0),
    latestLaunchSnapshot: MeasurementCountersSchema.optional(),
    terminal: MeasurementCountersSchema.optional(),
    terminalCoverage: reconciledCoverage.optional(),
    /** Own-request totals of native children (observations with a `childRef`), kept apart. */
    childRequests: MeasurementCountersSchema.optional(),
    /** The combined `inclusion` of every aggregate (snapshot or terminal) seen; unknown dominates. */
    aggregateInclusion: z.enum(["self", "includes_children", "unknown"]).optional(),
    /** Ordering keys of the sources above, so a late-arriving older one does not supersede. */
    latestLaunchSnapshotKey: SourceKeySchema.optional(),
    latestTerminalKey: SourceKeySchema.optional(),
  }),
  /**
   * The latest RAW session-scoped source seen in this segment, before baseline
   * subtraction: what a later resume, or an answerer reusing this session,
   * takes as its baseline.
   */
  sessionCumulative: z
    .strictObject({
      counters: MeasurementCountersSchema,
      kind: z.enum(["cumulative_snapshot", "terminal_summary"]),
      occurredAt: IsoTimestampSchema.optional(),
      receivedAt: IsoTimestampSchema,
      observationId: z.string(),
    })
    .optional(),
  /**
   * The highest per-segment sequence number folded so far. The recorder numbers
   * observations 1..n per segment as it enqueues them; replay deduplicates by this.
   */
  receivedSequence: z.int().min(0),
  publishedSequence: z.int().min(0),
  observed: z.strictObject({
    requests: z.int().min(0),
    snapshots: z.int().min(0),
    terminal: z.boolean(),
  }),
});
export type Segment = z.infer<typeof SegmentSchema>;

export const ValuationComponentSchema = z.strictObject({
  model: z.string().min(1),
  /** 0 is the base tier. */
  tier: z.int().min(0),
  category: z.enum(["input", "output", "cacheRead", "cacheWrite"]),
  tokens: z.number().min(0),
  usd: z.number().min(0),
  perMTok: z.number().min(0),
});
export type ValuationComponent = z.infer<typeof ValuationComponentSchema>;

export const ValuationCompletenessSchema = z.strictObject({
  valuedRequests: z.int().min(0),
  unvaluedRequests: z.int().min(0),
  /** Counters in the totals that no individually observed request covers. */
  remainderTokens: z.number().min(0),
  remainderValued: z.boolean(),
  reasons: z.array(z.string().max(200)).max(8),
});
export type ValuationCompleteness = z.infer<typeof ValuationCompletenessSchema>;

/** What the requests observed so far add up to; the valuation is derived from this and the totals. */
export const ValuationRequestsSchema = z.strictObject({
  /** Net (cache-exclusive) token sums over every individually observed request. */
  counters: MeasurementCountersSchema,
  components: z.array(ValuationComponentSchema).max(64),
  valuedRequests: z.int().min(0),
  unvaluedRequests: z.int().min(0),
  reasons: z.array(z.string().max(200)).max(8),
  priceSource: z.string().optional(),
  priceVersion: z.string().optional(),
});
export type ValuationRequests = z.infer<typeof ValuationRequestsSchema>;

export const MeasurementValuationSchema = z.strictObject({
  source: CostSourceSchema,
  /** The headline figure, chosen by `source`. */
  usd: z.number().min(0).optional(),
  reportedUsd: z.number().min(0).optional(),
  /** Priced from tokens; kept apart from `reportedUsd` and never added to it. */
  estimatedUsd: z.number().min(0).optional(),
  basis: z.string().max(200).optional(),
  priceSource: z.string().optional(),
  priceVersion: z.string().optional(),
  components: z.array(ValuationComponentSchema).max(64).optional(),
  completeness: ValuationCompletenessSchema.optional(),
  /** Per-request accumulation the recorder and recovery carry forward. */
  requests: ValuationRequestsSchema.optional(),
});
export type MeasurementValuation = z.infer<typeof MeasurementValuationSchema>;

/** The compact persisted record, updated in place as observations arrive. */
export const MeasurementSummarySchema = z
  .strictObject({
    measurementVersion: z.literal(1),
    ...runScoped,
    measurementSummaryId: MeasurementSummaryIdSchema,
    executionNodeId: ExecutionNodeIdSchema,
    agentId: AgentIdSchema,
    role: AgentRoleSchema,
    /** Null when no routing decision exists, for example a human-pinned root. */
    routingDecisionId: RoutingDecisionIdSchema.nullable(),
    /** The chosen route. */
    route: RouteTargetSchema,
    observedModels: z.array(z.string()).max(16),
    segments: z.array(SegmentSchema).max(64),
    /** Usage attributed to native children, when recorded apart from `totals`. */
    childCounters: MeasurementCountersSchema.optional(),
    totals: MeasurementCountersSchema,
    coverage: MeasurementCoverageSchema,
    gaps: z.array(CoverageGapSchema).max(64),
    ledger: z.strictObject({
      chunks: z.int().min(0),
      artifactIds: z.array(ArtifactIdSchema).max(512),
      /**
       * When the list overflowed, an index artifact listing earlier chunk
       * artifacts; indexes chain through their own `previousIndexArtifactId`.
       */
      indexArtifactId: ArtifactIdSchema.optional(),
      observationCount: z.int().min(0),
      publishedCount: z.int().min(0),
    }),
    valuation: MeasurementValuationSchema,
    createdAt: IsoTimestampSchema,
    updatedAt: IsoTimestampSchema,
  })
  .superRefine((value, ctx) => {
    if (value.coverage === "complete" && value.gaps.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["coverage"],
        message: "coverage cannot be complete while gaps are listed",
      });
    }
    value.segments.forEach((segment, index) => {
      if (segment.publishedSequence > segment.receivedSequence) {
        ctx.addIssue({
          code: "custom",
          path: ["segments", index, "publishedSequence"],
          message: "publishedSequence cannot exceed receivedSequence",
        });
      }
    });
    if (value.ledger.publishedCount > value.ledger.observationCount) {
      ctx.addIssue({
        code: "custom",
        path: ["ledger", "publishedCount"],
        message: "publishedCount cannot exceed observationCount",
      });
    }
  });
export type MeasurementSummary = z.infer<typeof MeasurementSummarySchema>;

/** Artifact body (kind `measurement-ledger`): a run of observations from one segment. */
export const MeasurementLedgerChunkSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  chunk: z.int().min(0),
  segment: LaunchRefSchema,
  fromSequence: z.int().min(1),
  toSequence: z.int().min(1),
  observations: z.array(MeasurementObservationSchema),
});
export type MeasurementLedgerChunk = z.infer<typeof MeasurementLedgerChunkSchema>;

/**
 * Artifact body (kind `measurement-ledger`): lists chunk artifacts, chained to earlier indexes.
 * An entry whose range is unknown (a reference recovered without its journal) still
 * preserves the reference: only `artifactId` is required.
 */
export const MeasurementLedgerIndexSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  previousIndexArtifactId: ArtifactIdSchema.optional(),
  chunks: z
    .array(
      z.strictObject({
        chunk: z.int().min(0).optional(),
        artifactId: ArtifactIdSchema,
        segment: LaunchRefSchema.optional(),
        fromSequence: z.int().min(1).optional(),
        toSequence: z.int().min(1).optional(),
      }),
    )
    .max(4096),
});
export type MeasurementLedgerIndex = z.infer<typeof MeasurementLedgerIndexSchema>;
