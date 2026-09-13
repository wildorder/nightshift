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
  // Agent lifecycle — hook ground truth (architecture §5).
  "agent.created",
  "agent.started",
  "agent.completed",
  "agent.failed",
  "agent.cancelled",
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
    /** Monotonic within a run. Ordering must be reconstructable from stored records alone. */
    sequence: z.int().min(0),
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
