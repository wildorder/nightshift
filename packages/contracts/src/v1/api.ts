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
import { ArtifactIdSchema } from "../ids.js";
import { AgentSchema } from "./agent.js";
import { ArtifactKindSchema, ArtifactSchema, ArtifactUriSchema } from "./artifact.js";
import { CheckpointSchema } from "./checkpoint.js";
import { IsoTimestampSchema } from "./common.js";
import { DecisionSchema } from "./decision.js";
import { EventSchema, inlinePayloadBytes, MAX_INLINE_PAYLOAD_BYTES } from "./event.js";
import { ExaminationSchema } from "./examination.js";
import { ExecutionNodeSchema } from "./execution-node.js";
import { JobContractSchema } from "./job-contract.js";
import { ProgramContractSchema } from "./program-contract.js";
import { ProjectSchema } from "./project.js";
import { RoutingDecisionSchema } from "./routing-decision.js";
import { RunSchema } from "./run.js";
import { VerificationSchema } from "./verification.js";

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

// ---------------------------------------------------------------------------
// Listings (P3, T2)
// ---------------------------------------------------------------------------

/**
 * Every list route answers in the page shape, whether or not it can page.
 *
 * The `listByNode` ports return a whole array rather than a page — a node's
 * agents, verifications, examinations and routing decisions are few by
 * construction — so those routes never emit a `cursor`. One response shape means
 * one client parse, and a route that later gains paging does not change its
 * contract.
 */
export const ProgramContractPageSchema = pageResponseSchema(ProgramContractSchema);
export type ProgramContractPage = z.infer<typeof ProgramContractPageSchema>;

export const RunPageSchema = pageResponseSchema(RunSchema);
export type RunPage = z.infer<typeof RunPageSchema>;

export const ExecutionNodePageSchema = pageResponseSchema(ExecutionNodeSchema);
export type ExecutionNodePage = z.infer<typeof ExecutionNodePageSchema>;

export const JobContractPageSchema = pageResponseSchema(JobContractSchema);
export type JobContractPage = z.infer<typeof JobContractPageSchema>;

export const AgentPageSchema = pageResponseSchema(AgentSchema);
export type AgentPage = z.infer<typeof AgentPageSchema>;

export const DecisionPageSchema = pageResponseSchema(DecisionSchema);
export type DecisionPage = z.infer<typeof DecisionPageSchema>;

export const CheckpointPageSchema = pageResponseSchema(CheckpointSchema);
export type CheckpointPage = z.infer<typeof CheckpointPageSchema>;

export const VerificationPageSchema = pageResponseSchema(VerificationSchema);
export type VerificationPage = z.infer<typeof VerificationPageSchema>;

export const ExaminationPageSchema = pageResponseSchema(ExaminationSchema);
export type ExaminationPage = z.infer<typeof ExaminationPageSchema>;

export const RoutingDecisionPageSchema = pageResponseSchema(RoutingDecisionSchema);
export type RoutingDecisionPage = z.infer<typeof RoutingDecisionPageSchema>;

export const ArtifactPageSchema = pageResponseSchema(ArtifactSchema);
export type ArtifactPage = z.infer<typeof ArtifactPageSchema>;

// ---------------------------------------------------------------------------
// Presigned artifact upload (P3, T2, A-08)
// ---------------------------------------------------------------------------

/**
 * The largest body the upload route will sign: S3's single-`PUT` limit of 5 GiB.
 * Anything larger needs a multipart upload, which nothing in v1 produces.
 */
export const MAX_ARTIFACT_UPLOAD_BYTES = 5 * 1024 * 1024 * 1024;

/**
 * `POST …/artifacts/{artifactId}/upload-url`.
 *
 * The size is declared up front so A-08 has a number to refuse on, rather than
 * discovering the size after the bytes have already crossed the wire.
 */
export const ArtifactUploadRequestBodySchema = z.strictObject({
  kind: ArtifactKindSchema,
  contentType: z.string().min(1),
  sizeBytes: z.int().min(0).max(MAX_ARTIFACT_UPLOAD_BYTES),
});
export type ArtifactUploadRequestBody = z.infer<typeof ArtifactUploadRequestBodySchema>;

/**
 * Where to `PUT` the bytes, and the URI the `Artifact` record will carry.
 *
 * `uploadUrl` is a presigned S3 `PUT`, short-lived, with `contentType` pinned
 * into the signature: a client that uploads a different type is refused by S3.
 * The record is written *after* the bytes are durable, which is why this response
 * does not create one.
 */
export const ArtifactUploadResponseSchema = z.strictObject({
  artifactId: ArtifactIdSchema,
  uri: ArtifactUriSchema,
  uploadUrl: z.string().min(1),
  key: z.string().min(1),
  contentType: z.string().min(1),
  expiresAt: IsoTimestampSchema,
});
export type ArtifactUploadResponse = z.infer<typeof ArtifactUploadResponseSchema>;
