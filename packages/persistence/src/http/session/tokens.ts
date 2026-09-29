/**
 * Minting an ID token from the operator's refresh token.
 *
 * ## Why the ID token and not the access token
 *
 * Both are valid at the gateway: the authorizer's audience lists the interactive
 * client, which an ID token's `aud` names and an access token's `client_id`
 * names. But the control plane resolves the acting organisation from
 * `custom:active_org`, and on the pool's Lite feature plan **`custom:` claims
 * appear only in ID tokens** (`apps/api/src/auth/acting-org.ts` says so, and
 * that is where the rule lives). An access token would authenticate and then
 * fail to resolve an org for a caller who belongs to more than one.
 *
 * ## The refresh grant
 *
 * The interactive client is public — no secret — so the refresh exchange sends
 * `client_id` in the form body and no `Authorization` header. Cognito returns a
 * new ID and access token and, on this grant, no new refresh token; the stored
 * one keeps working until it expires or is revoked, which is why nothing here
 * rewrites the credentials file.
 */

import { readFile } from "node:fs/promises";
import type { Clock } from "@nightshift/core";
import { systemClock } from "@nightshift/core";
import { tokenExpiry } from "../claims.js";
import type { TokenProvider } from "../transport.js";
import type { PathEnvironment } from "./paths.js";
import {
  type CognitoProfile,
  isTokenProfile,
  NotLoggedInError,
  type Profile,
  requireCredentials,
  requireProfile,
} from "./store.js";

/** The slice of `fetch` the token exchange uses. Injected so a test opens no socket. */
export type TokenFetch = (
  url: string,
  init: {
    readonly method: "POST";
    readonly headers: Record<string, string>;
    readonly body: string;
  },
) => Promise<{ readonly status: number; text(): Promise<string> }>;

/**
 * How long before expiry a cached token is considered spent.
 *
 * Cognito ID tokens last an hour. Sixty seconds of headroom covers a request that
 * starts just before expiry and arrives just after, plus ordinary clock skew
 * between a laptop and AWS, without minting a token per call.
 */
export const TOKEN_REFRESH_MARGIN_MS = 60_000;

export interface TokenProviderOptions {
  readonly profile?: Profile;
  readonly refreshToken?: string;
  readonly fetch?: TokenFetch;
  readonly clock?: Clock;
  readonly paths?: PathEnvironment;
}

// The claim readers live in `../claims.ts`, shared with the browser entry, and are
// re-exported here so every existing importer keeps its path.
export { tokenClaims, tokenExpiry } from "../claims.js";

export const tokenEndpointFor = (profile: CognitoProfile): string =>
  `https://${profile.authDomain}/oauth2/token`;

/**
 * Exchanges a refresh token for an ID token. One request, no caching.
 *
 * Exported so `nightshift login` can prove the credentials it just stored work
 * before telling the operator they are signed in.
 */
export const refreshIdToken = async (
  profile: CognitoProfile,
  refreshToken: string,
  doFetch: TokenFetch = globalThis.fetch as unknown as TokenFetch,
): Promise<string> => {
  const response = await doFetch(tokenEndpointFor(profile), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    // A public client: `client_id` in the body, no Basic authorization header.
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: profile.clientId,
      refresh_token: refreshToken,
    }).toString(),
  });
  const text = await response.text();
  if (response.status !== 200) {
    // The refresh token is expired, revoked, or belongs to another client. The
    // body is echoed because Cognito names which; it never contains the token.
    throw new NotLoggedInError(
      `the token endpoint refused the refresh (${response.status}): ${text.slice(0, 300)}`,
    );
  }
  const idToken = (JSON.parse(text) as { id_token?: unknown }).id_token;
  if (typeof idToken !== "string") {
    throw new NotLoggedInError("the token endpoint returned no id_token");
  }
  return idToken;
};

/**
 * A provider that mints an ID token and caches it until shortly before expiry.
 *
 * Reads the profile and credentials from disk on first use unless both are
 * supplied. Concurrent callers share one in-flight refresh rather than each
 * starting their own: a job that emits a burst of events on a cold cache would
 * otherwise mint a token per event.
 */
export const createTokenProvider = (options: TokenProviderOptions = {}): TokenProvider => {
  const clock = options.clock ?? systemClock;
  const doFetch = options.fetch ?? (globalThis.fetch as unknown as TokenFetch);
  let cached: { token: string; expiresAtMs: number } | undefined;
  let inFlight: Promise<string> | undefined;

  const mint = async (): Promise<string> => {
    const profile = options.profile ?? (await requireProfile(options.paths ?? {}));
    if (isTokenProfile(profile)) return readLocalToken(profile.tokenFile);
    const refreshToken =
      options.refreshToken ?? (await requireCredentials(options.paths ?? {})).refreshToken;
    const token = await refreshIdToken(profile, refreshToken, doFetch);
    // A token with no readable `exp` is treated as good for one refresh margin,
    // so a malformed one is retried soon rather than cached forever.
    const expiresAtMs = tokenExpiry(token) ?? clock.now() + TOKEN_REFRESH_MARGIN_MS;
    cached = { token, expiresAtMs };
    return token;
  };

  return {
    idToken: async () => {
      // A local instance's bearer is read from its file every time: cheap, and a
      // rotated secret is picked up without restarting anything.
      const known = options.profile;
      if (known !== undefined && isTokenProfile(known)) return readLocalToken(known.tokenFile);
      if (cached !== undefined && cached.expiresAtMs - TOKEN_REFRESH_MARGIN_MS > clock.now()) {
        return cached.token;
      }
      inFlight ??= mint().finally(() => {
        inFlight = undefined;
      });
      return inFlight;
    },
  };
};

/** A local instance's operator token (D-P12-03), from the file its plane wrote. */
export const readLocalToken = async (path: string): Promise<string> => {
  try {
    const token = (await readFile(path, "utf8")).trim();
    if (token !== "") return token;
  } catch {
    // Fall through to the one message that says what to do.
  }
  throw new NotLoggedInError(
    `the local instance's token is not at ${path}. Start it with \`nightshift local\``,
  );
};

/**
 * A provider over a token somebody else obtained.
 *
 * For a script that already holds one: the deployed slice suite, which uses the
 * machine client's credentials grant rather than an operator's session.
 */
export const staticTokenProvider = (token: string): TokenProvider => ({
  idToken: async () => token,
});
