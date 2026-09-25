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
import { ExecutionNodeIdSchema, RoutingDecisionIdSchema } from "../ids.js";
import { IsoTimestampSchema, runScoped } from "./common.js";
import { ClassificationSchema, EffortSchema, TierSchema } from "./routing-policy.js";

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
  costSource: CostSourceSchema.optional(),
  estimatedCostUsd: z.number().min(0).optional(),
  actualCostUsd: z.number().min(0).optional(),
  latencyMs: z.int().min(0).optional(),
  wallClockMs: z.int().min(0).optional(),
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
  /** P8: where on the org's ladders the route sits, when a ladder chose it. */
  readonly ladder?: string;
  readonly rung?: RungPosition;
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
     * P8: what the route was for, when it was not the job's own work: an
     * examiner, a builder answering an examiner's questions, or an arbiter. Absent
     * for the job's attempts, which alone make the attempt chain; every route
     * counts against the run's budget (D-P8-08).
     */
    purpose: z.enum(["examine", "answer", "arbitrate"]).optional(),
    classification: ClassificationSchema.optional(),
    policyVersion: z.int().min(0).optional(),
    createdAt: IsoTimestampSchema,
  })
  .refine(
    (value) =>
      value.eligibleOptions.every((option) => option.eligible || option.reason !== undefined),
    { message: "an ineligible option must record why", path: ["eligibleOptions"] },
  )
  .refine((value) => (value.attempt === 1 ? value.previousRouteId === null : true), {
    message: "the first attempt cannot have a previous route",
    path: ["previousRouteId"],
  });
export type RoutingDecision = z.infer<typeof RoutingDecisionSchema>;
