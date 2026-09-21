/**
 * Artifact body ports (T2, A-08).
 *
 * `Artifact` is a reference; the bytes live in object storage. These two ports
 * are how everything above the adapter layer reaches those bytes without knowing
 * whether it holds AWS credentials.
 *
 * Lifted out of `packages/persistence/src/aws/` in P3 so the execution layer
 * uploads through a port (D-P3-13). Two implementations are interchangeable
 * behind it:
 *
 * - `persistence/aws` puts the object with the S3 client directly. Only the
 *   Lambda ever does this.
 * - `persistence/http` asks the control plane to sign an upload and then PUTs the
 *   bytes to that URL. Everything local does this, because nothing local holds
 *   AWS credentials (A-28).
 *
 * Writing the bytes and recording the reference stay separate steps: the
 * reference is only written once the bytes are durable.
 */
import type { ArtifactId } from "@nightshift/contracts";
import type { ProgramScope, RunScope } from "../rules/ownership.js";

/** What a caller learns once the bytes are durable. */
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
  /** `undefined` when there is no such object. */
  get(scope: RunScope, artifactId: ArtifactId): Promise<Uint8Array | undefined>;
}

/** What the control plane is asked to sign. The size is declared, so A-08 has a number. */
export interface ArtifactUploadRequest {
  readonly scope: RunScope;
  readonly artifactId: ArtifactId;
  readonly contentType: string;
  readonly sizeBytes: number;
}

/**
 * A place to PUT one artifact body, and the URI the `Artifact` record will carry.
 *
 * The size bound a signer will accept lives on the request body schema in
 * `@nightshift/contracts` (`MAX_ARTIFACT_UPLOAD_BYTES`), so a client can check
 * before asking and the API refuses it at validation rather than after.
 *
 * `uploadUrl` is short-lived and **binds both the content type and the exact
 * byte count** into its signature, so a client that uploads a different type or
 * a different number of bytes than it declared is refused by the object store
 * rather than by a check nobody wrote. An implementer of this port must send
 * exactly the `content-type` and `content-length` it asked to have signed.
 */
export interface ArtifactUploadTarget {
  readonly uri: string;
  readonly uploadUrl: string;
  readonly key: string;
  readonly contentType: string;
  readonly expiresAt: string;
}

/**
 * Signs an upload without touching the object store.
 *
 * Implemented in the API by the presigner, so the Lambda stays the only holder of
 * AWS credentials (A-19) while the client does the transfer. Deliberately not a
 * proxied upload through the function: its payload limit would silently become a
 * maximum artifact size.
 */
export interface ArtifactUploadSigner {
  sign(request: ArtifactUploadRequest): Promise<ArtifactUploadTarget>;
}

/** The object key for one artifact: `<projectId>/<programId>/<runId>/<artifactId>` (D-P2-08). */
export const artifactObjectKey = (scope: RunScope, artifactId: ArtifactId): string =>
  `${scope.projectId}/${scope.programId}/${scope.runId}/${artifactId}`;

/**
 * Where ratified plan documents live (P7, D-P7-02).
 *
 * Program scoped, under a prefix of its own, and named by the document's own
 * SHA-256: `plans/<projectId>/<programId>/<sha256>.md`. The prefix is what lets
 * the API be granted a read of plan documents and of nothing else in the bucket.
 *
 * Unlike an artifact body, the control plane **reads** this one: at ratification
 * it hashes the stored bytes itself, so the record holds exactly what was
 * approved rather than what a client said it uploaded.
 */
export interface PlanDocumentStore {
  signUpload(request: PlanDocumentUploadRequest): Promise<ArtifactUploadTarget>;
  /** `undefined` when nothing has been uploaded under this hash. */
  get(scope: ProgramScope, sha256: string): Promise<StoredPlanDocument | undefined>;
}

export interface StoredPlanDocument {
  /** `s3://<bucket>/<key>`, the form `PlanDocumentRef.uri` records. */
  readonly uri: string;
  readonly body: Uint8Array;
}

export interface PlanDocumentUploadRequest {
  readonly scope: ProgramScope;
  readonly sha256: string;
  readonly contentType: string;
  readonly sizeBytes: number;
}

export const planDocumentObjectKey = (scope: ProgramScope, sha256: string): string =>
  `plans/${scope.projectId}/${scope.programId}/${sha256}.md`;
