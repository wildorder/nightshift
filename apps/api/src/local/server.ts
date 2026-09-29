/**
 * A control plane on loopback (P3, D-P3-11; made the product in P12, D-P12-01,
 * D-P12-09).
 *
 * The **production handler** over injected stores, served on one HTTP port:
 * real routing, validation, `enforce` and `authorize`, with the object store's
 * half (signed uploads and downloads) served by the same server, and execution
 * tokens minted and verified for real over an RSA key standing in for KMS.
 *
 * Two compositions use it and nothing else does:
 *
 * - `nightshift-local` (`bin/nightshift-local.ts`): SQLite stores, files for
 *   bytes, a persisted key, the operator's bearer token, the Studio at `/`.
 * - `startLocalControlPlane` (`testing/`): memory stores and bytes, an injected
 *   principal a suite may switch per request. Every offline suite runs through
 *   it, which is what proves this module for the product.
 *
 * If a suite needs a behaviour the handler lacks, that is a gap in the handler,
 * not a feature of this server. Nothing here special-cases a route.
 */

import { sign as signWith } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, resolve, sep } from "node:path";
import type {
  ArtifactDownloadSigner,
  ArtifactUploadSigner,
  Clock,
  NightshiftStores,
  PlanDocumentStore,
} from "@nightshift/core";
import { artifactObjectKey, planDocumentObjectKey, systemClock } from "@nightshift/core";
import type { RequestPrincipal } from "../auth/principal.js";
import { handleRequest } from "../handler.js";
import type { ApiDeps, ApiRequest } from "../http.js";
import { splitToken } from "../tokens/jwt.js";
import { verifyExecutionToken } from "../tokens/verify.js";
import { LOCAL_TOKEN_ISSUER, type SigningKeys } from "./credentials.js";
import { LOCAL_BUCKET, localBodyOf, type ObjectStore } from "./objects.js";

/** Where a signed upload lands. Not a Nightshift route: only this server serves it. */
const UPLOAD_PATH_PREFIX = "/__local-upload/";
/** Where a signed download is read from (D-P11-06). */
const DOWNLOAD_PATH_PREFIX = "/__local-download/";
/** How long a local signature claims to last. Matches the AWS signer's fifteen minutes. */
const SIGNATURE_TTL_SECONDS = 15 * 60;

/**
 * Who a request is. `undefined` is "no credential this plane accepts": a 401.
 * `"malformed"` is a credential that could not be read: also a 401, said so.
 */
export type Authenticate = (
  authorization: string | undefined,
  now: number,
) => RequestPrincipal | undefined | "malformed";

/**
 * An execution token this plane issued, verified for real, routed by `iss` as
 * the deployed authorizer routes. `undefined` when the bearer is not one.
 */
export const executionTokenPrincipal = (
  token: string,
  keys: SigningKeys,
  now: number,
): RequestPrincipal | undefined | "malformed" => {
  const parts = splitToken(token);
  if (parts === undefined) return undefined;
  if ((parts.payload as { iss?: unknown } | null)?.iss !== LOCAL_TOKEN_ISSUER) return undefined;
  const verified = verifyExecutionToken(token, {
    publicKey: keys.publicKey,
    issuer: LOCAL_TOKEN_ISSUER,
    now,
  });
  return verified.ok ? verified.principal : "malformed";
};

export const bearerOf = (authorization: string | undefined): string | undefined =>
  /^bearer\s+(\S+)$/i.exec((authorization ?? "").trim())?.[1];

/** The Studio, served beside the API (D-P12-04). */
export interface ServedStudio {
  /** A built `apps/studio/dist`. */
  readonly dir: string;
  /** What `/config.json` answers, given this server's origin. */
  readonly config: (origin: string) => unknown;
}

export interface LocalServerOptions {
  readonly stores: NightshiftStores;
  readonly objects: ObjectStore;
  readonly keys: SigningKeys;
  readonly authenticate: Authenticate;
  readonly clock?: Clock;
  readonly host?: string;
  /** 0 picks a free port. */
  readonly port?: number;
  /**
   * Where the API's routes start. `""` in the harness; `/api` in the product,
   * because the Studio at `/` has page paths (`/projects/…`) that are also API
   * routes, and one origin cannot answer both.
   */
  readonly apiPrefix?: string;
  readonly studio?: ServedStudio;
}

export interface LocalServer {
  /** The origin, `http://<host>:<port>`. */
  readonly origin: string;
  /** Where clients point: the origin plus the API prefix. */
  readonly url: string;
  readonly port: number;
  readonly deps: ApiDeps;
  close(): Promise<void>;
}

interface Issued {
  readonly key: string;
  readonly expiresAtMs: number;
}

interface IssuedUpload extends Issued {
  readonly contentType: string;
  readonly sizeBytes: number;
}

const readBody = (request: IncomingMessage): Promise<Buffer> =>
  new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolveBody(Buffer.concat(chunks)));
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

const refuse = (response: ServerResponse, status: number, code: string, message: string): void =>
  send(response, status, { error: { code, message } });

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".map": "application/json",
};

export const startLocalServer = async (options: LocalServerOptions): Promise<LocalServer> => {
  const host = options.host ?? "127.0.0.1";
  const clock = options.clock ?? systemClock;
  const prefix = options.apiPrefix ?? "";
  const { objects, keys } = options;
  const issuedUploads = new Map<string, IssuedUpload>();
  const issuedDownloads = new Map<string, Issued>();
  let nextToken = 0;
  let origin = "";

  const signUploadTo = (key: string, contentType: string, sizeBytes: number) => {
    nextToken += 1;
    const token = `t${nextToken}`;
    const expiresAtMs = clock.now() + SIGNATURE_TTL_SECONDS * 1000;
    issuedUploads.set(token, { key, contentType, sizeBytes, expiresAtMs });
    return {
      uri: `s3://${LOCAL_BUCKET}/${key}`,
      uploadUrl: `${origin}${UPLOAD_PATH_PREFIX}${token}`,
      key,
      contentType,
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
  };

  const plans: PlanDocumentStore = {
    signUpload: async (request) =>
      signUploadTo(
        planDocumentObjectKey(request.scope, request.sha256),
        request.contentType,
        request.sizeBytes,
      ),
    get: async (scope, sha256) => {
      const key = planDocumentObjectKey(scope, sha256);
      const found = objects.get(key);
      return found === undefined
        ? undefined
        : { uri: `s3://${LOCAL_BUCKET}/${key}`, body: found.body };
    },
  };

  const uploads: ArtifactUploadSigner = {
    sign: async (request) =>
      signUploadTo(
        artifactObjectKey(request.scope, request.artifactId),
        request.contentType,
        request.sizeBytes,
      ),
  };

  const downloads: ArtifactDownloadSigner = {
    sign: async (request) => {
      nextToken += 1;
      const token = `d${nextToken}`;
      const expiresAtMs = clock.now() + SIGNATURE_TTL_SECONDS * 1000;
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

  const deps: ApiDeps = {
    stores: options.stores,
    clock,
    uploads,
    downloads,
    plans,
    tokens: {
      issuer: LOCAL_TOKEN_ISSUER,
      signer: { sign: async (input) => signWith("sha256", input, keys.privateKey) },
    },
  };

  /** A `PUT` to a URL this server signed: the three refusals a presigned S3 PUT makes. */
  const handleUpload = async (
    request: IncomingMessage,
    response: ServerResponse,
    token: string,
  ) => {
    if (request.method !== "PUT")
      return refuse(response, 405, "method_not_allowed", "uploads are PUT");
    const promised = issuedUploads.get(token);
    if (promised === undefined)
      return refuse(response, 403, "signature_unknown", "this upload URL was never signed");
    if (promised.expiresAtMs < clock.now())
      return refuse(response, 403, "signature_expired", "this upload URL has expired");
    const contentType = request.headers["content-type"];
    if (contentType !== promised.contentType) {
      return refuse(
        response,
        400,
        "content_type_mismatch",
        `the signature pins ${String(promised.contentType)}; the upload declared ${String(contentType)}`,
      );
    }
    const body = await readBody(request);
    if (body.length !== promised.sizeBytes) {
      return refuse(
        response,
        400,
        "size_mismatch",
        `the signature declared ${String(promised.sizeBytes)} bytes; the upload carried ${body.length}`,
      );
    }
    objects.set(promised.key, localBodyOf(new Uint8Array(body), promised.contentType));
    send(response, 200);
  };

  /** A `GET` of a URL this server signed. */
  const handleDownload = (request: IncomingMessage, response: ServerResponse, token: string) => {
    if (request.method !== "GET")
      return refuse(response, 405, "method_not_allowed", "downloads are GET");
    const promised = issuedDownloads.get(token);
    if (promised === undefined)
      return refuse(response, 403, "signature_unknown", "this download URL was never signed");
    if (promised.expiresAtMs < clock.now())
      return refuse(response, 403, "signature_expired", "this download URL has expired");
    const found = objects.get(promised.key);
    if (found === undefined) return refuse(response, 404, "no_such_key", "no object at this key");
    response.writeHead(200, {
      "content-type": found.contentType,
      "content-length": found.body.byteLength,
    });
    response.end(Buffer.from(found.body));
  };

  /** The control-plane half: the production handler, verbatim. */
  const handleApi = async (request: IncomingMessage, response: ServerResponse, path: string) => {
    const url = new URL(request.url ?? "/", origin === "" ? `http://${host}` : origin);
    const query: Record<string, string | undefined> = {};
    for (const [key, value] of url.searchParams) query[key] = value;

    const raw = await readBody(request);
    let body: unknown;
    if (raw.length > 0) {
      try {
        body = JSON.parse(raw.toString("utf8"));
      } catch {
        return refuse(response, 400, "invalid_json", "the request body is not JSON");
      }
    }

    const principal = options.authenticate(request.headers.authorization, clock.now());
    if (principal === "malformed") {
      return refuse(response, 401, "unauthenticated", "the bearer token could not be read");
    }
    if (principal === undefined) {
      return refuse(
        response,
        401,
        "unauthenticated",
        "this control plane accepts its own bearer token and nothing else",
      );
    }

    const apiRequest: ApiRequest = {
      method: request.method ?? "GET",
      path,
      query,
      body,
      principal,
    };
    const result = await handleRequest(deps, apiRequest);
    send(response, result.status, result.body);
  };

  /** The Studio: its files by path, `config.json`, and `index.html` for every page path. */
  const studioRoot = options.studio === undefined ? undefined : resolve(options.studio.dir);
  /** The file a Studio path answers with: itself when it is a file inside the root, else the app. */
  const studioFileFor = (root: string, path: string): string => {
    const candidate = resolve(root, `.${decodeURIComponent(path)}`);
    const inside = candidate === root || candidate.startsWith(root + sep);
    return inside && existsSync(candidate) && statSync(candidate).isFile()
      ? candidate
      : join(root, "index.html");
  };

  const handleStudio = (request: IncomingMessage, response: ServerResponse, path: string): void => {
    const studio = options.studio;
    if (studio === undefined || studioRoot === undefined) {
      refuse(response, 404, "not_found", "no such route");
    } else if (request.method !== "GET" && request.method !== "HEAD") {
      refuse(response, 405, "method_not_allowed", "the Studio's files are read-only");
    } else if (path === "/config.json") {
      send(response, 200, studio.config(origin));
    } else {
      const file = studioFileFor(studioRoot, path);
      if (!existsSync(file)) {
        refuse(response, 404, "not_found", "the Studio is not built");
        return;
      }
      response.writeHead(200, {
        "content-type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream",
        "cache-control": file.endsWith("index.html")
          ? "no-cache"
          : "public, max-age=31536000, immutable",
      });
      if (request.method === "HEAD") response.end();
      else createReadStream(file).pipe(response);
    }
  };

  const server: Server = createServer((request, response) => {
    const path = (request.url ?? "/").split("?")[0] ?? "/";
    let work: Promise<void> | void;
    if (path.startsWith(UPLOAD_PATH_PREFIX)) {
      work = handleUpload(request, response, path.slice(UPLOAD_PATH_PREFIX.length));
    } else if (path.startsWith(DOWNLOAD_PATH_PREFIX)) {
      work = handleDownload(request, response, path.slice(DOWNLOAD_PATH_PREFIX.length));
    } else if (prefix === "" || path === prefix || path.startsWith(`${prefix}/`)) {
      work = handleApi(request, response, prefix === "" ? path : path.slice(prefix.length) || "/");
    } else {
      work = handleStudio(request, response, path);
    }
    Promise.resolve(work).catch((error: unknown) => {
      console.error("local control plane failed", error);
      if (!response.headersSent) refuse(response, 500, "internal_error", "internal error");
      else response.end();
    });
  });

  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, resolveListen);
  });
  const address = server.address() as AddressInfo;
  origin = `http://${host}:${address.port}`;

  return {
    origin,
    url: `${origin}${prefix}`,
    port: address.port,
    deps,
    close: () =>
      new Promise<void>((resolveClose, reject) => {
        server.closeAllConnections();
        server.close((error) => (error === undefined ? resolveClose() : reject(error)));
      }),
  };
};
