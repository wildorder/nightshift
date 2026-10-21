/**
 * Routing decision — why a job ran where it ran (A-13).
 *
 * Routing optimises the cheapest path to a *verified* result, not the cheapest
 * token, so the eligible options and the verification outcome are both recorded.
 * One record per attempt: an escalation chain is a linked list through
 * `previousRouteId`, which is what makes "every attempted route is recorded on
 * the final outcome" true rather than aspirational. This is also the dataset
 * later learned routing trains on, which is why cost and latency are captured
 * whenever a provider exposes them.
 */
import { z } from "zod";
import {
  DecisionIdSchema,
  ExaminationIdSchema,
  ExecutionNodeIdSchema,
  RoutingDecisionIdSchema,
  VerificationIdSchema,
} from "../ids.js";
import { IsoTimestampSchema, runScoped } from "./common.js";
import {
  ClassificationSchema,
  EffortSchema,
  RoutingRoleSchema,
  TierSchema,
} from "./routing-policy.js";

/** A harness, provider and model triple Nightshift can dispatch to. */
export const RouteTargetSchema = z.strictObject({
  harness: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
  /** P8: the reasoning effort the route runs at, when its rung names one. */
  effort: EffortSchema.optional(),
});
export type RouteTarget = z.infer<typeof RouteTargetSchema>;

export const RouteOptionSchema = z.strictObject({
  target: RouteTargetSchema,
  eligible: z.boolean(),
  /** Why an option was ineligible. Required when `eligible` is false. */
  reason: z.string().min(1).optional(),
});
export type RouteOption = z.infer<typeof RouteOptionSchema>;

export const RouteOutcomeSchema = z.enum([
  "pending",
  "verified",
  /**
   * Added in P6. The route ran a **sub-program's orchestrator**, which produces
   * no commit and so is never verified: its node ends `succeeded` (D-P5-06), and
   * calling that `verified` would say something happened that did not.
   */
  "succeeded",
  "verification_failed",
  "failed",
  "escalated",
  "cancelled",
  /**
   * Added in P8 (D-P8-06). The route **could not start**: not signed in, the
   * model not offered, rate-limited before any work began. Not a failure of the
   * model, so the next attempt falls back sideways rather than climbing.
   */
  "unavailable",
]);
export type RouteOutcome = z.infer<typeof RouteOutcomeSchema>;

/**
 * Where a dollar figure came from (P8, D-P8-08). A reported figure and an
 * estimate are never added together silently: every total says which it is.
 */
export const CostSourceSchema = z.enum(["reported", "estimated", "unknown"]);
export type CostSource = z.infer<typeof CostSourceSchema>;

export const RouteUsageSchema = z.strictObject({
  inputTokens: z.int().min(0).optional(),
  outputTokens: z.int().min(0).optional(),
  /** P8: tokens read from or written to the provider's prompt cache, where reported. */
  cacheReadTokens: z.int().min(0).optional(),
  cacheWriteTokens: z.int().min(0).optional(),
  /**
   * P20: how `inputTokens` relates to the cache counters. True: it already
   * contains cache read/write tokens; false: it excludes them. Absent means
   * unknown, which is what every record written so far means.
   */
  inputIncludesCache: z.boolean().optional(),
  costSource: CostSourceSchema.optional(),
  estimatedCostUsd: z.number().min(0).optional(),
  actualCostUsd: z.number().min(0).optional(),
  latencyMs: z.int().min(0).optional(),
  /**
   * Settlement time: from the attempt's first launch until its node settled,
   * so it includes verification, examination, the merge queue and integration.
   * Not agent time; see `agentMs`.
   */
  wallClockMs: z.int().min(0).optional(),
  /**
   * P20: agent execution time: the summed work-phase intervals of this
   * attempt's harness launches (resume segments summed). Excludes startup,
   * setup, verification, examination, queue and integration.
   */
  agentMs: z.int().min(0).optional(),
});
export type RouteUsage = z.infer<typeof RouteUsageSchema>;

/**
 * What a routing rule decides, before it becomes a record.
 *
 * A `RoutingDecision` carries identifiers the execution layer mints — its own id
 * and the node it belongs to — so a rule cannot build one. It returns this, and
 * the runner turns it into the record. Declared here, beside the record it
 * becomes, so `routing` (which produces it) and `execution` (which consumes it)
 * share one shape without depending on each other.
 */
export interface RouteChoice {
  readonly target: RouteTarget;
  /** Every option considered, eligible or not, so the choice is explainable. */
  readonly eligibleOptions: readonly RouteOption[];
  /** The routing rule responsible, for example `p3-fixed`. */
  readonly ruleId: string;
  /** True when an orchestrator pinned the target rather than policy selecting it. */
  readonly wasOverride: boolean;
  /** The role whose list the route came from (D-RR-01). */
  readonly role?: z.infer<typeof RoutingRoleSchema>;
  /** Its place in that list, 0 first (D-RR-01). */
  readonly position?: number;
  /** P8: the classification the rule matched, defaults filled in. */
  readonly classification?: z.infer<typeof ClassificationSchema>;
  /** P8: the org configuration version the effective policy was narrowed from. */
  readonly policyVersion?: number;
}

/** A rung by tier and by its index on its ladder (0 is the cheapest). */
export const RungPositionSchema = z.strictObject({
  tier: TierSchema,
  index: z.int().min(0),
});
export type RungPosition = z.infer<typeof RungPositionSchema>;

/**
 * Why an attempt after the first exists (P20): one cause per reason, so a
 * retry with mixed causes records each. Metadata and identifiers only.
 */
export const AttemptCauseSchema = z.strictObject({
  kind: z.enum([
    "examination_findings",
    "ruling",
    "integration_conflict",
    "verification_failed",
    "route_unavailable",
    "unreported",
    "worker_failed",
    "interrupted",
    "strand_landing",
    "unknown",
  ]),
  examinationId: ExaminationIdSchema.optional(),
  findingIds: z.array(z.string()).max(32).optional(),
  decisionIds: z.array(DecisionIdSchema).max(32).optional(),
  verificationId: VerificationIdSchema.optional(),
  previousRoutingDecisionId: RoutingDecisionIdSchema.optional(),
  paths: z.array(z.string()).max(50).optional(),
  detail: z.string().max(400).optional(),
});
export type AttemptCause = z.infer<typeof AttemptCauseSchema>;

export const RoutingDecisionSchema = z
  .strictObject({
    ...runScoped,
    routingDecisionId: RoutingDecisionIdSchema,
    executionNodeId: ExecutionNodeIdSchema,
    /** 1 for the first attempt at this node, incrementing on each escalation. */
    attempt: z.int().min(1),
    /** Every option considered, eligible or not, so the choice is explainable. */
    eligibleOptions: z.array(RouteOptionSchema).min(1),
    chosen: RouteTargetSchema,
    /** The routing rule or override responsible for the choice. */
    ruleId: z.string().min(1),
    /** True when an orchestrator pinned the target rather than policy selecting it. */
    wasOverride: z.boolean(),
    usage: RouteUsageSchema,
    outcome: RouteOutcomeSchema,
    /** The attempt this one escalated from; `null` for a first attempt. */
    previousRouteId: RoutingDecisionIdSchema.nullable(),
    /**
     * P8 (D-P8-02 … D-P8-07). Optional, so a decision recorded before P8 parses
     * as it did. Set on every decision a ladder made.
     */
    ladder: z.string().min(1).optional(),
    rung: RungPositionSchema.optional(),
    /**
     * D-RR-01 (2026-10-12): the role whose preference list chose the route, and
     * its place in that list, 0 first. Set on every decision made since; a
     * decision made by a ladder has `ladder` and `rung` instead.
     */
    role: RoutingRoleSchema.optional(),
    position: z.int().min(0).optional(),
    /**
     * P8: what the route was for, when it was not the job's own work: an
     * examiner, a builder answering an examiner's questions, or an arbiter. Absent
     * for the job's attempts, which alone make the attempt chain; every route
     * counts against the run's budget (D-P8-08).
     */
    purpose: z.enum(["examine", "answer", "arbitrate"]).optional(),
    classification: ClassificationSchema.optional(),
    policyVersion: z.int().min(0).optional(),
    /**
     * P20: why this attempt was made. Absent on the first attempt, which has
     * nothing to follow, and on any decision recorded before P20.
     */
    causes: z.array(AttemptCauseSchema).max(8).optional(),
    /**
     * P20: what a helper route (examiner, answerer, arbiter, plan reviewer) was
     * about: the examination or finding it examined, answered or ruled on, or
     * the plan decision it reviewed.
     */
    concerning: z
      .discriminatedUnion("kind", [
        z.strictObject({
          kind: z.literal("examination"),
          examinationId: ExaminationIdSchema,
          findingId: z.string().optional(),
        }),
        z.strictObject({ kind: z.literal("plan_review"), decisionId: DecisionIdSchema.optional() }),
      ])
      .optional(),
    createdAt: IsoTimestampSchema,
  })
  .refine(
    (value) =>
      value.eligibleOptions.every((option) => option.eligible || option.reason !== undefined),
    { message: "an ineligible option must record why", path: ["eligibleOptions"] },
  )
  .refine((value) => (value.attempt === 1 ? value.causes === undefined : true), {
    message: "the first attempt has no causes",
    path: ["causes"],
  })
  .refine((value) => (value.attempt === 1 ? value.previousRouteId === null : true), {
    message: "the first attempt cannot have a previous route",
    path: ["previousRouteId"],
  });
export type RoutingDecision = z.infer<typeof RoutingDecisionSchema>;

/**
 * One line of `nightshift routes export` (P8, SC-P8-15, SC-11): a routing
 * decision with everything a learned router needs to train on, so nothing needs
 * a join. JSON Lines, one per decision, every attempt of every job included.
 */
export const RoutingDatasetLineSchema = z.strictObject({
  schemaVersion: z.literal(2),
  projectId: z.string().min(1),
  programId: z.string().min(1),
  runId: z.string().min(1),
  executionNodeId: z.string().min(1),
  jobContractId: z.string().min(1).nullable(),
  strandId: z.string().min(1).nullable(),
  /** Null only for a root line, which has no routing decision: the root launch's summary. */
  routingDecisionId: z.string().min(1).nullable(),
  /** `work` for the job's own attempts; otherwise what the route was for. */
  purpose: z.enum(["work", "examine", "answer", "arbitrate", "root"]),
  attempt: z.int().min(1),
  previousRouteId: z.string().min(1).nullable(),
  ruleId: z.string().min(1),
  wasOverride: z.boolean(),
  ladder: z.string().min(1).nullable(),
  rung: RungPositionSchema.nullable(),
  /** D-RR-01: the role and place in its list, for decisions made since ladders went. */
  role: RoutingRoleSchema.nullable().optional(),
  position: z.int().min(0).nullable().optional(),
  classification: ClassificationSchema.nullable(),
  policyVersion: z.int().min(0).nullable(),
  chosen: RouteTargetSchema,
  eligibleOptions: z.array(RouteOptionSchema),
  usage: RouteUsageSchema,
  outcome: RouteOutcomeSchema,
  /**
   * What judged this decision's work. `attempt`: chosen by the explicit links
   * (the verification names this decision; the examination names it as its
   * implementer's decision, or for an examiner decision is the one it
   * concerns). `node_final`: no linked record existed, so the node's final
   * records are given and `historical` is true: never this attempt's own
   * judgement. `none`: the node has no records at all.
   */
  judgement: z.strictObject({
    verification: z.enum(["passed", "failed", "deferred"]).nullable(),
    examination: z
      .strictObject({
        outcome: z.enum(["passed", "findings_raised", "failed"]),
        blocking: z.boolean(),
        fixAttempt: z.int().min(0),
      })
      .nullable(),
    link: z.enum(["attempt", "node_final", "none"]),
    historical: z.boolean(),
  }),
  /** Agent execution time (`usage.agentMs`), or null where it was not recorded. */
  agentMs: z.int().min(0).nullable(),
  /** Settlement time (`usage.wallClockMs`), or null where it was not recorded. */
  settlementMs: z.int().min(0).nullable(),
  /** The newest measurement summary of this decision (of the root launch, for a root line). */
  measurementSummaryId: z.string().min(1).nullable(),
  /** That summary's coverage, `missing` when none exists. */
  measurementCoverage: z.enum(["complete", "partial", "unknown", "legacy", "missing"]),
  createdAt: IsoTimestampSchema,
});
export type RoutingDatasetLine = z.infer<typeof RoutingDatasetLineSchema>;
