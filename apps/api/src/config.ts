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
  /**
   * P10 (D-P10-23): the credentials table and the key it is sealed under.
   * Optional until the data stack deploys them (T2); without them the API
   * refuses to store a credential rather than storing one anywhere else.
   */
  NIGHTSHIFT_CREDENTIALS_TABLE_NAME: z.string().min(1).optional(),
  NIGHTSHIFT_CREDENTIALS_KEY_ID: z.string().min(1).optional(),
  /** P10 (D-P10-16): the AMI the runner stack built, recorded on every dispatch. */
  NIGHTSHIFT_RUNNER_AMI_VERSION: z.string().min(1).optional(),
});

export interface ApiConfig {
  readonly tableName: string;
  readonly bucketName: string;
  readonly stage: string;
  readonly credentialsTableName?: string;
  readonly credentialsKeyId?: string;
  readonly runnerAmiVersion?: string;
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
  const data = result.data;
  return {
    tableName: data.NIGHTSHIFT_TABLE_NAME,
    bucketName: data.NIGHTSHIFT_BUCKET_NAME,
    stage: data.NIGHTSHIFT_STAGE,
    ...(data.NIGHTSHIFT_CREDENTIALS_TABLE_NAME === undefined
      ? {}
      : { credentialsTableName: data.NIGHTSHIFT_CREDENTIALS_TABLE_NAME }),
    ...(data.NIGHTSHIFT_CREDENTIALS_KEY_ID === undefined
      ? {}
      : { credentialsKeyId: data.NIGHTSHIFT_CREDENTIALS_KEY_ID }),
    ...(data.NIGHTSHIFT_RUNNER_AMI_VERSION === undefined
      ? {}
      : { runnerAmiVersion: data.NIGHTSHIFT_RUNNER_AMI_VERSION }),
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
