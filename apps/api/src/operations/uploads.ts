/**
 * The presigned artifact upload (T2, A-08, D-P3-13).
 *
 * The function **signs**; the client uploads. That split is the whole point of
 * this route:
 *
 * - The Lambda stays the only holder of AWS credentials (A-19), so an
 *   orchestrator on a laptop needs no AWS profile (A-28).
 * - The bytes never pass through the function. A proxied upload would make the
 *   function's payload limit a hidden maximum artifact size, which is exactly
 *   the kind of limit that is discovered by a truncated log at 3am.
 *
 * The `Artifact` record is written afterwards, by the client, once the bytes are
 * durable. This route creates nothing.
 *
 * The size bound is on the request body schema
 * (`MAX_ARTIFACT_UPLOAD_BYTES`, S3's single-`PUT` limit), so an oversized ask is
 * refused at validation with the issue attached, and a client can check the same
 * constant before asking.
 */
import {
  ArtifactUploadRequestBodySchema,
  type ArtifactUploadResponse,
} from "@nightshift/contracts";
import { HttpError, parseBody } from "../http.js";
import { pathId, runScopeFrom } from "../params.js";
import type { Handler } from "../router.js";
import { requireRun } from "./common.js";

export const createArtifactUploadUrl: Handler = async ({ deps, request, params }) => {
  const body = parseBody(ArtifactUploadRequestBodySchema, request.body);
  const scope = runScopeFrom(params);
  const artifactId = pathId("art", params, "artifactId");
  // The run must exist: a signed URL for a run that does not is a way to write
  // objects under a key nothing will ever reference or clean up.
  await requireRun(deps.stores, scope);

  if (deps.uploads === undefined) {
    throw new HttpError(
      501,
      "uploads_unavailable",
      "this control plane was wired without an artifact upload signer",
    );
  }
  const target = await deps.uploads.sign({
    scope,
    artifactId,
    contentType: body.contentType,
    sizeBytes: body.sizeBytes,
  });
  const response: ArtifactUploadResponse = {
    artifactId,
    uri: target.uri,
    uploadUrl: target.uploadUrl,
    key: target.key,
    contentType: target.contentType,
    expiresAt: target.expiresAt,
  };
  return { status: 200, body: response };
};
