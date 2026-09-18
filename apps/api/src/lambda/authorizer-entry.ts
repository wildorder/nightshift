/**
 * Lambda entry point for the Nightshift authorizer (T3, D-P4-04).
 *
 * Its whole world is two public keys: the pool's JWKS, fetched over HTTPS, and
 * the execution key's public half, fetched with `kms:GetPublicKey`. It holds no
 * table, no bucket and no private key, which is why its IAM is one KMS action
 * and nothing else.
 *
 * Configuration is read at cold start, so a missing variable fails loudly on the
 * first request rather than denying every request for an unstated reason.
 */
import { KMSClient } from "@aws-sdk/client-kms";
import { systemClock } from "@nightshift/core";
import { z } from "zod";
import { createCachedPublicKey } from "../tokens/kms.js";
import { createAuthorizerRuntime, KEY_CACHE_TTL_MS } from "./authorizer.js";

const EnvSchema = z.object({
  NIGHTSHIFT_COGNITO_ISSUER: z.string().min(1),
  /** Both app client ids, comma separated: the interactive one and the machine one. */
  NIGHTSHIFT_COGNITO_AUDIENCES: z.string().min(1),
  NIGHTSHIFT_TOKEN_ISSUER: z.string().min(1),
  NIGHTSHIFT_EXECUTION_TOKEN_KEY_ID: z.string().min(1),
});

const env = EnvSchema.parse(process.env);

export const handler = createAuthorizerRuntime({
  cognitoIssuer: env.NIGHTSHIFT_COGNITO_ISSUER,
  audiences: env.NIGHTSHIFT_COGNITO_AUDIENCES.split(",")
    .map((value) => value.trim())
    .filter((value) => value !== ""),
  executionIssuer: env.NIGHTSHIFT_TOKEN_ISSUER,
  executionKey: createCachedPublicKey({
    kms: new KMSClient({}),
    keyId: env.NIGHTSHIFT_EXECUTION_TOKEN_KEY_ID,
    clock: systemClock,
    ttlMs: KEY_CACHE_TTL_MS,
  }),
});
