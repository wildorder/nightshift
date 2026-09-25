/**
 * Run — one execution of a Program Contract, local or remote. Both share one
 * authoritative control plane (A-06), so nothing here is location-specific
 * beyond `location` itself.
 */
import { z } from "zod";
import { ExecutionNodeIdSchema } from "../ids.js";
import { ExecutionLocationSchema, IsoTimestampSchema, runScoped } from "./common.js";
import { EffectivePolicySchema } from "./org-config.js";

export const RunStatusSchema = z.enum([
  "pending",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

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
});
export type Run = z.infer<typeof RunSchema>;
