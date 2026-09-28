/**
 * The browser's session (D-P11-04).
 *
 * ## The one absolute rule, restated for a browser
 *
 * The refresh token is the only secret the Studio holds. It lives in
 * `localStorage` under {@link REFRESH_TOKEN_KEY} on the Studio's own origin and
 * **nowhere else**: never in a URL, a query string, a log, React state that a
 * devtools snapshot would show, or an error message. The ID token is held in
 * memory and re-minted from the refresh token as the CLI's provider does
 * (`session/tokens.ts`), with the same margin. Sign-out revokes the refresh
 * token at Cognito, best effort, and clears storage whatever Cognito answered.
 *
 * ## Sign-in, in a tab
 *
 * `beginSignIn` makes a verifier and a state, keeps both in `sessionStorage`
 * (this tab's, gone when it closes) and sends the browser to the hosted UI.
 * `completeSignIn` runs on `/callback`: it checks the state against what this
 * tab sent, redeems the code with the verifier, stores the refresh token and
 * forgets the verifier. A callback that arrives in a tab that started no
 * sign-in has no verifier to redeem with, and is refused.
 */
import type { TokenProvider } from "@nightshift/persistence/http/browser";
import { tokenClaims, tokenExpiry } from "@nightshift/persistence/http/browser";
import type { StudioConfig } from "../config.js";
import {
  authorizeUrl,
  exchangeAuthorizationCode,
  type OAuthFetch,
  refreshIdToken,
  revokeRefreshToken,
} from "./oauth.js";
import { assertState, createPkce, createState, type Digest, type Randomness } from "./pkce.js";

export const REFRESH_TOKEN_KEY = "nightshift.studio.refreshToken";
const PENDING_KEY = "nightshift.studio.pendingSignIn";
export const CALLBACK_PATH = "/callback";
/** The same headroom the CLI's provider keeps. */
export const TOKEN_REFRESH_MARGIN_MS = 60_000;

/** The slice of `Storage` the session uses; `localStorage` and `sessionStorage` both fit. */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface SessionEnvironment {
  readonly config: StudioConfig;
  /** Where the refresh token lives: `localStorage`. */
  readonly durable: KeyValueStorage;
  /** Where a sign-in in progress lives: `sessionStorage`. */
  readonly tab: KeyValueStorage;
  readonly fetch: OAuthFetch;
  readonly random: Randomness;
  readonly digest: Digest;
  /** This origin, for the redirect URI: `window.location.origin`. */
  readonly origin: string;
  /** Sends the browser somewhere: `window.location.assign`. */
  readonly navigate: (url: string) => void;
  readonly now: () => number;
}

/** What the page knows about who is signed in. Never a token. */
export interface Identity {
  readonly subject: string | undefined;
  readonly email: string | undefined;
  /** `custom:active_org`, when the user set one. */
  readonly activeOrgClaim: string | undefined;
}

export const ACTIVE_ORG_CLAIM = "custom:active_org";

const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

export const identityOf = (idToken: string): Identity => {
  const claims = tokenClaims(idToken);
  return {
    subject: asString(claims.sub),
    email: asString(claims.email),
    activeOrgClaim: asString(claims[ACTIVE_ORG_CLAIM]),
  };
};

export class NotSignedInError extends Error {
  override readonly name = "NotSignedInError";
}

export const redirectUriFor = (origin: string): string => `${origin}${CALLBACK_PATH}`;

export const hasSession = (env: Pick<SessionEnvironment, "durable">): boolean =>
  env.durable.getItem(REFRESH_TOKEN_KEY) !== null;

/** Starts a sign-in: remembers the verifier and state in this tab, leaves for the hosted UI. */
export const beginSignIn = async (env: SessionEnvironment): Promise<void> => {
  const pkce = await createPkce(env.random, env.digest);
  const state = createState(env.random);
  env.tab.setItem(PENDING_KEY, JSON.stringify({ verifier: pkce.verifier, state }));
  env.navigate(
    authorizeUrl({
      authDomain: env.config.authDomain,
      clientId: env.config.clientId,
      redirectUri: redirectUriFor(env.origin),
      state,
      codeChallenge: pkce.challenge,
      codeChallengeMethod: pkce.method,
    }),
  );
};

/**
 * Finishes a sign-in from the callback's query. Returns the identity; the
 * refresh token goes into durable storage and is not returned.
 */
export const completeSignIn = async (
  env: SessionEnvironment,
  query: URLSearchParams,
): Promise<Identity> => {
  const pendingRaw = env.tab.getItem(PENDING_KEY);
  if (pendingRaw === null) {
    throw new NotSignedInError("this tab started no sign-in, so the callback cannot be redeemed");
  }
  const pending = JSON.parse(pendingRaw) as { verifier: string; state: string };
  assertState(pending.state, query.get("state"));
  const code = query.get("code");
  if (code === null) throw new NotSignedInError("the callback carried no authorization code");
  const tokens = await exchangeAuthorizationCode(
    {
      authDomain: env.config.authDomain,
      clientId: env.config.clientId,
      redirectUri: redirectUriFor(env.origin),
      code,
      codeVerifier: pending.verifier,
    },
    env.fetch,
  );
  env.durable.setItem(REFRESH_TOKEN_KEY, tokens.refreshToken);
  env.tab.removeItem(PENDING_KEY);
  return identityOf(tokens.idToken);
};

/**
 * A provider that mints an ID token from the stored refresh token and caches it
 * until shortly before expiry; concurrent callers share one refresh.
 */
export const createBrowserTokenProvider = (
  env: SessionEnvironment,
): TokenProvider & { readonly identity: () => Promise<Identity> } => {
  let cached: { token: string; expiresAtMs: number } | undefined;
  let inFlight: Promise<string> | undefined;

  const mint = async (): Promise<string> => {
    const refreshToken = env.durable.getItem(REFRESH_TOKEN_KEY);
    if (refreshToken === null) throw new NotSignedInError("not signed in");
    const token = await refreshIdToken(
      { authDomain: env.config.authDomain, clientId: env.config.clientId, refreshToken },
      env.fetch,
    );
    cached = { token, expiresAtMs: tokenExpiry(token) ?? env.now() + TOKEN_REFRESH_MARGIN_MS };
    return token;
  };

  const idToken = async (): Promise<string> => {
    if (cached !== undefined && cached.expiresAtMs - TOKEN_REFRESH_MARGIN_MS > env.now()) {
      return cached.token;
    }
    inFlight ??= mint().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };

  return { idToken, identity: async () => identityOf(await idToken()) };
};

/** Revokes the refresh token, best effort, and clears the browser either way. */
export const signOut = async (
  env: SessionEnvironment,
): Promise<{ readonly revoked: boolean; readonly detail: string }> => {
  const refreshToken = env.durable.getItem(REFRESH_TOKEN_KEY);
  env.durable.removeItem(REFRESH_TOKEN_KEY);
  env.tab.removeItem(PENDING_KEY);
  if (refreshToken === null) return { revoked: false, detail: "there was no stored token" };
  return revokeRefreshToken(
    { authDomain: env.config.authDomain, clientId: env.config.clientId, refreshToken },
    env.fetch,
  );
};
