/**
 * Control-plane API shapes (T4).
 *
 * Request and response bodies for `apps/api`, defined here rather than in the
 * handler so a client — the P3 MCP server, later the Studio — is typed against the
 * same schemas the server validates with.
 *
 * Three fields never appear in a request body. `orgId` comes from the caller's
 * validated token (D-P2-13), and an event's `sequence` and `recordedAt` are
 * assigned by the control plane (A-22). Every body schema is strict, so sending
 * one is a validation failure rather than something silently ignored.
 *
 * Record bodies not listed here (program contract, run, execution node, decision,
 * checkpoint, verification, routing decision, artifact) are the aggregate schemas
 * themselves, and a successful write responds with the stored record.
 */
import { z } from "zod";
import { EventSchema, inlinePayloadBytes, MAX_INLINE_PAYLOAD_BYTES } from "./event.js";
import { ExecutionNodeSchema } from "./execution-node.js";
import { ProjectSchema } from "./project.js";
import { RunSchema } from "./run.js";

/** `PUT /projects/{projectId}`. The org is resolved from the token, never sent. */
export const ProjectBodySchema = ProjectSchema.omit({ orgId: true });
export type ProjectBody = z.infer<typeof ProjectBodySchema>;

/**
 * `POST …/runs/{runId}/events`. `EventSchema` carries a refinement, and zod
 * refuses `omit` on a refined object, so the body is rebuilt from the shape and
 * the inline payload bound is applied again.
 */
export const AppendEventBodySchema = z
  .strictObject(EventSchema.shape)
  .omit({ sequence: true, recordedAt: true })
  .refine((value) => inlinePayloadBytes(value.payload) <= MAX_INLINE_PAYLOAD_BYTES, {
    message: `inline payload exceeds ${MAX_INLINE_PAYLOAD_BYTES} bytes; store it as an artifact and reference it with payloadArtifactId (A-08)`,
    path: ["payload"],
  });
export type AppendEventBody = z.infer<typeof AppendEventBodySchema>;

/** Every non-2xx response. `code` is stable and machine-readable; `message` is for people. */
export const ErrorResponseSchema = z.strictObject({
  error: z.strictObject({
    code: z.string().min(1),
    message: z.string().min(1),
    /** Schema issues, present on `validation_failed`. */
    issues: z.array(z.unknown()).optional(),
  }),
});
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

/** A forward-only page. `cursor` is opaque and absent on the last page. */
export const pageResponseSchema = <T extends z.ZodType>(item: T) =>
  z.strictObject({
    items: z.array(item),
    cursor: z.string().min(1).optional(),
  });

export interface PageResponse<T> {
  readonly items: readonly T[];
  readonly cursor?: string;
}

/** `GET /projects`: the acting org's projects. */
export const ProjectPageSchema = pageResponseSchema(ProjectSchema);
export type ProjectPage = z.infer<typeof ProjectPageSchema>;

/** `GET …/runs/{runId}/events`. */
export const EventPageSchema = pageResponseSchema(EventSchema);
export type EventPage = z.infer<typeof EventPageSchema>;

/** 201 when `stored`, 200 for a duplicate idempotency key. `event.sequence` may be null (A-22). */
export const AppendEventResponseSchema = z.strictObject({
  stored: z.boolean(),
  event: EventSchema,
});
export type AppendEventResponse = z.infer<typeof AppendEventResponseSchema>;

/**
 * `GET …/runs/{runId}/state`. `highestSequence` is null until anything is
 * numbered, and `pendingEvents` counts events that are durable but unnumbered — a
 * value that grows without bound means the materializer has stalled.
 */
export const RunStateResponseSchema = z.strictObject({
  run: RunSchema,
  nodes: z.array(ExecutionNodeSchema),
  highestSequence: z.int().min(0).nullable(),
  pendingEvents: z.int().min(0),
});
export type RunStateResponse = z.infer<typeof RunStateResponseSchema>;
