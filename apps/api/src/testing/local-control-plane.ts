/**
 * The local control plane the offline suites run (T2 deliverable 5, D-P3-11):
 * since P12 (D-P12-09) a composition of `local/server.ts`, the same server
 * `nightshift-local` runs, over test doubles.
 *
 * The production handler over injected stores, on loopback. Only three things
 * are stood in for — the identity the gateway would have validated, the table,
 * and the bucket.
 *
 * ## What is faked, and how faithfully
 *
 * - **Authentication.** No signature is checked on a user's bearer. The
 *   principal passed to the factory is used for any request that names no
 *   other, and a request may name a different one with a
 *   `Bearer test-principal.<base64url JSON>` token, which is how a suite
 *   switches caller mid-test (T3 deliverable 6). An execution token this plane
 *   issued is verified for real. The product plane accepts neither the default
 *   nor `test-principal.` (D-P12-03): that is the whole of the difference.
 *
 *   What is *not* faked is **authorisation**: `enforce` runs here exactly as it
 *   does in the Lambda.
 * - **Object storage.** Bytes in memory; the three refusals a presigned S3 PUT
 *   makes are made (`local/server.ts`).
 *
 * Never bundled into the Lambda and never deployed: the function entry point does
 * not import this module, so esbuild never reaches it.
 */
import { PrincipalSchema } from "@nightshift/contracts";
import type { Clock, GitHubAppClient, NightshiftStores } from "@nightshift/core";
import type { RequestPrincipal } from "../auth/principal.js";
import { UserTokenLikeSchema } from "../auth/principal.js";
import { createLocalEnvelope, generateMasterKey } from "../envelope.js";
import type { ApiDeps, Dispatcher } from "../http.js";
import { ephemeralKeys } from "../local/credentials.js";
import { createMemoryObjectStore, type LocalBody } from "../local/objects.js";
import { bearerOf, executionTokenPrincipal, startLocalServer } from "../local/server.js";

export { LOCAL_TOKEN_ISSUER } from "../local/credentials.js";
export { LOCAL_BUCKET, type LocalBody } from "../local/objects.js";

/**
 * One RSA key pair per process, standing in for KMS (P4, T4). Generated once at
 * module load: a suite that starts several planes should not pay for several.
 */
const localKeys = ephemeralKeys();

/**
 * The bearer-token prefix a suite uses to act as somebody else (T3 deliverable 6).
 * Named so it could never be mistaken for a real credential.
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

export interface LocalBodies {
  readonly objects: ReadonlyMap<string, LocalBody>;
  get(key: string): LocalBody | undefined;
  text(key: string): string | undefined;
  clear(): void;
}

export interface LocalControlPlaneOptions {
  readonly stores: NightshiftStores;
  /**
   * The caller for any request that does not declare one. A suite switches
   * principal with a `test-principal` bearer token. Typically the operator's
   * user principal.
   */
  readonly principal: RequestPrincipal;
  readonly clock?: Clock;
  readonly host?: string;
  /** The Nightshift GitHub App's answers (P10, D-P10-02), when a suite needs the routes. */
  readonly github?: GitHubAppClient;
  /** What provisions a dispatch (P10, D-P10-18), when a suite dispatches. */
  readonly dispatcher?: Dispatcher;
}

export interface LocalControlPlane {
  readonly url: string;
  readonly port: number;
  readonly bodies: LocalBodies;
  readonly deps: ApiDeps;
  close(): Promise<void>;
}

export const startLocalControlPlane = async (
  options: LocalControlPlaneOptions,
): Promise<LocalControlPlane> => {
  const objects = createMemoryObjectStore();
  const server = await startLocalServer({
    stores: options.stores,
    objects,
    keys: localKeys,
    // A master key for this plane only (D-P10-23): the credential routes seal
    // under it, and nothing a suite stores survives the plane.
    envelope: createLocalEnvelope(generateMasterKey()),
    ...(options.github === undefined ? {} : { github: options.github }),
    ...(options.dispatcher === undefined ? {} : { dispatcher: options.dispatcher }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.host === undefined ? {} : { host: options.host }),
    // A declared principal, a real execution token, or the plane's default:
    // anything else falls through to the default, because API Gateway's
    // authorizer is what validates a Cognito token and there is none here.
    authenticate: (authorization, now) => {
      const token = bearerOf(authorization);
      if (token === undefined) return options.principal;
      if (token.startsWith(TEST_PRINCIPAL_PREFIX)) {
        return parseTestPrincipal(token.slice(TEST_PRINCIPAL_PREFIX.length)) ?? "malformed";
      }
      return executionTokenPrincipal(token, localKeys, now) ?? options.principal;
    },
  });
  const bodies: LocalBodies = {
    objects: objects.objects,
    get: (key) => objects.get(key),
    text: (key) => {
      const found = objects.get(key);
      return found === undefined ? undefined : new TextDecoder().decode(found.body);
    },
    clear: () => objects.clear(),
  };
  return { url: server.url, port: server.port, bodies, deps: server.deps, close: server.close };
};
