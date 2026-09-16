import { describe, expect, it } from "vitest";
import { LOOPBACK_CALLBACK_URL, LOOPBACK_PORT } from "./loopback.js";
import {
  API_SCOPE,
  authorizeUrl,
  describeTokenFailure,
  exchangeAuthorizationCode,
  revokeRefreshToken,
  SCOPES,
  TokenExchangeError,
} from "./oauth.js";
import { createFakeFetch } from "./testing/harness.js";

const DOMAIN = "nightshift-dev-755348349819.auth.us-west-2.amazoncognito.com";
const CLIENT = "4example4client4id";
const SECRET = "eyJrefresh.THIS-IS-THE-REFRESH-TOKEN.value";

describe("the authorize URL", () => {
  const url = new URL(
    authorizeUrl({
      authDomain: DOMAIN,
      clientId: CLIENT,
      redirectUri: LOOPBACK_CALLBACK_URL,
      state: "the-state",
      codeChallenge: "the-challenge",
      codeChallengeMethod: "S256",
    }),
  );

  it("is the pool domain's authorize endpoint", () => {
    expect(url.origin).toBe(`https://${DOMAIN}`);
    expect(url.pathname).toBe("/oauth2/authorize");
  });

  it("asks for the authorization code with a S256 challenge", () => {
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe(CLIENT);
    expect(url.searchParams.get("code_challenge")).toBe("the-challenge");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe("the-state");
  });

  it("asks for the OIDC scopes plus the resource-server scope", () => {
    expect(url.searchParams.get("scope")).toBe(`openid email profile ${API_SCOPE}`);
    expect(SCOPES).toEqual(["openid", "email", "profile", "nightshift/api"]);
  });

  it("names the registered redirect URI exactly, port included", () => {
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:47821/callback");
    expect(LOOPBACK_PORT).toBe(47821);
  });
});

describe("the token exchange", () => {
  const input = {
    authDomain: DOMAIN,
    clientId: CLIENT,
    redirectUri: LOOPBACK_CALLBACK_URL,
    code: "the-authorization-code",
    codeVerifier: "the-verifier",
  };

  it("posts a public-client body: client_id and code_verifier, and no Authorization header", async () => {
    const fake = createFakeFetch(() => ({
      status: 200,
      body: JSON.stringify({ id_token: "id", refresh_token: SECRET }),
    }));

    const tokens = await exchangeAuthorizationCode(input, fake.fetch);

    expect(tokens).toEqual({ idToken: "id", refreshToken: SECRET });
    const request = fake.requests[0];
    expect(request?.url).toBe(`https://${DOMAIN}/oauth2/token`);
    expect(request?.method).toBe("POST");
    expect(Object.keys(request?.headers ?? {})).not.toContain("authorization");
    expect(fake.form(request as never)).toEqual({
      grant_type: "authorization_code",
      client_id: CLIENT,
      code: "the-authorization-code",
      redirect_uri: LOOPBACK_CALLBACK_URL,
      code_verifier: "the-verifier",
    });
  });

  it("describes a refusal from the OAuth error fields", async () => {
    const fake = createFakeFetch(() => ({
      status: 400,
      body: JSON.stringify({ error: "invalid_grant", error_description: "code already redeemed" }),
    }));

    await expect(exchangeAuthorizationCode(input, fake.fetch)).rejects.toThrow(
      /invalid_grant: code already redeemed/,
    );
  });

  it("never puts the refresh token in the failure, even when the body holds one", async () => {
    // The shape that makes this a real risk: a 200 that carries the token and is
    // still a failure, because the ID token is missing.
    const fake = createFakeFetch(() => ({
      status: 200,
      body: JSON.stringify({ refresh_token: SECRET, token_type: "Bearer" }),
    }));

    const failure = await exchangeAuthorizationCode(input, fake.fetch).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(TokenExchangeError);
    expect((failure as Error).message).toContain("no id_token");
    expect((failure as Error).message).not.toContain(SECRET);
    expect(JSON.stringify(failure)).not.toContain(SECRET);
  });

  it("does not echo a non-JSON body, only its size", () => {
    expect(describeTokenFailure(`<html>${SECRET}</html>`)).not.toContain(SECRET);
    expect(describeTokenFailure("<html>oops</html>")).toMatch(/not JSON \(17 bytes\)/);
  });
});

describe("revocation", () => {
  it("posts the token and the client id, and reports success", async () => {
    const fake = createFakeFetch(() => ({ status: 200, body: "" }));

    const outcome = await revokeRefreshToken(
      { authDomain: DOMAIN, clientId: CLIENT, refreshToken: SECRET },
      fake.fetch,
    );

    expect(outcome.revoked).toBe(true);
    expect(fake.requests[0]?.url).toBe(`https://${DOMAIN}/oauth2/revoke`);
    expect(fake.form(fake.requests[0] as never)).toEqual({ token: SECRET, client_id: CLIENT });
  });

  it("reports honestly when Cognito refuses, without quoting the token", async () => {
    const fake = createFakeFetch(() => ({
      status: 401,
      body: JSON.stringify({ error: "invalid_client" }),
    }));

    const outcome = await revokeRefreshToken(
      { authDomain: DOMAIN, clientId: CLIENT, refreshToken: SECRET },
      fake.fetch,
    );

    expect(outcome.revoked).toBe(false);
    expect(outcome.detail).toContain("401");
    expect(outcome.detail).toContain("invalid_client");
    expect(outcome.detail).not.toContain(SECRET);
  });

  it("reports an unreachable endpoint rather than throwing", async () => {
    const outcome = await revokeRefreshToken(
      { authDomain: DOMAIN, clientId: CLIENT, refreshToken: SECRET },
      async () => {
        throw new Error("ENOTFOUND");
      },
    );

    expect(outcome.revoked).toBe(false);
    expect(outcome.detail).toContain("could not be reached");
  });
});
