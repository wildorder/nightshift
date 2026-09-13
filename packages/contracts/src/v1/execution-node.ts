/**
 * Execution node — a node in the run's execution tree.
 *
 * `depth` and `scope` are stored for queryability but are never trusted as
 * authority: `core` recomputes depth from parentage and recomputes effective
 * scope by narrowing the parent's, so a tampered record cannot widen authority.
 */
import { z } from "zod";
import { ExecutionNodeIdSchema, JobContractIdSchema } from "../ids.js";
import { CommitShaSchema, IsoTimestampSchema, runScoped, ScopeSchema } from "./common.js";

/** `sub-program` carries its own orchestrator and its own delegation authority. */
export const ExecutionNodeKindSchema = z.enum(["program", "sub-program", "job"]);
export type ExecutionNodeKind = z.infer<typeof ExecutionNodeKindSchema>;

/**
 * The full lifecycle of an execution node. `implemented` is what a worker may
 * claim; `verified` is what only Nightshift may assert (A-05). There is no legal
 * path from `implemented` to `sealed` that skips `verified`, and `core` owns
 * that table.
 */
export const ExecutionNodeStatusSchema = z.enum([
  "validated",
  "queued",
  "running",
  "implemented",
  "verifying",
  "verified",
  "verification_failed",
  "examining",
  "examination_failed",
  "sealed",
  "integrated",
  "failed",
  "cancelled",
  "interrupted",
]);
export type ExecutionNodeStatus = z.infer<typeof ExecutionNodeStatusSchema>;

export const ExecutionNodeSchema = z.strictObject({
  ...runScoped,
  executionNodeId: ExecutionNodeIdSchema,
  kind: ExecutionNodeKindSchema,
  /** `null` only for the root node of a run. */
  parentNodeId: ExecutionNodeIdSchema.nullable(),
  /** Root is 0. Recomputed from parentage, never trusted from the record. */
  depth: z.int().min(0),
  /** Effective authority after narrowing the parent's scope. */
  scope: ScopeSchema,
  status: ExecutionNodeStatusSchema,
  /** Set when `kind` is `job`; `null` for program and sub-program nodes. */
  jobContractId: JobContractIdSchema.nullable(),
  /**
   * The commit this node's work currently sits on, once it has produced one.
   * `null` before the worker commits. Recording it here is what lets
   * verification be matched to the node from the two records alone, rather than
   * the caller asserting they belong together.
   */
  commitSha: CommitShaSchema.nullable(),
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
});
export type ExecutionNode = z.infer<typeof ExecutionNodeSchema>;
