/**
 * Agent — one harness invocation bound to an execution node.
 *
 * Nothing executes without a Nightshift execution identity (A-04), so this
 * record exists before a harness process starts. Cost, token and latency
 * metadata is recorded on `RoutingDecision`, which is where the route that
 * incurred it is described.
 */
import { z } from "zod";
import { AgentIdSchema, ExecutionNodeIdSchema } from "../ids.js";
import { IsoTimestampSchema, runScoped } from "./common.js";

/**
 * `arbiter` rules on a disputed finding and `answerer` is a builder's session
 * resumed to answer an examiner's questions (P8, D-P8-13, D-P8-15).
 */
export const AgentRoleSchema = z.enum([
  "orchestrator",
  "worker",
  "examiner",
  "arbiter",
  "answerer",
]);
export type AgentRole = z.infer<typeof AgentRoleSchema>;

export const AgentStatusSchema = z.enum([
  "created",
  "started",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);
export type AgentStatus = z.infer<typeof AgentStatusSchema>;

export const AgentSchema = z.strictObject({
  ...runScoped,
  agentId: AgentIdSchema,
  executionNodeId: ExecutionNodeIdSchema,
  role: AgentRoleSchema,
  /** Adapter identifier, for example `claude`, `codex`, `agentcore`. */
  harness: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
  status: AgentStatusSchema,
  startedAt: IsoTimestampSchema.optional(),
  endedAt: IsoTimestampSchema.optional(),
  /** Harness process exit code where the adapter exposes one. */
  exitCode: z.int().optional(),
  /**
   * The harness's own session id, when it keeps one (P8, D-P8-15): what an
   * examiner's question resumes. Recorded when the agent ends.
   */
  sessionId: z.string().min(1).optional(),
  /** Durable reason for a non-clean end. Never left empty on failure. */
  outcomeReason: z.string().min(1).optional(),
  createdAt: IsoTimestampSchema,
});
export type Agent = z.infer<typeof AgentSchema>;
