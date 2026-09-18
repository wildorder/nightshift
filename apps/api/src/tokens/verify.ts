/**
 * Verifying an execution token (T2 deliverable 5).
 *
 * Pure over an injected public key and an injected clock: no KMS client, no
 * network, no `Date.now()`. That is what lets the offline tests cover a wrong
 * key, an expired token, a tampered claim and another stage's issuer with
 * nothing deployed, and it is why the authorizer can cache the key however it
 * likes without this module knowing.
 *
 * The order matters and is deliberate: shape, then header, then **signature**,
 * then claims. Nothing decides anything from an unverified claim — the issuer is
 * compared after the signature, so a token that names the right issuer and was
 * signed by something else is refused as a bad signature rather than reaching
 * any claim logic at all.
 */
import { createPublicKey, type KeyObject, verify as verifySignature } from "node:crypto";
import type { ExecutionPrincipal, ExecutionTokenClaims } from "@nightshift/contracts";
import { EXECUTION_TOKEN_AUDIENCE, ExecutionTokenClaimsSchema } from "@nightshift/contracts";
import { hasExecutionTokenHeader, splitToken } from "./jwt.js";

export type ExecutionTokenRefusal =
  /** Not three base64url segments of JSON. */
  | "malformed"
  /** The header is not RS256/JWT. Refused before a key is touched. */
  | "wrong_algorithm"
  /** The signature does not verify under the Nightshift key. */
  | "bad_signature"
  /** Signed by the right key, but issued for another stage's API. */
  | "wrong_issuer"
  | "wrong_audience"
  | "expired"
  /** `iat` is in the future beyond the allowed skew. */
  | "not_yet_valid"
  /** Verified and well formed, but the claims are not an execution principal. */
  | "bad_claims";

export type ExecutionTokenVerification =
  | {
      readonly ok: true;
      readonly principal: ExecutionPrincipal;
      readonly claims: ExecutionTokenClaims;
    }
  | { readonly ok: false; readonly reason: ExecutionTokenRefusal };

export interface VerifyExecutionTokenOptions {
  /** The Nightshift public key, as KMS's `GetPublicKey` returns it (SPKI DER) or a `KeyObject`. */
  readonly publicKey: KeyObject;
  /** The issuer this stage's API accepts, and no other. */
  readonly issuer: string;
  /** Milliseconds since the epoch. */
  readonly now: number;
  /** Tolerance for clock drift between the signer and the verifier. */
  readonly clockSkewSeconds?: number;
}

/**
 * Sixty seconds, the usual allowance. It applies to `exp` and to `iat`; it is
 * not a grace period a caller can lean on, and eight hours of token life makes
 * a minute either way irrelevant to anything but a badly set clock.
 */
export const DEFAULT_CLOCK_SKEW_SECONDS = 60;

const refused = (reason: ExecutionTokenRefusal): ExecutionTokenVerification => ({
  ok: false,
  reason,
});

/** A `KeyObject` from the SPKI DER bytes `kms:GetPublicKey` answers with. */
export const publicKeyFromSpki = (der: Uint8Array): KeyObject =>
  createPublicKey({ key: Buffer.from(der), format: "der", type: "spki" });

export const verifyExecutionToken = (
  token: string,
  options: VerifyExecutionTokenOptions,
): ExecutionTokenVerification => {
  const parts = splitToken(token);
  if (parts === undefined) return refused("malformed");
  if (!hasExecutionTokenHeader(parts.header)) return refused("wrong_algorithm");

  // The signature first. Everything below this line is reading a claim, and a
  // claim is only worth reading once the bytes it sits in are known to be ours.
  let signatureIsValid: boolean;
  try {
    signatureIsValid = verifySignature(
      "sha256",
      parts.signingInput,
      options.publicKey,
      parts.signature,
    );
  } catch {
    // A malformed signature can make OpenSSL throw rather than answer false.
    return refused("bad_signature");
  }
  if (!signatureIsValid) return refused("bad_signature");

  const parsed = ExecutionTokenClaimsSchema.safeParse(parts.payload);
  if (!parsed.success) return refused("bad_claims");
  const claims = parsed.data;

  if (claims.iss !== options.issuer) return refused("wrong_issuer");
  if (claims.aud !== EXECUTION_TOKEN_AUDIENCE) return refused("wrong_audience");
  // The chain in `nightshift` is the token's whole point; a token whose `sub`
  // names one agent and whose principal names another is not a token this code
  // could have produced.
  if (claims.sub !== claims.nightshift.agentId) return refused("bad_claims");

  const skew = options.clockSkewSeconds ?? DEFAULT_CLOCK_SKEW_SECONDS;
  const nowSeconds = Math.floor(options.now / 1000);
  if (claims.exp + skew <= nowSeconds) return refused("expired");
  if (claims.iat - skew > nowSeconds) return refused("not_yet_valid");

  return { ok: true, principal: claims.nightshift, claims };
};
