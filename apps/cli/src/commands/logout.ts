/**
 * `nightshift logout` — delete the credentials file, and say plainly whether the
 * token was also revoked.
 *
 * Deleting the file is the part that is guaranteed: after `logout` this machine
 * cannot mint another token, whatever Cognito thinks. Revocation is the part
 * that is not — the endpoint may be unreachable, or the pool may refuse — and
 * the difference matters, because a refresh token that was deleted but not
 * revoked is still valid for anyone who copied it out of `credentials.json`
 * before now.
 *
 * So the command reports both outcomes separately and honestly. "Signed out"
 * with a quietly failed revocation would be the CLI claiming something it did
 * not do.
 */
import {
  credentialsPath,
  deleteCredentials,
  isTokenProfile,
  readCredentials,
  readProfile,
} from "@nightshift/persistence/http";
import type { CliEnvironment } from "../environment.js";
import { revokeRefreshToken } from "../oauth.js";

export interface LogoutOptions {
  /**
   * Whether to ask Cognito to revoke the token before deleting it.
   *
   * On by default. `--no-revoke` exists for a machine that is offline and wants
   * the local file gone now rather than after a network timeout.
   */
  readonly revoke: boolean;
}

export interface LogoutResult {
  readonly deleted: boolean;
  readonly revoked: boolean;
  readonly detail: string;
}

export const logout = async (
  environment: CliEnvironment,
  options: LogoutOptions,
): Promise<LogoutResult> => {
  const credentials = await readCredentials(environment.paths).catch(() => undefined);
  const profile = await readProfile(environment.paths).catch(() => undefined);

  let revoked = false;
  let detail = "not attempted";

  if (!options.revoke) {
    detail = "not attempted (--no-revoke)";
  } else if (credentials === undefined) {
    detail = "not attempted (there was no stored token)";
  } else if (profile === undefined) {
    detail = "not attempted (no profile, so there is no auth domain to revoke against)";
  } else if (isTokenProfile(profile)) {
    detail = "not attempted (a local instance has no session to revoke)";
  } else {
    try {
      const outcome = await revokeRefreshToken(
        {
          authDomain: profile.authDomain,
          clientId: credentials.clientId,
          refreshToken: credentials.refreshToken,
        },
        environment.fetch,
      );
      revoked = outcome.revoked;
      detail = outcome.detail;
    } catch (cause) {
      // Caught rather than propagated so the local half still happens: the file
      // going away is the guarantee, and it must not depend on Cognito.
      detail = `the revocation attempt failed (${
        cause instanceof Error ? cause.message : String(cause)
      })`;
    }
  }

  // Unconditional, and after the revocation attempt, because the token has to
  // still exist to be revoked.
  const deleted = await deleteCredentials(environment.paths);

  environment.out(
    deleted
      ? `deleted ${credentialsPath(environment.paths)}`
      : `no credentials to delete at ${credentialsPath(environment.paths)}`,
  );
  environment.out(
    revoked
      ? "the refresh token was revoked at Cognito, so it is dead everywhere."
      : `the refresh token was NOT revoked at Cognito (${detail}); it is gone from this machine ` +
          "but remains valid until it expires.",
  );

  return { deleted, revoked, detail };
};
