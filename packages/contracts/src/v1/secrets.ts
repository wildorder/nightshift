/**
 * A project's secrets (A-62): named values a project's setup, its checks and
 * its agents need, such as a registry token for `npm ci`.
 *
 * A record of the credentials table, beside `OrgCredential` and under the same
 * envelope: neither an identity record (it names a project) nor a project
 * aggregate, so nothing that reads a project's records can reach one. The API seals a value on the way in under a
 * context naming the org, the project and the secret, so a ciphertext moved to
 * another row does not open. Every read route answers
 * {@link ProjectSecretViewSchema} and nothing more; the plaintext leaves the
 * plane only in a heartbeat answer, to the machine of one of the project's runs.
 *
 * A project declares the names it needs (`secrets` in `nightshift.config.json`);
 * the values are never in the repository.
 */
import { z } from "zod";
import { OrgIdSchema, ProjectIdSchema } from "../ids.js";
import { IsoTimestampSchema, SchemaVersionSchema } from "./common.js";
import { lastFourOf } from "./credentials.js";

/** An environment variable's name, as a step and an agent are given it. */
export const SecretNameSchema = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/, {
    message:
      "must be an environment variable name: letters, digits and _, not starting with a digit",
  })
  .refine((name) => !RESERVED_SECRET_NAMES.has(name.toUpperCase()), {
    message: "names a variable the machine or the shell sets itself",
  })
  .refine((name) => !name.toUpperCase().startsWith("NIGHTSHIFT_"), {
    message: "NIGHTSHIFT_ names are Nightshift's own",
  });

/** What a secret may not be called: what a shell, a machine or a provider's CLI reads already. */
const RESERVED_SECRET_NAMES: ReadonlySet<string> = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "TERM",
  "PWD",
  "TMPDIR",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CODEX_HOME",
]);
export type SecretName = z.infer<typeof SecretNameSchema>;

const Base64Schema = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9+/]+={0,2}$/, { message: "must be base64" });

export const ProjectSecretSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  orgId: OrgIdSchema,
  projectId: ProjectIdSchema,
  name: SecretNameSchema,
  ciphertext: Base64Schema,
  wrappedKey: Base64Schema,
  /** For a human to recognise which value this is. Never more. */
  lastFour: z.string().length(4),
  setAt: IsoTimestampSchema,
});
export type ProjectSecret = z.infer<typeof ProjectSecretSchema>;

/** The only shape a read route returns: the name, its date and last four. */
export const ProjectSecretViewSchema = z.strictObject({
  name: SecretNameSchema,
  lastFour: z.string().length(4),
  setAt: IsoTimestampSchema,
});
export type ProjectSecretView = z.infer<typeof ProjectSecretViewSchema>;

export const ProjectSecretsResponseSchema = z.strictObject({
  items: z.array(ProjectSecretViewSchema),
});
export type ProjectSecretsResponse = z.infer<typeof ProjectSecretsResponseSchema>;

/** `PUT /projects/{projectId}/secrets/{name}`: the one request that carries a secret's value. */
export const SetProjectSecretBodySchema = z.strictObject({
  value: z.string().min(1).max(16_384),
});
export type SetProjectSecretBody = z.infer<typeof SetProjectSecretBodySchema>;

/**
 * The envelope context of a project's secret: bound into the data key's wrap
 * and the cipher's additional data beside the org, as a provider's name is for
 * an org's key.
 */
export const projectSecretPurpose = (projectId: string, name: string): string =>
  `secret:${projectId}:${name}`;

/**
 * The project's declared secrets out of `env`: the names a program lists that
 * `env` holds a value for. What every step and agent is given (A-62), from a
 * developer's shell on a laptop and from the plane, by the runner, on a machine.
 */
export const declaredSecrets = (
  names: readonly string[] | undefined,
  env: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> => {
  const picked: Record<string, string> = {};
  for (const name of names ?? []) {
    const value = env[name];
    if (value !== undefined && value !== "") picked[name] = value;
  }
  return picked;
};

/** Values shorter than this are not redacted: masking them would mask ordinary text. */
export const MIN_REDACTED_SECRET_LENGTH = 4;

/**
 * `text` with every secret's value replaced by its name, `«NPM_TOKEN»`: what
 * Nightshift stores of a step's output, an event or an upload, wherever a
 * value could have been printed (A-62). Longest values first, so one secret
 * inside another is not half-masked.
 */
export const redactSecrets = (text: string, secrets: Readonly<Record<string, string>>): string => {
  const entries = Object.entries(secrets)
    .filter(([, value]) => value.length >= MIN_REDACTED_SECRET_LENGTH)
    .sort((a, b) => b[1].length - a[1].length);
  let out = text;
  for (const [name, value] of entries) {
    if (out.includes(value)) out = out.split(value).join(`«${name}»`);
  }
  return out;
};

export { lastFourOf };
