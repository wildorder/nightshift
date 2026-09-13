/**
 * Job Contract — a bounded unit of delegated work.
 *
 * Deliberately lean. What *Nightshift* decides (harness, model, workspace,
 * worktree, priority, examination requirement, fallback policy) is not on this
 * record: it lives on `ExecutionNode` and `RoutingDecision`. An orchestrator
 * that wants to pin a model states an override on the delegation request, and
 * routing records that it honoured one.
 */
import { z } from "zod";
import { JobContractIdSchema } from "../ids.js";
import {
  AmbiguityLevelSchema,
  IsoTimestampSchema,
  RiskLevelSchema,
  runScoped,
  ScopeRequestSchema,
} from "./common.js";

export const JobContractSchema = z.strictObject({
  ...runScoped,
  jobContractId: JobContractIdSchema,
  objective: z.string().min(1),
  /** Requested authority. Omitted fields inherit the parent's unchanged (A-11). */
  scope: ScopeRequestSchema,
  acceptance: z.array(z.string().min(1)).min(1),
  /** Other Job Contracts that must reach `integrated` before this one starts. */
  dependencies: z.array(JobContractIdSchema),
  risk: RiskLevelSchema,
  ambiguity: AmbiguityLevelSchema,
  createdAt: IsoTimestampSchema,
});
export type JobContract = z.infer<typeof JobContractSchema>;
