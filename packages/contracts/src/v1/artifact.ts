/**
 * Artifact — a reference to large output held in S3 (A-08).
 *
 * This record deliberately has no content field. DynamoDB holds structured
 * metadata and references; transcripts, logs, diffs and reports live in S3. A
 * store that accepted inline content here would put large output in DynamoDB,
 * which is exactly what A-08 forbids.
 */
import { z } from "zod";
import { ArtifactIdSchema, ExecutionNodeIdSchema } from "../ids.js";
import { IsoTimestampSchema, runScoped } from "./common.js";

/** Drawn from the S3 list in the vision's Data Model. */
export const ArtifactKindSchema = z.enum([
  "transcript",
  "build-log",
  "verification-log",
  "examination-report",
  "diff",
  "report",
  "other",
]);
export type ArtifactKind = z.infer<typeof ArtifactKindSchema>;

/**
 * An opaque storage URI. Validated as a scheme-qualified reference rather than
 * an S3 type, so `contracts` stays free of any AWS dependency.
 */
export const ArtifactUriSchema = z.string().regex(/^[a-z][a-z0-9+.-]*:\/\/[^\s]+$/, {
  message: "must be a scheme-qualified URI, for example s3://bucket/key",
});
export type ArtifactUri = z.infer<typeof ArtifactUriSchema>;

export const ArtifactSchema = z.strictObject({
  ...runScoped,
  artifactId: ArtifactIdSchema,
  executionNodeId: ExecutionNodeIdSchema,
  kind: ArtifactKindSchema,
  uri: ArtifactUriSchema,
  sizeBytes: z.int().min(0),
  contentType: z.string().min(1),
  /** Set when the producer computed one, so replay can detect a changed artifact. */
  sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/, { message: "must be 64 lowercase hex characters" })
    .optional(),
  createdAt: IsoTimestampSchema,
});
export type Artifact = z.infer<typeof ArtifactSchema>;
