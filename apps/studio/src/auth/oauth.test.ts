import { describe, expect, it } from "vitest";
import {
  authorizeUrl,
  describeTokenFailure,
  exchangeAuthorizationCode,
  revokeRefreshToken,
  TokenExchangeError,
} from "./oauth.js";

const respond = (status: number, body: string) => async () => ({ status, text: async () => body });

describe("oauth", () => {
  it("builds the hosted UI URL with PKCE and the four scopes", () => {
    const url = new URL(
      authorizeUrl({
        authDomain: "pool.auth.us-west-2.amazoncognito.com",
        clientId: "c1",
        redirectUri: "https://studio.dev.nightshift.wildorder.dev/callback",
        state: "s",
        codeChallenge: "ch",
        codeChallengeMethod: "S256",
      }),
    );
    expect(url.origin + url.pathname).toBe(
      "https://pool.auth.us-west-2.amazoncognito.com/oauth2/authorize",
    );
    expect(url.searchParams.get("scope")).toBe("openid email profile nightshift/api");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://studio.dev.nightshift.wildorder.dev/callback",
    );
  });

  it("describes a failed exchange from named fields and never the body", async () => {
    // A 200-looking body with a token in it must not reach the message.
    expect(describeTokenFailure(JSON.stringify({ refresh_token: "SECRET" }))).toBe(
      "the response named no OAuth error",
    );
    await expect(
      exchangeAuthorizationCode(
        { authDomain: "d", clientId: "c", redirectUri: "r", code: "x", codeVerifier: "v" },
        respond(400, JSON.stringify({ error: "invalid_grant", error_description: "expired" })),
      ),
    ).rejects.toThrow(/invalid_grant: expired/);
    try {
      await exchangeAuthorizationCode(
        { authDomain: "d", clientId: "c", redirectUri: "r", code: "x", codeVerifier: "v" },
        respond(200, JSON.stringify({ refresh_token: "SECRET" })),
      );
      throw new Error("unreachable");
    } catch (error) {
      expect(error).toBeInstanceOf(TokenExchangeError);
      expect(String(error)).not.toContain("SECRET");
      expect(String(error)).toContain("no id_token");
    }
  });

  it("reports a revocation honestly either way", async () => {
    const input = { authDomain: "d", clientId: "c", refreshToken: "SECRET" };
    expect((await revokeRefreshToken(input, respond(200, ""))).revoked).toBe(true);
    const failed = await revokeRefreshToken(input, async () => {
      throw new Error("offline");
    });
    expect(failed.revoked).toBe(false);
    expect(failed.detail).toContain("offline");
    expect(failed.detail).not.toContain("SECRET");
  });
});
