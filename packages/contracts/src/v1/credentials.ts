/**
 * An org's provider credentials (P10, D-P10-23).
 *
 * An identity record, above every project like a membership. It holds a
 * ciphertext and the data key that wraps it, never a plaintext: the API
 * encrypts on the way in under a key whose context is the org and the
 * provider, so a ciphertext moved to another org's row does not decrypt. Every
 * read route answers {@link OrgCredentialViewSchema} and nothing more.
 */
import { z } from "zod";
import { OrgIdSchema } from "../ids.js";
import { IsoTimestampSchema, SchemaVersionSchema } from "./common.js";

/** The providers a remote worker can hold a key for (D-P10-03). */
export const ProviderSchema = z.enum(["anthropic", "openai"]);
export type Provider = z.infer<typeof ProviderSchema>;

export const PROVIDERS: readonly Provider[] = ["anthropic", "openai"];

/** The environment variable each provider's CLI reads its key from. */
export const PROVIDER_KEY_ENV: Readonly<Record<Provider, string>> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
};

/**
 * A Claude Code subscription token, as `claude setup-token` mints it, carries
 * this prefix; an API key does not. Claude Code reads the one through
 * `CLAUDE_CODE_OAUTH_TOKEN` and the other through `ANTHROPIC_API_KEY`, so the
 * stored `anthropic` credential may be either and the engine tells them apart.
 */
export const CLAUDE_OAUTH_TOKEN_PREFIX = "sk-ant-oat";
export const CLAUDE_OAUTH_TOKEN_ENV = "CLAUDE_CODE_OAUTH_TOKEN";

/** The environment variable an org's stored credential is handed to a harness as. */
export const providerEnvironmentVariable = (provider: Provider, secret: string): string =>
  provider === "anthropic" && secret.startsWith(CLAUDE_OAUTH_TOKEN_PREFIX)
    ? CLAUDE_OAUTH_TOKEN_ENV
    : PROVIDER_KEY_ENV[provider];

/** Base64 ciphertext and wrapped key, as the envelope produced them. */
const Base64Schema = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9+/]+={0,2}$/, {
    message: "must be base64",
  });

export const OrgCredentialSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  orgId: OrgIdSchema,
  provider: ProviderSchema,
  ciphertext: Base64Schema,
  wrappedKey: Base64Schema,
  /** For a human to recognise which key this is. Never more. */
  lastFour: z.string().length(4),
  setAt: IsoTimestampSchema,
});
export type OrgCredential = z.infer<typeof OrgCredentialSchema>;

/** The only shape a read route returns: presence, date and last four. */
export const OrgCredentialViewSchema = z.strictObject({
  provider: ProviderSchema,
  lastFour: z.string().length(4),
  setAt: IsoTimestampSchema,
});
export type OrgCredentialView = z.infer<typeof OrgCredentialViewSchema>;

export const OrgCredentialsResponseSchema = z.strictObject({
  items: z.array(OrgCredentialViewSchema),
});
export type OrgCredentialsResponse = z.infer<typeof OrgCredentialsResponseSchema>;

/** `PUT /orgs/{orgId}/credentials/{provider}`. The one request that carries a key. */
export const SetOrgCredentialBodySchema = z.strictObject({
  key: z.string().min(8),
});
export type SetOrgCredentialBody = z.infer<typeof SetOrgCredentialBodySchema>;

/** The last four characters of a key, for `lastFour`. */
export const lastFourOf = (key: string): string => key.slice(-4).padStart(4, "*");

/**
 * An org's GitHub App installation (D-P10-02), recorded by `org github install`
 * and read by dispatch to refuse a repository nobody granted.
 */
export const GitHubInstallationSchema = z.strictObject({
  installationId: z.int().positive(),
  /** The GitHub account the App is installed on. */
  account: z.string().min(1),
  /** `owner/name`, as the installation lists them. */
  repositories: z.array(z.string().min(1)),
  recordedAt: IsoTimestampSchema,
});
export type GitHubInstallation = z.infer<typeof GitHubInstallationSchema>;

/** `PUT /orgs/{orgId}/github`. The plane verifies the installation through the App itself. */
export const RecordInstallationBodySchema = z.strictObject({
  installationId: z.int().positive(),
});
export type RecordInstallationBody = z.infer<typeof RecordInstallationBodySchema>;

/** `GET /github/app`: where a customer goes to install the App. */
export const GitHubAppResponseSchema = z.strictObject({
  slug: z.string().min(1),
  installUrl: z.string().min(1),
});
export type GitHubAppResponse = z.infer<typeof GitHubAppResponseSchema>;
