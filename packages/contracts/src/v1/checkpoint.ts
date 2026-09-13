/**
 * Checkpoint — a durably addressable Git state that replay can return to
 * (vision, Core Concepts). A checkpoint that cannot be addressed later is not a
 * checkpoint, so both the ref and the resolved commit are recorded.
 */
import { z } from "zod";
import { CheckpointIdSchema, ExecutionNodeIdSchema } from "../ids.js";
import { CommitShaSchema, GitRefSchema, IsoTimestampSchema, runScoped } from "./common.js";

export const CheckpointSchema = z.strictObject({
  ...runScoped,
  checkpointId: CheckpointIdSchema,
  executionNodeId: ExecutionNodeIdSchema,
  commitSha: CommitShaSchema,
  /** The ref under which the commit stays reachable, so replay can find it. */
  ref: GitRefSchema,
  label: z.string().min(1).optional(),
  createdAt: IsoTimestampSchema,
});
export type Checkpoint = z.infer<typeof CheckpointSchema>;
