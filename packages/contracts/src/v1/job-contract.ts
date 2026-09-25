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
import { StrandIdSchema } from "./plan.js";
import { JobKindSchema, TestabilitySchema } from "./routing-policy.js";

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
  /**
   * P8 (D-P8-01): what the job says about itself, so routing can place it. Both
   * optional, so every stored contract parses as it did. Never read directly:
   * `classificationOf` in `core` fills the **conservative** default for
   * anything unset (`weak`, and no kind), so an unclassified job is never sent
   * to the cheapest rung by accident.
   */
  testability: TestabilitySchema.optional(),
  kind: JobKindSchema.optional(),
  /**
   * Set when this contract **is a strand** of a ratified plan (P7, D-P7-04): a
   * sub-program directly under the program node, whose objective carries its
   * section of the plan verbatim. The engine gates it on the strands it depends
   * on and parks its cone when it fails. Never set on a job inside a strand:
   * those are the run's, and the plan does not name them.
   */
  strandId: StrandIdSchema.optional(),
  createdAt: IsoTimestampSchema,
});
export type JobContract = z.infer<typeof JobContractSchema>;
