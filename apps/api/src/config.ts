/**
 * Configuration, read once at cold start (T4 deliverable 6).
 *
 * Validated and then injected. A missing variable fails the cold start with a
 * message naming every missing variable, rather than surfacing on the first
 * request that happens to need it.
 */
import { z } from "zod";

/**
 * What **every** function in this app needs.
 *
 * Deliberately only what they share. The API function also mints execution
 * tokens and the authorizer verifies them, but the materializer does neither —
 * and requiring their variables here crashed it at cold start on 2026-09-17,
 * with the stream backing up behind a function that could not even load. A
 * shared config schema must hold the intersection, not the union: anything one
 * function needs and another does not belongs in its own loader below.
 */
const ConfigEnvSchema = z.object({
  NIGHTSHIFT_TABLE_NAME: z.string().min(1),
  NIGHTSHIFT_BUCKET_NAME: z.string().min(1),
  NIGHTSHIFT_STAGE: z.string().min(1),
});

export interface ApiConfig {
  readonly tableName: string;
  readonly bucketName: string;
  readonly stage: string;
}

/** What the API function alone needs, to mint execution tokens (P4, T2). */
const TokenEnvSchema = z.object({
  /** The KMS key that signs execution tokens. */
  NIGHTSHIFT_EXECUTION_TOKEN_KEY_ID: z.string().min(1),
  /**
   * `https://api.<stage>.nightshift.wildorder.dev`, set by the stack from the
   * one hostname rule. Read rather than derived, so `apps/api` does not become a
   * third place that states it.
   */
  NIGHTSHIFT_TOKEN_ISSUER: z.string().min(1),
});

export interface TokenConfig {
  readonly executionTokenKeyId: string;
  readonly tokenIssuer: string;
}

export class ConfigError extends Error {
  constructor(readonly missing: readonly string[]) {
    super(`missing or empty environment variables: ${missing.join(", ")}`);
    this.name = "ConfigError";
  }
}

export const loadConfig = (env: Readonly<Record<string, string | undefined>>): ApiConfig => {
  const result = ConfigEnvSchema.safeParse(env);
  if (!result.success) {
    throw new ConfigError([...new Set(result.error.issues.map((issue) => String(issue.path[0])))]);
  }
  return {
    tableName: result.data.NIGHTSHIFT_TABLE_NAME,
    bucketName: result.data.NIGHTSHIFT_BUCKET_NAME,
    stage: result.data.NIGHTSHIFT_STAGE,
  };
};

export const loadTokenConfig = (env: Readonly<Record<string, string | undefined>>): TokenConfig => {
  const result = TokenEnvSchema.safeParse(env);
  if (!result.success) {
    throw new ConfigError([...new Set(result.error.issues.map((issue) => String(issue.path[0])))]);
  }
  return {
    executionTokenKeyId: result.data.NIGHTSHIFT_EXECUTION_TOKEN_KEY_ID,
    tokenIssuer: result.data.NIGHTSHIFT_TOKEN_ISSUER,
  };
};
