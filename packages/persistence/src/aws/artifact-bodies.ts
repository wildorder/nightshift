/**
 * Artifact bodies in S3 (A-08, D-P2-08).
 *
 * DynamoDB holds the `Artifact` reference; the bytes live here, under
 * `<projectId>/<programId>/<runId>/<artifactId>`, so an object's owner is legible
 * from its key alone. Writing a body and recording its reference are separate
 * steps on purpose: the reference is only recorded once the bytes are durable.
 */
import { createHash } from "node:crypto";
import { GetObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import type { ArtifactId } from "@nightshift/contracts";
import type { RunScope } from "@nightshift/core";
import { artifactPrefix } from "./keys.js";

export interface PutObjectInput {
  readonly Bucket: string;
  readonly Key: string;
  readonly Body: Uint8Array;
  readonly ContentType: string;
  /** Base64 SHA-256 of `Body`; S3 refuses the write if the bytes disagree. */
  readonly ChecksumSHA256: string;
}

export interface GetObjectInput {
  readonly Bucket: string;
  readonly Key: string;
}

/** The seam to S3, mirroring `TableClient`. */
export interface ObjectClient {
  putObject(input: PutObjectInput): Promise<void>;
  /** `undefined` when there is no such object. */
  getObject(input: GetObjectInput): Promise<Uint8Array | undefined>;
}

export const s3ObjectClient = (s3: S3Client): ObjectClient => ({
  putObject: async (input) => {
    await s3.send(new PutObjectCommand(input));
  },
  getObject: async (input) => {
    try {
      const output = await s3.send(new GetObjectCommand(input));
      return output.Body === undefined ? undefined : await output.Body.transformToByteArray();
    } catch (error) {
      if (error instanceof Error && error.name === "NoSuchKey") return undefined;
      throw error;
    }
  },
});

export interface StoredBody {
  /** `s3://<bucket>/<key>`, the form `Artifact.uri` records. */
  readonly uri: string;
  readonly key: string;
  readonly sizeBytes: number;
  /** Lowercase hex, the form `Artifact.sha256` records. */
  readonly sha256: string;
}

export interface ArtifactBodyStore {
  put(
    scope: RunScope,
    artifactId: ArtifactId,
    body: Uint8Array | string,
    contentType: string,
  ): Promise<StoredBody>;
  get(scope: RunScope, artifactId: ArtifactId): Promise<Uint8Array | undefined>;
}

export interface ArtifactBodyStoreConfig {
  readonly bucketName: string;
  readonly objects: ObjectClient;
}

export const artifactObjectKey = (scope: RunScope, artifactId: ArtifactId): string =>
  `${artifactPrefix(scope)}${artifactId}`;

export const createArtifactBodyStore = (config: ArtifactBodyStoreConfig): ArtifactBodyStore => ({
  put: async (scope, artifactId, body, contentType) => {
    const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
    const digest = createHash("sha256").update(bytes).digest();
    const key = artifactObjectKey(scope, artifactId);
    // The checksum makes S3 verify the bytes it received against the digest the
    // reference will record, so the two cannot silently disagree.
    await config.objects.putObject({
      Bucket: config.bucketName,
      Key: key,
      Body: bytes,
      ContentType: contentType,
      ChecksumSHA256: digest.toString("base64"),
    });
    return {
      uri: `s3://${config.bucketName}/${key}`,
      key,
      sizeBytes: bytes.length,
      sha256: digest.toString("hex"),
    };
  },
  get: (scope, artifactId) =>
    config.objects.getObject({
      Bucket: config.bucketName,
      Key: artifactObjectKey(scope, artifactId),
    }),
});
