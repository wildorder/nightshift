/**
 * Event — the append-only record from which current state is rebuilt.
 *
 * Two channels, deliberately redundant (architecture §5). MCP carries *intent*:
 * semantic actions an agent takes on purpose. Hooks carry *ground truth*:
 * lifecycle facts that must not depend on agent compliance. `source` records
 * which channel an event arrived on, because an agent that neglects to report is
 * an observability gap MCP alone cannot close.
 *
 * Writes carry an idempotency key so a replayed local spool converges (A-06).
 */
import { z } from "zod";
import { AgentIdSchema, ArtifactIdSchema, EventIdSchema, ExecutionNodeIdSchema } from "../ids.js";
import { IsoTimestampSchema, runScoped } from "./common.js";

export const EventSourceSchema = z.enum(["mcp", "hook", "control-plane"]);
export type EventSource = z.infer<typeof EventSourceSchema>;

/**
 * A closed union. Later programs extend it deliberately; an unknown type is
 * rejected rather than stored, so a typo cannot create a silent event class.
 */
export const EventTypeSchema = z.enum([
  // Run lifecycle — control plane.
  "run.created",
  "run.started",
  "run.completed",
  "run.failed",
  "run.cancelled",
  "run.interrupted",
  // Delegation and node lifecycle — MCP intent plus control-plane facts.
  "node.delegated",
  "node.queued",
  "node.started",
  "node.progress",
  "node.implemented",
  "node.failed",
  "node.cancelled",
  "node.interrupted",
  "node.integrated",
  /** Added in P6 (D-P6-03). A sub-program's orchestrator ended it, its work done. */
  "node.succeeded",
  /**
   * Added in P6 (D-P6-06). The merge queue replayed a node's snapshot onto a
   * program head that had moved since its worktree was cut: a stale base,
   * detected and recorded rather than refused. Payload: both commits.
   */
  "node.rebased",
  /**
   * Added in P7 (D-P7-09, §4.4). A strand settled without succeeding, so it is
   * parked. Payload: the strand id and why.
   */
  "strand.parked",
  /**
   * Added in P7. A strand in a parked strand's downstream cone will not be
   * started. Payload: the strand id and the strands that blocked it.
   */
  "strand.blocked",
  /**
   * Added in P7 (D-P7-10). A node's checks could not all run, or it was built on
   * work whose checks could not: it sits on the run's provisional line, not the
   * program branch. Payload: the commit, the provisional ref, and what it waits on.
   */
  "node.deferred",
  /** Added in P7. A deferred node was dropped at resume because work under it failed its checks. */
  "node.discarded",
  /**
   * Added in P6 (D-P6-06). That replay conflicted. Nightshift resolves nothing:
   * the node fails, the paths are named, and an orchestrator decides.
   */
  "integration.conflict",
  // Agent lifecycle — hook ground truth (architecture §5).
  "agent.created",
  "agent.started",
  "agent.completed",
  "agent.failed",
  "agent.cancelled",
  /**
   * Added in P3. The Job lifecycle (`p3-vertical-slice.md` §4.3) requires a
   * killed worker to leave durable interruption state on the agent as well as
   * the node, and the union P1 closed had no type for it. Widening a closed
   * union is the deliberate extension the module comment reserves.
   */
  "agent.interrupted",
  "agent.subagent_created",
  "agent.context_compacted",
  "tool.called",
  "tool.completed",
  // Verification and examination — Nightshift authority.
  "verification.requested",
  "verification.completed",
  "examination.requested",
  "examination.completed",
  // Decisions, checkpoints, routing, artifacts.
  "decision.recorded",
  "decision.overridden",
  "checkpoint.created",
  "routing.decided",
  "artifact.recorded",
]);
export type EventType = z.infer<typeof EventTypeSchema>;

/**
 * Small structured metadata only. Anything larger belongs in S3 behind
 * `payloadArtifactId`; this bound is what keeps large output out of DynamoDB
 * (A-08) rather than a convention nobody checks.
 */
export const MAX_INLINE_PAYLOAD_BYTES = 8192;

/**
 * UTF-8 size of an inline payload. Uses `TextEncoder` rather than `Buffer` so
 * this package stays runtime-neutral: the future Studio is a browser client of
 * these same contracts.
 */
export const inlinePayloadBytes = (payload: Readonly<Record<string, unknown>>): number =>
  new TextEncoder().encode(JSON.stringify(payload)).length;

export const EventSchema = z
  .strictObject({
    ...runScoped,
    eventId: EventIdSchema,
    /**
     * Deduplication key supplied by the writer. A duplicate submission with the
     * same key must not create a second event.
     */
    idempotencyKey: z.string().min(1).max(256),
    /**
     * Monotonic within a run, dense, assigned by the control plane.
     *
     * `null` means **durable but not yet numbered**. Sequence numbers are stamped
     * after the write commits, by an ordered consumer (A-22), so there is a brief
     * window in which an event exists and has no number. Modelled as nullable
     * rather than optional so no reader can forget the case: see
     * `isSequenced` and `orderEvents` in `@nightshift/core`.
     */
    sequence: z.int().min(0).nullable(),
    type: EventTypeSchema,
    source: EventSourceSchema,
    executionNodeId: ExecutionNodeIdSchema.nullable(),
    agentId: AgentIdSchema.nullable(),
    payload: z.record(z.string(), z.unknown()),
    /** Where the full payload lives when it exceeds the inline bound. */
    payloadArtifactId: ArtifactIdSchema.optional(),
    occurredAt: IsoTimestampSchema,
    recordedAt: IsoTimestampSchema,
  })
  .refine((value) => inlinePayloadBytes(value.payload) <= MAX_INLINE_PAYLOAD_BYTES, {
    message: `inline payload exceeds ${MAX_INLINE_PAYLOAD_BYTES} bytes; store it as an artifact and reference it with payloadArtifactId (A-08)`,
    path: ["payload"],
  });
export type Event = z.infer<typeof EventSchema>;
