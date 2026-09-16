/**
 * The two files the local session keeps, and the rules about them.
 *
 * `profile.json` is where the control plane is. `credentials.json` is the
 * operator's refresh token. The second is the only secret Nightshift holds on a
 * developer's machine, and the rules about it are short and absolute:
 *
 * - It lives in the config directory and nowhere else (contract §10).
 * - It is written `0600` where the platform has POSIX permissions.
 * - It is **never printed**, never logged, never put in an error message and
 *   never passed to a child process. Nothing in this module returns it as part
 *   of a describable value; a caller asks for a token, not for the token that
 *   mints it.
 */
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { credentialsPath, type PathEnvironment, profilePath } from "./paths.js";

/**
 * Where this machine's control plane is, written by `nightshift login` and read
 * by everything else. Nothing here is secret.
 */
export const ProfileSchema = z.strictObject({
  /** Origin of the HTTP API, no trailing slash. */
  apiEndpoint: z.string().min(1),
  /** The Cognito hosted domain, without a scheme. */
  authDomain: z.string().min(1),
  /** The interactive app client. Public: it has no secret (PKCE). */
  clientId: z.string().min(1),
  stage: z.string().min(1),
});
export type Profile = z.infer<typeof ProfileSchema>;

/**
 * The operator's session.
 *
 * The refresh token, and the subject it belongs to so `whoami` can answer
 * without a network call. Never the password; there is none to hold.
 */
export const CredentialsSchema = z.strictObject({
  refreshToken: z.string().min(1),
  subject: z.string().min(1),
  /** Which profile these belong to, so a re-login elsewhere is detectable. */
  clientId: z.string().min(1),
  obtainedAt: z.iso.datetime({ offset: true }),
});
export type Credentials = z.infer<typeof CredentialsSchema>;

/** Raised when there is no usable session. Typed, because the CLI prints advice for it. */
export class NotLoggedInError extends Error {
  override readonly name = "NotLoggedInError";
  readonly code = "not_logged_in" as const;

  constructor(reason: string) {
    super(`not signed in: ${reason}. Run \`nightshift login\`.`);
  }
}

const readJson = async (path: string): Promise<unknown | undefined> => {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return JSON.parse(text) as unknown;
};

/** Writes a file readable only by its owner, creating the directory if needed. */
const writeOwnerOnly = async (path: string, value: unknown): Promise<void> => {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  // `mode` on `writeFile` applies only when the file is created, so an existing
  // file keeps whatever permissions it had. `chmod` after the write is what makes
  // the guarantee hold on a rewrite too.
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  if (process.platform !== "win32") await chmod(path, 0o600);
};

export const readProfile = async (
  environment: PathEnvironment = {},
): Promise<Profile | undefined> => {
  const raw = await readJson(profilePath(environment));
  return raw === undefined ? undefined : ProfileSchema.parse(raw);
};

export const requireProfile = async (environment: PathEnvironment = {}): Promise<Profile> => {
  const profile = await readProfile(environment);
  if (profile === undefined) {
    throw new NotLoggedInError(`no profile at ${profilePath(environment)}`);
  }
  return profile;
};

export const writeProfile = async (
  profile: Profile,
  environment: PathEnvironment = {},
): Promise<void> => {
  // The profile is not secret, but it sits in the same directory as the
  // credentials, so it inherits the same treatment rather than inviting a
  // second, laxer path.
  await writeOwnerOnly(profilePath(environment), ProfileSchema.parse(profile));
};

export const readCredentials = async (
  environment: PathEnvironment = {},
): Promise<Credentials | undefined> => {
  const raw = await readJson(credentialsPath(environment));
  return raw === undefined ? undefined : CredentialsSchema.parse(raw);
};

export const requireCredentials = async (
  environment: PathEnvironment = {},
): Promise<Credentials> => {
  const credentials = await readCredentials(environment);
  if (credentials === undefined) {
    throw new NotLoggedInError(`no credentials at ${credentialsPath(environment)}`);
  }
  return credentials;
};

export const writeCredentials = async (
  credentials: Credentials,
  environment: PathEnvironment = {},
): Promise<void> => {
  await writeOwnerOnly(credentialsPath(environment), CredentialsSchema.parse(credentials));
};

/** Removes the credentials file. Idempotent: signing out twice is not an error. */
export const deleteCredentials = async (environment: PathEnvironment = {}): Promise<boolean> => {
  const path = credentialsPath(environment);
  const existed = (await readJson(path).catch(() => undefined)) !== undefined;
  await rm(path, { force: true });
  return existed;
};
