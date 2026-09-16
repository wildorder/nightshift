/**
 * The half of the Cognito session that *obtains* a refresh token.
 *
 * `@nightshift/persistence/http`'s `session/tokens.ts` holds the other half —
 * spending a refresh token for an ID token — and the two are deliberately not
 * merged: the refresh half runs on every command and on every worker, and the
 * half below runs once, at a terminal, with a human present.
 *
 * ## The one absolute rule
 *
 * A refresh token is the only secret Nightshift holds on a developer's machine.
 * It goes into `credentials.json` at mode 0600 and **nowhere else**: not into
 * stdout, not into a log, and above all not into an error message, which is the
 * one that gets pasted into an issue. {@link describeTokenFailure} exists for
 * that: a failed exchange is described from the fields the OAuth error response
 * defines, never by echoing a body that — on a *successful*-looking response
 * that failed for some other reason — would contain the token itself.
 *
 * ## Why the request carries no `Authorization` header
 *
 * The interactive app client is public (`generateSecret: false`). There is no
 * secret to put in a Basic header, so RFC 6749 §2.3.1's client authentication
 * does not apply: `client_id` goes in the form body, and PKCE's `code_verifier`
 * is what actually proves the redemption is legitimate.
 */
import type { FetchLike } from "@nightshift/persistence/http";

/**
 * The resource-server scope, `MACHINE_SCOPE` in `infra/cdk`'s data stack.
 *
 * Restated rather than imported: `infra/cdk` is not in the CLI's layer table and
 * must not be — the IaC app is not a library. The value is asserted against the
 * deployed stack's `MachineScope` output by the data stack's own test, and a
 * drift here would surface at the first `nightshift login` as
 * `invalid_scope` rather than silently.
 */
export const API_SCOPE = "nightshift/api";

/**
 * What the authorization request asks for.
 *
 * `openid email profile` is what makes the ID token carry a `sub` and an
 * `email`, which is what `whoami` reports; the resource-server scope is what the
 * gateway's authorizer requires. Both halves, or a token that authenticates and
 * then cannot say who it is.
 */
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

/** The hosted UI URL the browser is sent to. */
export const authorizeUrl = (input: AuthorizeUrlInput): string => {
  const query = new URLSearchParams({
    response_type: "code",
    client_id: input.clientId,
    // Exactly the registered string. Cognito compares it byte for byte, and it
    // is compared again at the token exchange, so the two must be the same value
    // rather than two spellings of the same address.
    redirect_uri: input.redirectUri,
    scope: SCOPES.join(" "),
    state: input.state,
    code_challenge: input.codeChallenge,
    code_challenge_method: input.codeChallengeMethod,
  });
  return `${authorizeEndpointFor(input.authDomain)}?${query.toString()}`;
};

/** Raised when the token endpoint would not redeem the code. */
export class TokenExchangeError extends Error {
  override readonly name = "TokenExchangeError";
  readonly code = "token_exchange_failed" as const;

  constructor(
    readonly status: number,
    detail: string,
  ) {
    super(`the token endpoint refused the authorization code (${status}): ${detail}`);
  }
}

/**
 * A failed exchange, described from named fields only.
 *
 * Never the raw body. A 200 that is missing `id_token` is still a body holding
 * `refresh_token`, and "echo the response so the operator can see what
 * happened" is precisely how a secret reaches a terminal scrollback.
 */
export const describeTokenFailure = (body: string): string => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return `the response was not JSON (${Buffer.byteLength(body, "utf8")} bytes)`;
  }
  const fields = parsed as { error?: unknown; error_description?: unknown };
  const error = typeof fields.error === "string" ? fields.error : undefined;
  const description =
    typeof fields.error_description === "string" ? fields.error_description : undefined;
  if (error === undefined && description === undefined) {
    return "the response named no OAuth error";
  }
  return [error, description].filter((part) => part !== undefined).join(": ");
};

export interface ExchangeInput {
  readonly authDomain: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly code: string;
  readonly codeVerifier: string;
}

/**
 * What a successful exchange yields.
 *
 * `refreshToken` is the secret. It is returned so `login` can hand it straight
 * to `writeCredentials`, and nothing between here and that call may put it
 * anywhere else.
 */
export interface ExchangedTokens {
  readonly idToken: string;
  readonly refreshToken: string;
}

export const exchangeAuthorizationCode = async (
  input: ExchangeInput,
  doFetch: FetchLike,
): Promise<ExchangedTokens> => {
  const response = await doFetch(tokenEndpointFor(input.authDomain), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    // A public client: `client_id` in the body, no Basic authorization header.
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: input.clientId,
      code: input.code,
      redirect_uri: input.redirectUri,
      code_verifier: input.codeVerifier,
    }).toString(),
  });
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
    // Deliberately says which field is missing and nothing about the ones that
    // are present — one of which is the refresh token.
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

/**
 * Asks Cognito to revoke a refresh token.
 *
 * Best effort, and it says so: `logout` deletes the credentials file whatever
 * this answers, and reports honestly which of the two happened. A revocation
 * that silently failed while the CLI claimed the operator was signed out would
 * be worse than not attempting it.
 */
export const revokeRefreshToken = async (
  input: { readonly authDomain: string; readonly clientId: string; readonly refreshToken: string },
  doFetch: FetchLike,
): Promise<{ readonly revoked: boolean; readonly detail: string }> => {
  let response: { readonly status: number; text(): Promise<string> };
  try {
    response = await doFetch(revokeEndpointFor(input.authDomain), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        token: input.refreshToken,
        client_id: input.clientId,
      }).toString(),
    });
  } catch (cause) {
    return {
      revoked: false,
      detail: `the revocation endpoint could not be reached (${
        cause instanceof Error ? cause.message : String(cause)
      })`,
    };
  }
  if (response.status === 200) return { revoked: true, detail: "revoked at Cognito" };
  return {
    revoked: false,
    detail: `Cognito answered ${response.status}: ${describeTokenFailure(await response.text())}`,
  };
};
