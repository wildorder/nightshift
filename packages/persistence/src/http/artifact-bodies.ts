/**
 * Artifact bodies through the control plane (A-08, A-28, D-P3-13).
 *
 * Three steps, in this order, and the order is the point:
 *
 * 1. Ask the control plane to sign an upload. It signs; it never sees the bytes.
 * 2. `PUT` the bytes to the signed URL. **Both** `content-type` and
 *    `content-length` are sent, because both are inside the signature — a
 *    presigned S3 PUT refuses a mismatch on either with a 403. Sending a
 *    different type or a different number of bytes than were declared is not a
 *    silent success here or in production.
 * 3. Return the digest and the URI the `Artifact` record will carry. Writing that
 *    record is the caller's next step, and it happens only once this resolves,
 *    so a reference never points at bytes that are not there.
 *
 * Interchangeable with the S3 implementation behind `ArtifactBodyStore`, which is
 * what lets the execution layer upload without knowing whether it holds AWS
 * credentials. It does not: nothing local does (A-28).
 */
import { createHash } from "node:crypto";
import {
  type ArtifactId,
  ArtifactUploadResponseSchema,
  type ArtifactUri,
} from "@nightshift/contracts";
import type { ArtifactBodyStore, RunScope, StoredBody } from "@nightshift/core";
import { ControlPlaneError } from "./errors.js";
import { routes } from "./routes.js";
import { send, type Transport } from "./transport.js";

/** The slice of `fetch` the upload needs. Injected so a test opens no socket. */
export type UploadFetch = (
  url: string,
  init: {
    readonly method: "PUT";
    readonly headers: Record<string, string>;
    readonly body: Uint8Array;
  },
) => Promise<{ readonly status: number; text(): Promise<string> }>;

export interface HttpArtifactBodyStoreOptions {
  readonly transport: Transport;
  readonly fetch?: UploadFetch;
  /**
   * How a body is read back.
   *
   * There is deliberately no route that serves artifact bytes: the control plane
   * signs uploads and nothing else, and a download route would make the Lambda a
   * proxy for arbitrarily large objects. A caller that must read a body — the
   * deployed slice suite, reading a verification log back — supplies this, using
   * the AWS SDK and the recorded `s3://` URI. Without it, `get` says so rather
   * than returning `undefined`, which would look like an absent artifact.
   */
  readonly read?: (scope: RunScope, artifactId: ArtifactId) => Promise<Uint8Array | undefined>;
}

const toBytes = (body: Uint8Array | string): Uint8Array =>
  typeof body === "string" ? new TextEncoder().encode(body) : body;

export const createHttpArtifactBodyStore = (
  options: HttpArtifactBodyStoreOptions,
): ArtifactBodyStore => {
  const upload = options.fetch ?? (globalThis.fetch as unknown as UploadFetch);

  return {
    put: async (scope, artifactId, body, contentType): Promise<StoredBody> => {
      const bytes = toBytes(body);
      const target = ArtifactUploadResponseSchema.parse(
        await send(
          options.transport,
          {
            method: "POST",
            path: routes.artifactUploadUrl(scope, artifactId),
            body: { kind: "other", contentType, sizeBytes: bytes.length },
          },
          [200],
        ),
      );

      const response = await upload(target.uploadUrl, {
        method: "PUT",
        headers: {
          "content-type": contentType,
          // In the signature. Omitting it, or sending a different number, is a
          // 403 from S3 rather than a corrupt object.
          "content-length": String(bytes.length),
        },
        body: bytes,
      });
      if (response.status < 200 || response.status >= 300) {
        throw new ControlPlaneError(
          response.status,
          "artifact_upload_failed",
          `the signed upload for ${artifactId} answered ${response.status}: ${(
            await response.text()
          ).slice(0, 500)}`,
        );
      }

      return {
        uri: target.uri satisfies ArtifactUri,
        key: target.key,
        sizeBytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    },

    get: async (scope, artifactId) => {
      if (options.read === undefined) {
        throw new ControlPlaneError(
          501,
          "artifact_read_unavailable",
          "this artifact body store can write but not read: the control plane signs uploads and " +
            "serves no download route. Supply `read` to fetch the bytes from object storage.",
        );
      }
      return options.read(scope, artifactId);
    },
  };
};
