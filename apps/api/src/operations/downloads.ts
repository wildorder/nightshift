/**
 * The presigned artifact download (P11, D-P11-06).
 *
 * The mirror of `uploads.ts`: the function **signs**; the client fetches. The
 * split buys the same things it bought the upload — the Lambda stays the only
 * holder of AWS credentials (A-19, A-28), and the bytes never pass through a
 * function whose payload limit would otherwise become a hidden maximum artifact
 * size. The Studio opens transcripts, verification logs and examination
 * reports through it.
 *
 * Two things this route insists on before it signs:
 *
 * - **The `Artifact` record exists.** A signed read of an object nothing
 *   references would be a way to probe the bucket by guessing identifiers; the
 *   record is what says the bytes are this run's to show.
 * - **The caller is a user principal.** That is decided before this code runs,
 *   by `authorize` in `core`, which gives no execution role a cell for
 *   `artifact.createDownloadUrl`. Nothing here checks it again (SC-P4-08).
 *
 * The signature names the key `artifactObjectKey` builds from the path's run
 * scope, never a caller-supplied key and never the record's `uri`: the two are
 * the same string for every artifact the control plane signed the upload of,
 * and deriving it keeps a record that somehow carried another bucket's URI from
 * becoming a read of that bucket.
 */
import type { ArtifactDownloadResponse } from "@nightshift/contracts";
import { HttpError } from "../http.js";
import { pathId, runScopeFrom } from "../params.js";
import type { Handler } from "../router.js";

export const createArtifactDownloadUrl: Handler = async ({ deps, params }) => {
  const scope = runScopeFrom(params);
  const artifactId = pathId("art", params, "artifactId");

  const artifact = await deps.stores.artifacts.get(scope, artifactId);
  if (artifact === undefined) {
    throw new HttpError(404, "not_found", `artifact ${artifactId} does not exist in this run`);
  }

  if (deps.downloads === undefined) {
    throw new HttpError(
      501,
      "downloads_unavailable",
      "this control plane was wired without an artifact download signer",
    );
  }
  const target = await deps.downloads.sign({ scope, artifactId });
  const response: ArtifactDownloadResponse = { url: target.url, expiresAt: target.expiresAt };
  return { status: 200, body: response };
};
