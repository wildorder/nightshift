/**
 * The Nightshift authorizer (T3 deliverable 1; D-P4-04, A-36, amending A-19).
 *
 * One function in front of every route. It reads the bearer token, decides which
 * of the two kinds it is from its `iss`, verifies it, and hands the handler a
 * typed principal. Anything else denies.
 *
 * ## Why this replaced the built-in JWT authorizer
 *
 * API Gateway's `HttpJwtAuthorizer` accepts exactly one OIDC issuer. P4 has two
 * token kinds, and the alternative to a small function was making Nightshift an
 * OIDC provider with a public JWKS endpoint — a larger public surface, and a new
 * thing to operate, to avoid writing the sixty lines below. The gateway still
 * rejects a bad token before the handler runs, and the handler still contains no
 * verification code; what changed is whose code verifies.
 *
 * ## What is cached, and why that is safe
 *
 * Both key sources are cached per function instance, because both are public,
 * immutable facts: a Cognito signing key is published under a `kid` that never
 * refers to different material, and a KMS asymmetric key's material is fixed for
 * its life. A cache miss on an unknown `kid` refetches once, which is how a pool
 * key rotation is picked up without a deploy.
 *
 * Nothing here logs a token, and no refusal reason carries one.
 */
import { createPublicKey, type KeyObject, verify as verifySignature } from "node:crypto";
import type {
  APIGatewayRequestAuthorizerEventV2,
  APIGatewaySimpleAuthorizerWithContextResult,
} from "aws-lambda";
import { userTokenFrom } from "../auth/acting-org.js";
import type { RequestPrincipal } from "../auth/principal.js";
import { splitToken } from "../tokens/jwt.js";
import { createCachedPublicKey, type PublicKeySource } from "../tokens/kms.js";
import { verifyExecutionToken } from "../tokens/verify.js";

/**
 * How long a fetched key is reused, and the bound the stack asserts on.
 *
 * Ten minutes: long enough that a warm instance under load fetches once, short
 * enough that a rotated pool key or a replaced signing key is picked up within
 * one coffee rather than one deploy.
 */
export const KEY_CACHE_TTL_MS = 10 * 60 * 1000;

/** The context the handler reads the principal out of. Values must be strings. */
export interface AuthorizerContext extends Record<string, string> {
  /** The principal, as JSON. API Gateway's authorizer context carries strings only. */
  readonly principal: string;
}

export type AuthorizerResult = APIGatewaySimpleAuthorizerWithContextResult<AuthorizerContext>;

const DENY: APIGatewaySimpleAuthorizerWithContextResult<Record<string, string>> = {
  isAuthorized: false,
  context: {},
};

const allow = (principal: RequestPrincipal): AuthorizerResult => ({
  isAuthorized: true,
  context: { principal: JSON.stringify(principal) },
});

/** `Authorization: Bearer <token>`, case-insensitively, or `undefined`. */
export const bearerTokenFrom = (
  headers: Readonly<Record<string, string | undefined>> | undefined,
): string | undefined => {
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (name.toLowerCase() !== "authorization" || value === undefined) continue;
    const match = /^bearer\s+(\S+)$/i.exec(value.trim());
    return match?.[1];
  }
  return undefined;
};

/** One JSON Web Key, as a pool's JWKS lists them. Only RSA keys appear there. */
interface Jwk {
  readonly kid?: string;
  readonly kty?: string;
  readonly alg?: string;
  readonly n?: string;
  readonly e?: string;
}

export type JwksFetch = (url: string) => Promise<{ readonly keys: readonly Jwk[] }>;

const defaultJwksFetch: JwksFetch = async (url) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`JWKS endpoint answered ${response.status}`);
  return (await response.json()) as { keys: readonly Jwk[] };
};

/**
 * A `KeyObject` from a JWK, through Node's own JWK import.
 *
 * `alg` is deliberately not taken from the key: RS256 is asserted by the caller,
 * so a JWKS that advertised something weaker could not talk this code into
 * using it.
 */
const keyFromJwk = (jwk: Jwk): KeyObject | undefined => {
  if (jwk.kty !== "RSA" || jwk.n === undefined || jwk.e === undefined) return undefined;
  try {
    return createPublicKey({ key: { kty: "RSA", n: jwk.n, e: jwk.e }, format: "jwk" });
  } catch {
    return undefined;
  }
};

export interface CognitoVerifierOptions {
  /** `https://cognito-idp.<region>.amazonaws.com/<poolId>`. */
  readonly issuer: string;
  /** Both app client ids: an ID token's `aud`, an access token's `client_id`. */
  readonly audiences: readonly string[];
  readonly now: () => number;
  readonly ttlMs?: number;
  readonly fetchJwks?: JwksFetch;
}

export interface CognitoVerifier {
  verify(token: string): Promise<RequestPrincipal | undefined>;
}

/**
 * Verifies a Cognito token against the pool's JWKS, keyed by `kid`.
 *
 * The same order as the execution-token verifier: shape, header, **signature**,
 * then claims. A token whose `aud` or `client_id` is not one of ours is refused
 * after the signature, so a valid token from another app client in the same pool
 * cannot reach the handler.
 */
export const createCognitoVerifier = (options: CognitoVerifierOptions): CognitoVerifier => {
  const ttlMs = options.ttlMs ?? KEY_CACHE_TTL_MS;
  const fetchJwks = options.fetchJwks ?? defaultJwksFetch;
  let keys: Map<string, KeyObject> | undefined;
  let expiresAt = 0;

  const keyFor = async (kid: string): Promise<KeyObject | undefined> => {
    if (keys !== undefined && expiresAt > options.now()) {
      const cached = keys.get(kid);
      if (cached !== undefined) return cached;
    }
    // An unknown `kid` is the signal to refetch: that is what a pool key
    // rotation looks like from here.
    const jwks = await fetchJwks(`${options.issuer}/.well-known/jwks.json`);
    const fresh = new Map<string, KeyObject>();
    for (const jwk of jwks.keys) {
      const key = jwk.kid === undefined ? undefined : keyFromJwk(jwk);
      if (key !== undefined && jwk.kid !== undefined) fresh.set(jwk.kid, key);
    }
    keys = fresh;
    expiresAt = options.now() + ttlMs;
    return fresh.get(kid);
  };

  /** The header, if it is one this code will act on: RS256 with a `kid`. */
  const signingKid = (header: unknown): string | undefined => {
    if (header === null || typeof header !== "object") return undefined;
    const { alg, kid } = header as { alg?: unknown; kid?: unknown };
    return alg === "RS256" && typeof kid === "string" ? kid : undefined;
  };

  /**
   * Whether the registered claims are ours and current.
   *
   * An ID token carries `aud`; a client-credentials access token carries
   * `client_id` and no `aud` at all. Either must name a client we issued, so a
   * valid token from another app client in the same pool cannot reach the
   * handler.
   */
  const isOurs = (claims: Record<string, unknown>): boolean => {
    if (claims.iss !== options.issuer) return false;
    if (claims.token_use !== "id" && claims.token_use !== "access") return false;
    if (typeof claims.exp !== "number" || claims.exp * 1000 <= options.now()) return false;
    const audience = typeof claims.aud === "string" ? claims.aud : claims.client_id;
    return typeof audience === "string" && options.audiences.includes(audience);
  };

  /** The user token a verified payload names, once its registered claims pass. */
  const principalFromClaims = (payload: unknown): RequestPrincipal | undefined => {
    if (payload === null || typeof payload !== "object") return undefined;
    const claims = payload as Record<string, unknown>;
    if (!isOurs(claims)) return undefined;
    const resolved = userTokenFrom(claims);
    return resolved.ok ? resolved.token : undefined;
  };

  return {
    async verify(token) {
      const parts = splitToken(token);
      if (parts === undefined) return undefined;

      const kid = signingKid(parts.header);
      if (kid === undefined) return undefined;

      const key = await keyFor(kid);
      if (key === undefined) return undefined;

      // The signature first. Everything after this line reads a claim, and a
      // claim is only worth reading once its bytes are known to be the pool's.
      let valid: boolean;
      try {
        valid = verifySignature("sha256", parts.signingInput, key, parts.signature);
      } catch {
        return undefined;
      }
      return valid ? principalFromClaims(parts.payload) : undefined;
    },
  };
};

export interface AuthorizerOptions {
  readonly cognito: CognitoVerifier;
  /** The issuer this stage's execution tokens carry. */
  readonly executionIssuer: string;
  readonly executionKey: PublicKeySource;
  readonly now: () => number;
}

/**
 * The authorizer, as a function of its verifiers.
 *
 * The routing rule is the `iss` claim, read **before** verification purely to
 * choose which verifier to ask — never to decide anything. Each verifier then
 * checks the issuer itself against what it demands, so a token that lies about
 * its issuer is refused by whichever one it is handed to, and a token routed to
 * the wrong verifier is refused rather than mistaken for the other kind.
 *
 * Deliberately not routed on the header: both kinds are RS256 JWTs, so a header
 * cannot tell them apart, and an earlier draft that tried sent every Cognito
 * token to the execution verifier.
 */
export const createAuthorizer =
  (options: AuthorizerOptions) =>
  async (event: APIGatewayRequestAuthorizerEventV2): Promise<AuthorizerResult> => {
    const token = bearerTokenFrom(event.headers);
    if (token === undefined) return DENY as AuthorizerResult;

    const parts = splitToken(token);
    if (parts === undefined) return DENY as AuthorizerResult;
    const issuer = (parts.payload as { iss?: unknown } | null)?.iss;

    if (issuer === options.executionIssuer) {
      const key = await options.executionKey();
      const verified = verifyExecutionToken(token, {
        publicKey: key,
        issuer: options.executionIssuer,
        now: options.now(),
      });
      return verified.ok ? allow(verified.principal) : (DENY as AuthorizerResult);
    }

    const principal = await options.cognito.verify(token);
    return principal === undefined ? (DENY as AuthorizerResult) : allow(principal);
  };

export interface AuthorizerRuntimeOptions {
  readonly cognitoIssuer: string;
  readonly audiences: readonly string[];
  readonly executionIssuer: string;
  readonly executionKey: PublicKeySource;
}

/** Wires the two verifiers with the shared TTL. The Lambda entry point calls this. */
export const createAuthorizerRuntime = (options: AuthorizerRuntimeOptions) =>
  createAuthorizer({
    cognito: createCognitoVerifier({
      issuer: options.cognitoIssuer,
      audiences: options.audiences,
      now: () => Date.now(),
      ttlMs: KEY_CACHE_TTL_MS,
    }),
    executionIssuer: options.executionIssuer,
    executionKey: options.executionKey,
    now: () => Date.now(),
  });

export { createCachedPublicKey };
