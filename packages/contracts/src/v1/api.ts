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
import { ArtifactIdSchema, RunIdSchema } from "../ids.js";
import { AgentSchema } from "./agent.js";
import { ArtifactKindSchema, ArtifactSchema, ArtifactUriSchema } from "./artifact.js";
import { CheckpointSchema } from "./checkpoint.js";
import { IsoTimestampSchema } from "./common.js";
import { DecisionSchema } from "./decision.js";
import { EventSchema, inlinePayloadBytes, MAX_INLINE_PAYLOAD_BYTES } from "./event.js";
import { ExaminationSchema } from "./examination.js";
import { ExecutionNodeSchema } from "./execution-node.js";
import { JobContractSchema } from "./job-contract.js";
import {
  CheckDispatchSchema,
  CheckSiteSchema,
  MAX_PLAN_DOCUMENT_BYTES,
  PlanDocumentRefSchema,
  PlanHashSchema,
  PrerequisiteSchema,
} from "./plan.js";
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

/**
 * `POST …/artifacts/{artifactId}/download-url` (P11, D-P11-06).
 *
 * The mirror of the upload: the control plane signs a `GET` for an artifact
 * whose record exists, and the bytes go from object storage to the caller
 * without passing through the function. The request carries no body — the path
 * names the artifact and the record says what is there — so there is only a
 * response shape. `url` is short-lived; a client fetches it at once rather than
 * storing it.
 */
export const ArtifactDownloadResponseSchema = z.strictObject({
  url: z.string().min(1),
  expiresAt: IsoTimestampSchema,
});
export type ArtifactDownloadResponse = z.infer<typeof ArtifactDownloadResponseSchema>;

// ---------------------------------------------------------------------------
// Planning (P7, T1; D-P7-02, D-P7-05, D-P7-10)
// ---------------------------------------------------------------------------

/** The one content type a plan document is stored under. It is markdown, and the signature pins it. */
export const PLAN_DOCUMENT_CONTENT_TYPE = "text/markdown; charset=utf-8";

/**
 * `POST …/programs/{programId}/plan-documents/{sha256}/upload-url`.
 *
 * Program scoped, where an artifact upload is run scoped: at ratification there
 * is no run yet. The document is named by its own SHA-256, so one is stored per
 * ratified plan and an upload can only ever put the bytes its name promises.
 */
export const PlanDocumentUploadRequestBodySchema = z.strictObject({
  sizeBytes: z.int().min(1).max(MAX_PLAN_DOCUMENT_BYTES),
});
export type PlanDocumentUploadRequestBody = z.infer<typeof PlanDocumentUploadRequestBodySchema>;

export const PlanDocumentUploadResponseSchema = z.strictObject({
  sha256: PlanHashSchema,
  uri: z.string().min(1),
  uploadUrl: z.string().min(1),
  key: z.string().min(1),
  contentType: z.string().min(1),
  expiresAt: IsoTimestampSchema,
});
export type PlanDocumentUploadResponse = z.infer<typeof PlanDocumentUploadResponseSchema>;

/** `GET …/programs/{programId}/plan-documents/{sha256}`: the document, byte for byte (SC-P7-04). */
export const PlanDocumentResponseSchema = z.strictObject({
  planDocument: PlanDocumentRefSchema,
  text: z.string(),
});
export type PlanDocumentResponse = z.infer<typeof PlanDocumentResponseSchema>;

/**
 * `POST …/programs/{programId}/ratifications`.
 *
 * The contract as approved, the hash the client computed over it and the plan
 * document, and the SHA-256 of the document it uploaded. The control plane
 * recomputes all of it from the contract and the stored bytes, so what it
 * records is what it holds, not what it was told.
 */
export const RatificationRequestBodySchema = z.strictObject({
  contract: ProgramContractSchema,
  planHash: PlanHashSchema,
  planSha256: PlanHashSchema,
  /**
   * P14 (D-P14-06): the SHA-256 of the kept planning conversation, uploaded the
   * same way as the plan document. The control plane checks the stories' quotes
   * against the bytes it holds (D-P14-04).
   */
  conversationSha256: PlanHashSchema.optional(),
});
export type RatificationRequestBody = z.infer<typeof RatificationRequestBodySchema>;

/**
 * `PUT …/programs/{programId}/prerequisites/{prerequisiteId}`, one of:
 *
 * - `check`: a deterministic run of the `verifyCommand`, and its exit code,
 *   saying where it ran (P16, D-08). On the `laptop` (the default, as before
 *   P16), the preflight's: zero satisfies the prerequisite; anything else leaves
 *   or returns it to `pending`. There is no way to say "satisfied" without one.
 *   On a `machine`, the engine's, under the `dispatch` it names: kept among the
 *   prerequisite's `machineChecks`, and `status` is untouched.
 * - `discovered`: the engine met a hurdle nobody planned for (D-P7-10).
 */
export const PrerequisiteWriteBodySchema = z.discriminatedUnion("kind", [
  z
    .strictObject({
      kind: z.literal("check"),
      exitCode: z.int(),
      where: CheckSiteSchema.optional(),
      dispatch: CheckDispatchSchema.optional(),
    })
    .refine((body) => (body.where === "machine") === (body.dispatch !== undefined), {
      message: "a machine check names the dispatch it ran under, and only a machine check does",
      path: ["dispatch"],
    }),
  z.strictObject({
    kind: z.literal("discovered"),
    runId: RunIdSchema,
    description: z.string().min(1),
    remediation: z.string(),
    verifyCommand: z.string(),
  }),
]);
export type PrerequisiteWriteBody = z.infer<typeof PrerequisiteWriteBodySchema>;

export const PrerequisiteListResponseSchema = z.strictObject({
  items: z.array(PrerequisiteSchema),
});
export type PrerequisiteListResponse = z.infer<typeof PrerequisiteListResponseSchema>;
