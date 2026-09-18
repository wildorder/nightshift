/**
 * The KMS half: signing without ever holding the private key (T2, A-35).
 *
 * The private key never leaves KMS, which is the point of using it rather than a
 * secret: no process Nightshift runs can exfiltrate it, and the API function's
 * IAM grants exactly `kms:Sign` on exactly one key. The authorizer holds
 * `kms:GetPublicKey` on the same key and nothing else.
 *
 * This is the only module under `tokens/` that imports the AWS SDK. `mint.ts`
 * and `verify.ts` are pure over an injected signer and an injected key, so the
 * offline suite drives the same code with a local key pair.
 */

import type { KeyObject } from "node:crypto";
import {
  GetPublicKeyCommand,
  type KMSClient,
  SignCommand,
  SigningAlgorithmSpec,
} from "@aws-sdk/client-kms";
import type { Clock } from "@nightshift/core";
import type { ExecutionTokenSigner } from "./mint.js";
import { publicKeyFromSpki } from "./verify.js";

/** RS256, the JOSE name for what KMS calls `RSASSA_PKCS1_V1_5_SHA_256`. */
export const KMS_SIGNING_ALGORITHM = SigningAlgorithmSpec.RSASSA_PKCS1_V1_5_SHA_256;

export interface KmsSignerOptions {
  readonly kms: KMSClient;
  /** The key id, alias or ARN. The stack passes the id. */
  readonly keyId: string;
}

/**
 * `MessageType: "RAW"` so KMS hashes the signing input itself. Sending a digest
 * would mean this code chose the hash, and a mismatch between that choice and
 * the signing algorithm is a failure that only shows up at verification time.
 */
export const createKmsExecutionTokenSigner = ({
  kms,
  keyId,
}: KmsSignerOptions): ExecutionTokenSigner => ({
  async sign(signingInput) {
    const response = await kms.send(
      new SignCommand({
        KeyId: keyId,
        Message: signingInput,
        MessageType: "RAW",
        SigningAlgorithm: KMS_SIGNING_ALGORITHM,
      }),
    );
    if (response.Signature === undefined) {
      throw new Error(`KMS returned no signature for key ${keyId}`);
    }
    return response.Signature;
  },
});

export interface PublicKeySourceOptions extends KmsSignerOptions {
  readonly clock: Clock;
  /** How long a fetched key is reused. Bounded, and asserted in the stack's tests. */
  readonly ttlMs: number;
}

/** Fetches the verifying key, and keeps it for `ttlMs` (T2 deliverable 5's note). */
export type PublicKeySource = () => Promise<KeyObject>;

/**
 * A per-function-instance cache in front of `kms:GetPublicKey`.
 *
 * The public key is not secret and does not change: a KMS asymmetric key's
 * material is fixed for its life, so a stale entry cannot be wrong, only old.
 * The TTL exists so that replacing the key (a deploy plus a wait, see `mint.ts`)
 * is picked up without recycling every warm instance, and so a cache entry has a
 * bounded life the stack can assert on.
 *
 * In-flight requests share one fetch: a cold instance taking several concurrent
 * requests should call KMS once, not once per request.
 */
export const createCachedPublicKey = (options: PublicKeySourceOptions): PublicKeySource => {
  let cached: { readonly key: KeyObject; readonly expiresAt: number } | undefined;
  let inFlight: Promise<KeyObject> | undefined;

  const fetchKey = async (): Promise<KeyObject> => {
    const response = await options.kms.send(new GetPublicKeyCommand({ KeyId: options.keyId }));
    if (response.PublicKey === undefined) {
      throw new Error(`KMS returned no public key for key ${options.keyId}`);
    }
    const key = publicKeyFromSpki(response.PublicKey);
    cached = { key, expiresAt: options.clock.now() + options.ttlMs };
    return key;
  };

  return async () => {
    const current = cached;
    if (current !== undefined && current.expiresAt > options.clock.now()) return current.key;
    if (inFlight !== undefined) return inFlight;
    inFlight = fetchKey().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };
};
