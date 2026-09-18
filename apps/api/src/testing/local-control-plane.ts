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
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { PrincipalSchema } from "@nightshift/contracts";
import type { ArtifactUploadSigner, Clock, NightshiftStores } from "@nightshift/core";
import { systemClock } from "@nightshift/core";
import type { RequestPrincipal } from "../auth/principal.js";
import { UserTokenLikeSchema } from "../auth/principal.js";
import { handleRequest } from "../handler.js";
import type { ApiDeps, ApiRequest } from "../http.js";

/** The bucket name the local plane pretends to hold objects in. */
export const LOCAL_BUCKET = "nightshift-local";

/** Where a signed upload lands. Not a Nightshift route: only this server serves it. */
const UPLOAD_PATH_PREFIX = "/__local-upload/";

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
 * or `"malformed"` for a `test-principal` token that could not be read — which
 * is a 401, because a suite that meant to act as someone else and failed should
 * see that rather than silently act as the operator.
 */
const principalFromHeader = (
  authorization: string | undefined,
): RequestPrincipal | undefined | "malformed" => {
  const match = /^bearer\s+(\S+)$/i.exec((authorization ?? "").trim());
  const token = match?.[1];
  if (token === undefined || !token.startsWith(TEST_PRINCIPAL_PREFIX)) return undefined;
  return parseTestPrincipal(token.slice(TEST_PRINCIPAL_PREFIX.length)) ?? "malformed";
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

  const deps: ApiDeps = { stores: options.stores, clock, uploads };

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

    const declared = principalFromHeader(request.headers.authorization);
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
