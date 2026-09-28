/**
 * The local control plane (T2 deliverable 5, D-P3-11).
 *
 * A real HTTP server on loopback, running the **production handler** over
 * injected stores. This is what makes the offline slice suite a proof rather
 * than a mock: the MCP server, the http persistence adapter and the execution
 * layer all speak real HTTP to real routing, real validation and every real
 * domain rule. Only three things are stood in for — the identity the gateway
 * would have validated, the table, and the bucket.
 *
 * **If it needs a behaviour the handler lacks, that is a gap in the handler, not
 * a feature of the fake.** Nothing here special-cases a route.
 *
 * ## What is faked, and how faithfully
 *
 * - **Authentication.** No signature is checked. The principal passed to the
 *   factory is injected verbatim, and a request may name a different one with a
 *   `Bearer test-principal.<base64url JSON>` token, which is how a suite switches
 *   caller mid-test (T3 deliverable 6). Nightshift's authorizer does the real
 *   thing in AWS (A-36); a second implementation here would be a second place for
 *   authentication to be subtly wrong, and the smoke suite is where the real
 *   authorizer is proved.
 *
 *   What is *not* faked is **authorisation**: `enforce` runs here exactly as it
 *   does in the Lambda, so the offline two-principal matrix exercises the real
 *   org check and the real §4.4 table.
 * - **Object storage.** Presigned uploads are signed to this server's own
 *   loopback address and the bytes are held in memory. The enforcement S3 applies
 *   is applied here too, and it is exactly the same set: an unknown or expired
 *   signature, a content type that disagrees with it, or a body whose length
 *   disagrees with the declared size is refused. Those are the three things a
 *   real presigned PUT refuses once `content-type` and `content-length` are in
 *   its signed headers, which is how the AWS signer is configured
 *   (`persistence/aws/artifact-bodies.ts` records the probe). A fake that
 *   accepted anything would let the http adapter ship a mismatch that only
 *   production would catch.
 *
 * Never bundled into the Lambda and never deployed: the function entry point does
 * not import this module, so esbuild never reaches it.
 */
import { createHash, generateKeyPairSync, sign as signWith } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { PrincipalSchema } from "@nightshift/contracts";
import type {
  ArtifactDownloadSigner,
  ArtifactUploadSigner,
  Clock,
  NightshiftStores,
  PlanDocumentStore,
} from "@nightshift/core";
import { artifactObjectKey, planDocumentObjectKey, systemClock } from "@nightshift/core";
import type { RequestPrincipal } from "../auth/principal.js";
import { UserTokenLikeSchema } from "../auth/principal.js";
import { handleRequest } from "../handler.js";
import type { ApiDeps, ApiRequest } from "../http.js";
import { splitToken } from "../tokens/jwt.js";
import { verifyExecutionToken } from "../tokens/verify.js";

/** The bucket name the local plane pretends to hold objects in. */
export const LOCAL_BUCKET = "nightshift-local";

/** The issuer local execution tokens carry. Never a real stage's. */
export const LOCAL_TOKEN_ISSUER = "https://api.local.nightshift.invalid";

/**
 * One RSA key pair per process, standing in for KMS (P4, T4).
 *
 * Generated once at module load rather than per plane: key generation costs
 * a beat, and a suite that starts several planes should not pay it several
 * times. Nothing here is a secret — the module never leaves a test run, and the
 * Lambda's entry point does not import it, so esbuild never reaches it.
 *
 * Its presence is what lets the offline slice be a real proof of D-P4-06: the
 * worker mints through the **real** route, holds a **real** JWT, and this plane
 * verifies it with the **real** verifier. Only KMS itself is stood in for.
 */
const localKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });

/** Where a signed upload lands. Not a Nightshift route: only this server serves it. */
const UPLOAD_PATH_PREFIX = "/__local-upload/";

/**
 * Where a signed download is read from (P11, D-P11-06). Like the upload path,
 * not a Nightshift route: the control plane signs, and "S3" — this server —
 * serves the bytes, refusing a URL it never signed or one that has expired,
 * which is what a real presigned GET refuses.
 */
const DOWNLOAD_PATH_PREFIX = "/__local-download/";

/** How long a local signature claims to last. Matches the AWS signer's fifteen minutes. */
const UPLOAD_TTL_SECONDS = 15 * 60;

/**
 * The bearer-token prefix a suite uses to act as somebody else (T3 deliverable 6).
 *
 * Named so it could never be mistaken for a real credential, and readable only
 * by this module — which is never bundled into the Lambda, because the function
 * entry point does not import it.
 */
export const TEST_PRINCIPAL_PREFIX = "test-principal.";

/** A principal a suite can hand to `staticTokenProvider`, so the http adapter carries it. */
export const encodeTestPrincipal = (principal: RequestPrincipal): string =>
  TEST_PRINCIPAL_PREFIX + Buffer.from(JSON.stringify(principal), "utf8").toString("base64url");

const parseTestPrincipal = (encoded: string): RequestPrincipal | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  const execution = PrincipalSchema.safeParse(parsed);
  if (execution.success && execution.data.kind === "execution") return execution.data;
  const user = UserTokenLikeSchema.safeParse(parsed);
  if (!user.success) return undefined;
  const { userId, activeOrg } = user.data;
  return activeOrg === undefined ? { kind: "user", userId } : { kind: "user", userId, activeOrg };
};

/**
 * The principal a request declared, `undefined` for "use the plane's default",
 * or `"malformed"` for a token that could not be read — which is a 401, because
 * a suite that meant to act as someone else and failed should see that rather
 * than silently act as the operator.
 *
 * Two kinds of bearer are understood, mirroring the deployed authorizer: a
 * `test-principal` token, which a suite writes to switch caller; and a real
 * execution token signed by this process's key, which is what a worker actually
 * holds. Anything else falls through to the plane's default, because API
 * Gateway's authorizer is what validates a Cognito token and there is none here.
 */
const principalFromHeader = (
  authorization: string | undefined,
  now: number,
): RequestPrincipal | undefined | "malformed" => {
  const match = /^bearer\s+(\S+)$/i.exec((authorization ?? "").trim());
  const token = match?.[1];
  if (token === undefined) return undefined;

  if (token.startsWith(TEST_PRINCIPAL_PREFIX)) {
    return parseTestPrincipal(token.slice(TEST_PRINCIPAL_PREFIX.length)) ?? "malformed";
  }

  // Routed by `iss`, exactly as the deployed authorizer routes: a token this
  // plane issued is verified for real, and a failure is then a refusal rather
  // than a fall-through to the operator. Anything else — a Cognito ID token, for
  // instance — is not this plane's to check, because API Gateway's authorizer is
  // what validates one in AWS.
  const parts = splitToken(token);
  if (parts === undefined) return undefined;
  if ((parts.payload as { iss?: unknown } | null)?.iss !== LOCAL_TOKEN_ISSUER) return undefined;

  const verified = verifyExecutionToken(token, {
    publicKey: localKeys.publicKey,
    issuer: LOCAL_TOKEN_ISSUER,
    now,
  });
  return verified.ok ? verified.principal : "malformed";
};

export interface LocalBody {
  readonly body: Uint8Array;
  readonly contentType: string;
  readonly sha256: string;
}

/** The object store, readable by a test that wants to assert on an artifact's bytes. */
export interface LocalBodies {
  /** Keyed by `<projectId>/<programId>/<runId>/<artifactId>`. */
  readonly objects: ReadonlyMap<string, LocalBody>;
  get(key: string): LocalBody | undefined;
  /** The decoded text of one object, for an assertion about a log's contents. */
  text(key: string): string | undefined;
  clear(): void;
}

export interface LocalControlPlaneOptions {
  readonly stores: NightshiftStores;
  /**
   * Who every request is treated as coming from, unless it names another
   * principal with a `test-principal` bearer token. Typically the operator's
   * user token, so `resolveActingOrg` resolves exactly as it would against a
   * real ID token.
   */
  readonly principal: RequestPrincipal;
  readonly clock?: Clock;
  /** Loopback host. `127.0.0.1` by default, and there is no reason to change it. */
  readonly host?: string;
}

export interface LocalControlPlane {
  /** `http://127.0.0.1:<port>`, with no trailing slash. */
  readonly url: string;
  readonly port: number;
  readonly bodies: LocalBodies;
  /** The deps the handler was wired with, for a test that wants to reach past HTTP. */
  readonly deps: ApiDeps;
  close(): Promise<void>;
}

/** An issued upload signature. Held so the PUT handler can check what was promised. */
interface IssuedUpload {
  readonly key: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly expiresAtMs: number;
}

/** An issued download signature: which key, until when. */
interface IssuedDownload {
  readonly key: string;
  readonly expiresAtMs: number;
}

const readBody = (request: IncomingMessage): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });

const send = (response: ServerResponse, status: number, body?: unknown): void => {
  if (body === undefined) {
    response.writeHead(status);
    response.end();
    return;
  }
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
  });
  response.end(text);
};

export const startLocalControlPlane = async (
  options: LocalControlPlaneOptions,
): Promise<LocalControlPlane> => {
  const host = options.host ?? "127.0.0.1";
  const clock = options.clock ?? systemClock;
  const objects = new Map<string, LocalBody>();
  const issued = new Map<string, IssuedUpload>();
  const issuedDownloads = new Map<string, IssuedDownload>();
  let nextToken = 0;
  /** Assigned once the server is listening; every signed URL needs the port. */
  let origin = "";

  const bodies: LocalBodies = {
    objects,
    get: (key) => objects.get(key),
    text: (key) => {
      const found = objects.get(key);
      return found === undefined ? undefined : new TextDecoder().decode(found.body);
    },
    clear: () => {
      objects.clear();
      issued.clear();
      issuedDownloads.clear();
    },
  };

  /**
   * Plan documents (P7): signed and stored exactly as artifact bodies are, under
   * their own prefix, and read back by the ratification route as S3 would be.
   */
  const plans: PlanDocumentStore = {
    signUpload: async (request) => {
      const key = planDocumentObjectKey(request.scope, request.sha256);
      nextToken += 1;
      const token = `t${nextToken}`;
      const expiresAtMs = clock.now() + UPLOAD_TTL_SECONDS * 1000;
      issued.set(token, {
        key,
        contentType: request.contentType,
        sizeBytes: request.sizeBytes,
        expiresAtMs,
      });
      return {
        uri: `s3://${LOCAL_BUCKET}/${key}`,
        uploadUrl: `${origin}${UPLOAD_PATH_PREFIX}${token}`,
        key,
        contentType: request.contentType,
        expiresAt: new Date(expiresAtMs).toISOString(),
      };
    },
    get: async (scope, sha256) => {
      const key = planDocumentObjectKey(scope, sha256);
      const found = objects.get(key);
      return found === undefined
        ? undefined
        : { uri: `s3://${LOCAL_BUCKET}/${key}`, body: found.body };
    },
  };

  const uploads: ArtifactUploadSigner = {
    sign: async (request) => {
      const key = `${request.scope.projectId}/${request.scope.programId}/${request.scope.runId}/${request.artifactId}`;
      nextToken += 1;
      const token = `t${nextToken}`;
      issued.set(token, {
        key,
        contentType: request.contentType,
        sizeBytes: request.sizeBytes,
        expiresAtMs: clock.now() + UPLOAD_TTL_SECONDS * 1000,
      });
      return {
        uri: `s3://${LOCAL_BUCKET}/${key}`,
        uploadUrl: `${origin}${UPLOAD_PATH_PREFIX}${token}`,
        key,
        contentType: request.contentType,
        expiresAt: new Date(clock.now() + UPLOAD_TTL_SECONDS * 1000).toISOString(),
      };
    },
  };

  /** The download signer (P11, D-P11-06): a token naming the key, served below. */
  const downloads: ArtifactDownloadSigner = {
    sign: async (request) => {
      nextToken += 1;
      const token = `d${nextToken}`;
      const expiresAtMs = clock.now() + UPLOAD_TTL_SECONDS * 1000;
      issuedDownloads.set(token, {
        key: artifactObjectKey(request.scope, request.artifactId),
        expiresAtMs,
      });
      return {
        url: `${origin}${DOWNLOAD_PATH_PREFIX}${token}`,
        expiresAt: new Date(expiresAtMs).toISOString(),
      };
    },
  };

  /**
   * The execution-token signer, wired the way the Lambda's is: through the
   * `ExecutionTokenSigner` port, so `mintExecutionToken` runs here exactly as it
   * runs in AWS. The private key is this process's, not KMS's, and that is the
   * only difference.
   */
  const deps: ApiDeps = {
    stores: options.stores,
    clock,
    uploads,
    downloads,
    plans,
    tokens: {
      issuer: LOCAL_TOKEN_ISSUER,
      signer: { sign: async (input) => signWith("sha256", input, localKeys.privateKey) },
    },
  };

  /** The object-store half: a `PUT` to a URL this server signed. */
  const handleUpload = async (
    request: IncomingMessage,
    response: ServerResponse,
    token: string,
  ): Promise<void> => {
    if (request.method !== "PUT") {
      send(response, 405, { error: { code: "method_not_allowed", message: "uploads are PUT" } });
      return;
    }
    const promised = issued.get(token);
    if (promised === undefined) {
      send(response, 403, {
        error: { code: "signature_unknown", message: "this upload URL was never signed" },
      });
      return;
    }
    if (promised.expiresAtMs < clock.now()) {
      send(response, 403, {
        error: { code: "signature_expired", message: "this upload URL has expired" },
      });
      return;
    }
    const contentType = request.headers["content-type"];
    if (contentType !== promised.contentType) {
      send(response, 400, {
        error: {
          code: "content_type_mismatch",
          message: `the signature pins ${promised.contentType}; the upload declared ${String(contentType)}`,
        },
      });
      return;
    }
    const body = await readBody(request);
    if (body.length !== promised.sizeBytes) {
      send(response, 400, {
        error: {
          code: "size_mismatch",
          message: `the signature declared ${promised.sizeBytes} bytes; the upload carried ${body.length}`,
        },
      });
      return;
    }
    objects.set(promised.key, {
      body: new Uint8Array(body),
      contentType: promised.contentType,
      sha256: createHash("sha256").update(body).digest("hex"),
    });
    send(response, 200);
  };

  /** The object-store half of a read: a `GET` of a URL this server signed. */
  const handleDownload = (
    request: IncomingMessage,
    response: ServerResponse,
    token: string,
  ): void => {
    if (request.method !== "GET") {
      send(response, 405, { error: { code: "method_not_allowed", message: "downloads are GET" } });
      return;
    }
    const promised = issuedDownloads.get(token);
    if (promised === undefined) {
      send(response, 403, {
        error: { code: "signature_unknown", message: "this download URL was never signed" },
      });
      return;
    }
    if (promised.expiresAtMs < clock.now()) {
      send(response, 403, {
        error: { code: "signature_expired", message: "this download URL has expired" },
      });
      return;
    }
    const found = objects.get(promised.key);
    if (found === undefined) {
      // S3 answers a signed GET of a missing key with 404 when the signer may
      // read the prefix, and that is the case here: the signature was issued for
      // an artifact whose record exists, so a missing body is the finding.
      send(response, 404, { error: { code: "no_such_key", message: "no object at this key" } });
      return;
    }
    response.writeHead(200, {
      "content-type": found.contentType,
      "content-length": found.body.byteLength,
    });
    response.end(Buffer.from(found.body));
  };

  /** The control-plane half: the production handler, verbatim. */
  const handleApi = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? "/", origin === "" ? `http://${host}` : origin);
    const query: Record<string, string | undefined> = {};
    for (const [key, value] of url.searchParams) query[key] = value;

    const raw = await readBody(request);
    let body: unknown;
    if (raw.length > 0) {
      try {
        body = JSON.parse(raw.toString("utf8"));
      } catch {
        send(response, 400, {
          error: { code: "invalid_json", message: "the request body is not JSON" },
        });
        return;
      }
    }

    const declared = principalFromHeader(request.headers.authorization, clock.now());
    if (declared === "malformed") {
      send(response, 401, {
        error: { code: "unauthenticated", message: "the test principal is not readable" },
      });
      return;
    }

    const apiRequest: ApiRequest = {
      method: request.method ?? "GET",
      path: url.pathname,
      query,
      body,
      // Nightshift's authorizer validated a token before the handler ran, in
      // AWS. Here the caller either declared one per request or takes the one
      // this plane was started with.
      principal: declared ?? options.principal,
    };
    const result = await handleRequest(deps, apiRequest);
    send(response, result.status, result.body);
  };

  const server: Server = createServer((request, response) => {
    const path = (request.url ?? "/").split("?")[0] ?? "/";
    const work = path.startsWith(UPLOAD_PATH_PREFIX)
      ? handleUpload(request, response, path.slice(UPLOAD_PATH_PREFIX.length))
      : path.startsWith(DOWNLOAD_PATH_PREFIX)
        ? Promise.resolve(
            handleDownload(request, response, path.slice(DOWNLOAD_PATH_PREFIX.length)),
          )
        : handleApi(request, response);
    work.catch((error: unknown) => {
      console.error("local control plane failed", error);
      if (!response.headersSent) {
        send(response, 500, { error: { code: "internal_error", message: "internal error" } });
      } else {
        response.end();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, resolve);
  });
  const address = server.address() as AddressInfo;
  origin = `http://${host}:${address.port}`;

  return {
    url: origin,
    port: address.port,
    bodies,
    deps,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
};
