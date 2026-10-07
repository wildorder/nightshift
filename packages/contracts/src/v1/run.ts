/**
 * Run — one execution of a Program Contract, local or remote. Both share one
 * authoritative control plane (A-06), so nothing here is location-specific
 * beyond `location` itself.
 */
import { z } from "zod";
import { ExecutionNodeIdSchema, RunIdSchema } from "../ids.js";
import {
  CommitShaSchema,
  ExecutionLocationSchema,
  IsoTimestampSchema,
  runScoped,
} from "./common.js";
import { EffectivePolicySchema } from "./org-config.js";
import { StrandIdSchema } from "./plan.js";

export const RunStatusSchema = z.enum([
  "pending",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

/**
 * A strand an earlier run of the same ratified plan already finished, counted as
 * succeeded in this one instead of being built again. Decided when the run
 * starts, from records and git alone: the strand succeeded in that run, the plan
 * hash is the one this run follows, and every commit it landed is already on the
 * program branch this run starts from.
 */
export const CarriedStrandSchema = z.strictObject({
  strandId: StrandIdSchema,
  /** The run that built it. A strand carried twice still names the run that built it. */
  fromRunId: RunIdSchema,
  /** What it landed there, each one an ancestor of this run's base. */
  landed: z.array(CommitShaSchema),
});
export type CarriedStrand = z.infer<typeof CarriedStrandSchema>;

export const RunSchema = z.strictObject({
  ...runScoped,
  status: RunStatusSchema,
  location: ExecutionLocationSchema,
  /** The root of this run's execution tree. */
  rootNodeId: ExecutionNodeIdSchema,
  startedAt: IsoTimestampSchema,
  endedAt: IsoTimestampSchema.optional(),
  /**
   * Why the run ended as it did, when it ended in anything but `succeeded`.
   * Killing a worker must leave durable state, never silence (architecture §4).
   */
  outcomeReason: z.string().min(1).optional(),
  /**
   * P8 (D-P8-03): the routing and examination policy this run executes under,
   * the org's narrowed by the repository and the contract, fixed when the run
   * starts. Absent on a run started before P8.
   */
  policy: EffectivePolicySchema.optional(),
  /**
   * The strands this run does not build, because an earlier run of the same
   * plan did and their work is on the program branch. Absent when none are.
   */
  carriedStrands: z.array(CarriedStrandSchema).optional(),
});
export type Run = z.infer<typeof RunSchema>;
