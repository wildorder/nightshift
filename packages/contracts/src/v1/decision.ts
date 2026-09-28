/**
 * Decision — a recorded choice with its causal descendants (architecture §6).
 *
 * Human authority is always highest. A human override is a *new* decision with
 * `authority: "human"` that references the one it supersedes; the original is
 * never mutated or deleted, because replay has to be able to read both.
 */
import { z } from "zod";
import {
  AgentIdSchema,
  CheckpointIdSchema,
  DecisionIdSchema,
  ExecutionNodeIdSchema,
} from "../ids.js";
import { CommitShaSchema, IsoTimestampSchema, ReversibilitySchema, runScoped } from "./common.js";

/** `human` outranks `agent` everywhere; `core` refuses the reverse. */
export const DecisionAuthoritySchema = z.enum(["agent", "human"]);
export type DecisionAuthority = z.infer<typeof DecisionAuthoritySchema>;

export const DecisionAlternativeSchema = z.strictObject({
  summary: z.string().min(1),
  rejectedBecause: z.string().min(1).optional(),
});
export type DecisionAlternative = z.infer<typeof DecisionAlternativeSchema>;

export const DecisionSchema = z.strictObject({
  ...runScoped,
  decisionId: DecisionIdSchema,
  executionNodeId: ExecutionNodeIdSchema,
  /** `null` when a human recorded the decision directly rather than an agent. */
  agentId: AgentIdSchema.nullable(),
  context: z.string().min(1),
  alternatives: z.array(DecisionAlternativeSchema).min(1),
  choice: z.string().min(1),
  rationale: z.string().min(1),
  reversibility: ReversibilitySchema,
  checkpointBefore: CheckpointIdSchema,
  /** Absent until the work the decision governs has been checkpointed. */
  checkpointAfter: CheckpointIdSchema.optional(),
  /**
   * P9 (D-P9-01): the commits the work of the node this decision was made on
   * landed, from `checkpointBefore` to its landing, oldest first. Set once, by
   * the execution layer, when that node lands; absent when it never did. Ties a
   * choice to its own work and nothing downstream.
   */
  produced: z.strictObject({ commits: z.array(CommitShaSchema) }).optional(),
  /**
   * Execution nodes that consumed this decision's output. The replay cone is
   * computed from these edges, which is why they are recorded rather than
   * inferred after the fact.
   */
  affectedNodes: z.array(ExecutionNodeIdSchema),
  authority: DecisionAuthoritySchema,
  /** Set when this decision reverses or replaces an earlier one. */
  supersedesDecisionId: DecisionIdSchema.nullable(),
  createdAt: IsoTimestampSchema,
});
export type Decision = z.infer<typeof DecisionSchema>;
