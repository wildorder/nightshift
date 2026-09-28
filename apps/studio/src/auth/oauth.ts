/**
 * The hosted-UI half of a Cognito session, for a browser (D-P11-04).
 *
 * The same three endpoints and the same public-client rules as the CLI's
 * `oauth.ts`: `client_id` in the form body, PKCE proves the redemption, and a
 * failed exchange is described from the OAuth error fields and never by echoing
 * a body, because a body that *looked* successful holds the refresh token.
 */

/** The resource-server scope, `MACHINE_SCOPE` in the data stack. */
export const API_SCOPE = "nightshift/api";
export const SCOPES: readonly string[] = ["openid", "email", "profile", API_SCOPE];

export const authorizeEndpointFor = (authDomain: string): string =>
  `https://${authDomain}/oauth2/authorize`;
export const tokenEndpointFor = (authDomain: string): string =>
  `https://${authDomain}/oauth2/token`;
export const revokeEndpointFor = (authDomain: string): string =>
  `https://${authDomain}/oauth2/revoke`;

export interface AuthorizeUrlInput {
  readonly authDomain: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly state: string;
  readonly codeChallenge: string;
  readonly codeChallengeMethod: string;
}

export const authorizeUrl = (input: AuthorizeUrlInput): string => {
  const query = new URLSearchParams({
    response_type: "code",
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    scope: SCOPES.join(" "),
    state: input.state,
    code_challenge: input.codeChallenge,
    code_challenge_method: input.codeChallengeMethod,
  });
  return `${authorizeEndpointFor(input.authDomain)}?${query.toString()}`;
};

/** The slice of `fetch` the token endpoints need. */
export type OAuthFetch = (
  url: string,
  init: {
    readonly method: "POST";
    readonly headers: Record<string, string>;
    readonly body: string;
  },
) => Promise<{ readonly status: number; text(): Promise<string> }>;

export class TokenExchangeError extends Error {
  override readonly name = "TokenExchangeError";
  readonly code = "token_exchange_failed" as const;
  constructor(
    readonly status: number,
    detail: string,
  ) {
    super(`the token endpoint refused the request (${status}): ${detail}`);
  }
}

/** A failed exchange, described from named fields only. Never the raw body. */
export const describeTokenFailure = (body: string): string => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return `the response was not JSON (${new TextEncoder().encode(body).byteLength} bytes)`;
  }
  const fields = parsed as { error?: unknown; error_description?: unknown };
  const error = typeof fields.error === "string" ? fields.error : undefined;
  const description =
    typeof fields.error_description === "string" ? fields.error_description : undefined;
  if (error === undefined && description === undefined) return "the response named no OAuth error";
  return [error, description].filter((part) => part !== undefined).join(": ");
};

const form = (fields: Record<string, string>) => ({
  method: "POST" as const,
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(fields).toString(),
});

export interface ExchangedTokens {
  readonly idToken: string;
  readonly refreshToken: string;
}

export const exchangeAuthorizationCode = async (
  input: {
    readonly authDomain: string;
    readonly clientId: string;
    readonly redirectUri: string;
    readonly code: string;
    readonly codeVerifier: string;
  },
  doFetch: OAuthFetch,
): Promise<ExchangedTokens> => {
  const response = await doFetch(
    tokenEndpointFor(input.authDomain),
    form({
      grant_type: "authorization_code",
      client_id: input.clientId,
      code: input.code,
      redirect_uri: input.redirectUri,
      code_verifier: input.codeVerifier,
    }),
  );
  const text = await response.text();
  if (response.status !== 200) {
    throw new TokenExchangeError(response.status, describeTokenFailure(text));
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new TokenExchangeError(response.status, "the response was not JSON");
  }
  const tokens = parsed as { id_token?: unknown; refresh_token?: unknown };
  if (typeof tokens.id_token !== "string" || typeof tokens.refresh_token !== "string") {
    const missing = [
      typeof tokens.id_token === "string" ? undefined : "id_token",
      typeof tokens.refresh_token === "string" ? undefined : "refresh_token",
    ].filter((name) => name !== undefined);
    throw new TokenExchangeError(
      response.status,
      `the response carried no ${missing.join(" and no ")}`,
    );
  }
  return { idToken: tokens.id_token, refreshToken: tokens.refresh_token };
};

/** The refresh grant: a new ID token; the stored refresh token keeps working. */
export const refreshIdToken = async (
  input: { readonly authDomain: string; readonly clientId: string; readonly refreshToken: string },
  doFetch: OAuthFetch,
): Promise<string> => {
  const response = await doFetch(
    tokenEndpointFor(input.authDomain),
    form({
      grant_type: "refresh_token",
      client_id: input.clientId,
      refresh_token: input.refreshToken,
    }),
  );
  const text = await response.text();
  if (response.status !== 200) {
    throw new TokenExchangeError(response.status, describeTokenFailure(text));
  }
  const idToken = (JSON.parse(text) as { id_token?: unknown }).id_token;
  if (typeof idToken !== "string") {
    throw new TokenExchangeError(response.status, "the response carried no id_token");
  }
  return idToken;
};

/** Best effort, and it says so: sign-out clears the browser whatever this answers. */
export const revokeRefreshToken = async (
  input: { readonly authDomain: string; readonly clientId: string; readonly refreshToken: string },
  doFetch: OAuthFetch,
): Promise<{ readonly revoked: boolean; readonly detail: string }> => {
  try {
    const response = await doFetch(
      revokeEndpointFor(input.authDomain),
      form({ token: input.refreshToken, client_id: input.clientId }),
    );
    if (response.status === 200) return { revoked: true, detail: "revoked at Cognito" };
    return {
      revoked: false,
      detail: `Cognito answered ${response.status}: ${describeTokenFailure(await response.text())}`,
    };
  } catch (cause) {
    return {
      revoked: false,
      detail: `the revocation endpoint could not be reached (${cause instanceof Error ? cause.message : String(cause)})`,
    };
  }
};
