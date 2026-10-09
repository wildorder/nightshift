/**
 * Execution node — a node in the run's execution tree.
 *
 * `depth` is stored for queryability but never trusted as authority: `core`
 * recomputes it from parentage. A node carries no path scope (the owner's
 * ruling, 2026-10-09): a job's reach is the environment it runs in.
 */
import { z } from "zod";
import { ExecutionNodeIdSchema, JobContractIdSchema } from "../ids.js";
import { CommitShaSchema, dropRetiredScope, IsoTimestampSchema, runScoped } from "./common.js";
import { PlanDocumentRefSchema, PlanHashSchema } from "./plan.js";

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
  /**
   * A verification step **could not run** for want of something only a human
   * can supply (P7, D-P7-10). Not a verdict: the only ways out are back to
   * `verifying` once the prerequisite is met, or `cancelled`, so nothing reaches
   * `sealed` or `integrated` from here except through `verified` (A-05).
   */
  "deferred",
  "verified",
  "verification_failed",
  "examining",
  "examination_failed",
  "sealed",
  "integrated",
  /**
   * A finished **program or sub-program** node (P5, D-P5-06). Never a job node:
   * a job that worked is `integrated`, and only through `verified` (A-05). `core`
   * guards the edge by node kind.
   */
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
]);
export type ExecutionNodeStatus = z.infer<typeof ExecutionNodeStatusSchema>;

const ExecutionNodeRecordSchema = z.strictObject({
  ...runScoped,
  executionNodeId: ExecutionNodeIdSchema,
  kind: ExecutionNodeKindSchema,
  /** `null` only for the root node of a run. */
  parentNodeId: ExecutionNodeIdSchema.nullable(),
  /** Root is 0. Recomputed from parentage, never trusted from the record. */
  depth: z.int().min(0),
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
  /**
   * Why this node ended as it did, when it ended in anything but success.
   *
   * Added in P3. The job lifecycle (`p3-vertical-slice.md` §4.3) names it on
   * every failure path — a worker's own reason from `job.fail`, `stale_base` with the two commits, "the worker
   * exited N without reporting completion" — and `job.get` returns it. Killing a
   * worker must leave durable state, never silence (architecture §4), and a node
   * that failed for no recorded reason is that silence.
   *
   * Optional because a node that has not failed has nothing to say here, not
   * because it is ever optional on a failure.
   */
  outcomeReason: z.string().min(1).optional(),
  /**
   * On the **program node of a run of a ratified plan** only (P7, D-P7-02): the
   * plan this run executes, copied from the contract when the node is created.
   * A contract can be ratified again later; this is what makes a run
   * reconstructable from the control plane alone (A-06), plan document
   * included, whatever the contract says by then.
   */
  plan: z
    .strictObject({ planHash: PlanHashSchema, planDocument: PlanDocumentRefSchema })
    .optional(),
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
});

/** A node stored before the ruling of 2026-10-09 has a `scope`, which is dropped on read. */
export const ExecutionNodeSchema = z.preprocess(dropRetiredScope, ExecutionNodeRecordSchema);
export type ExecutionNode = z.infer<typeof ExecutionNodeRecordSchema>;
