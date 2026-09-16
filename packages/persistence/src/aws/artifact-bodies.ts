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
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  type ArtifactBodyStore,
  type ArtifactUploadSigner,
  type ArtifactUploadTarget,
  artifactObjectKey,
} from "@nightshift/core";

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

export interface ArtifactBodyStoreConfig {
  readonly bucketName: string;
  readonly objects: ObjectClient;
}

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

/** How long a signed upload URL stays valid (T2). Minutes: long enough for a
 * multi-megabyte log on a slow connection, short enough that a leaked URL is
 * worthless by the time anyone finds it. */
export const UPLOAD_URL_TTL_SECONDS = 15 * 60;

export interface ArtifactUploadSignerConfig {
  readonly bucketName: string;
  readonly s3: S3Client;
  /** Injected so a test can assert the URL without reaching AWS. */
  readonly sign?: (input: {
    readonly bucket: string;
    readonly key: string;
    readonly contentType: string;
    readonly sizeBytes: number;
    readonly expiresIn: number;
  }) => Promise<string>;
  readonly now?: () => number;
}

/**
 * Signs a `PUT` for one artifact body (T2, A-08).
 *
 * The function signs; the client uploads. Nothing here touches S3, which is why
 * the API's IAM statement needs only `s3:PutObject` and no read: signing is a
 * local computation over the credentials the role already holds, and the
 * permission is what the *signature* conveys to its bearer.
 *
 * ## Why `signableHeaders` is not optional
 *
 * Putting `ContentType` and `ContentLength` on the command is **not** enough.
 * Probed against the deployed bucket on 2026-09-15:
 *
 * | Signing                                   | wrong content type | wrong length |
 * |-------------------------------------------|--------------------|--------------|
 * | `ContentType` on the command only         | 200 accepted       | 200 accepted |
 * | `signableHeaders: content-type`            | 403 refused        | 200 accepted |
 * | `signableHeaders: content-type` + `-length`| 403 refused        | 403 refused  |
 *
 * By default a presigned PUT hoists neither header into the signature, so the
 * declared type and size would be documentation rather than enforcement. Both
 * are signed, so A-08's declared size is a real bound and the content type
 * cannot drift from what the `Artifact` record will claim. A client must send
 * exactly the `content-type` and `content-length` it asked to have signed.
 */
export const createArtifactUploadSigner = (
  config: ArtifactUploadSignerConfig,
): ArtifactUploadSigner => {
  const now = config.now ?? Date.now;
  const sign =
    config.sign ??
    (({ bucket, key, contentType, sizeBytes, expiresIn }) =>
      getSignedUrl(
        config.s3,
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          ContentType: contentType,
          ContentLength: sizeBytes,
        }),
        { expiresIn, signableHeaders: new Set(["content-type", "content-length"]) },
      ));

  return {
    sign: async (request): Promise<ArtifactUploadTarget> => {
      const key = artifactObjectKey(request.scope, request.artifactId);
      const uploadUrl = await sign({
        bucket: config.bucketName,
        key,
        contentType: request.contentType,
        sizeBytes: request.sizeBytes,
        expiresIn: UPLOAD_URL_TTL_SECONDS,
      });
      return {
        uri: `s3://${config.bucketName}/${key}`,
        uploadUrl,
        key,
        contentType: request.contentType,
        expiresAt: new Date(now() + UPLOAD_URL_TTL_SECONDS * 1000).toISOString(),
      };
    },
  };
};
