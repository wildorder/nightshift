/**
 * Configuration, read once at cold start (T4 deliverable 6).
 *
 * Validated and then injected. A missing variable fails the cold start with a
 * message naming every missing variable, rather than surfacing on the first
 * request that happens to need it.
 */
import { z } from "zod";

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
