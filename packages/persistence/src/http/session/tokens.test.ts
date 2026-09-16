import { createFixedClock, createSteppingClock, rejectionOf } from "@nightshift/core";
import { describe, expect, it } from "vitest";
import { NotLoggedInError, type Profile } from "./store.js";
import {
  createTokenProvider,
  refreshIdToken,
  staticTokenProvider,
  TOKEN_REFRESH_MARGIN_MS,
  type TokenFetch,
  tokenClaims,
  tokenEndpointFor,
  tokenExpiry,
} from "./tokens.js";

const PROFILE: Profile = {
  apiEndpoint: "https://api.invalid",
  authDomain: "nightshift-dev-1.auth.us-west-2.amazoncognito.com",
  clientId: "the-interactive-client",
  stage: "dev",
};

const base64url = (value: object): string =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

/** A JWT with the given claims. Unsigned: nothing here verifies, and the gateway does. */
const jwt = (claims: Record<string, unknown>): string =>
  [base64url({ alg: "RS256", typ: "JWT" }), base64url(claims), "not-a-signature"].join(".");

interface Call {
  readonly url: string;
  readonly body: string;
  readonly headers: Record<string, string>;
}

const scriptedFetch = (
  answers: readonly { status: number; body: unknown }[],
): { fetch: TokenFetch; calls: Call[] } => {
  const calls: Call[] = [];
  let index = 0;
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, body: init.body, headers: init.headers });
      const answer = answers[Math.min(index, answers.length - 1)];
      index += 1;
      return {
        status: answer?.status ?? 200,
        text: async () =>
          typeof answer?.body === "string" ? answer.body : JSON.stringify(answer?.body ?? {}),
      };
    },
  };
};

const tokenExpiringAt = (epochMs: number) => jwt({ sub: "the-subject", exp: epochMs / 1000 });

describe("reading a token without verifying it", () => {
  it("reads the expiry in milliseconds", () => {
    expect(tokenExpiry(tokenExpiringAt(1_800_000_000_000))).toBe(1_800_000_000_000);
  });

  it("reads the claims", () => {
    expect(tokenClaims(jwt({ sub: "s", "custom:active_org": "org_x" }))["custom:active_org"]).toBe(
      "org_x",
    );
  });

  it("answers undefined or empty for something that is not a JWT", () => {
    expect(tokenExpiry("nonsense")).toBeUndefined();
    expect(tokenExpiry("a.b.c")).toBeUndefined();
    expect(tokenClaims("nonsense")).toEqual({});
  });

  it("builds the token endpoint from the profile's domain", () => {
    expect(tokenEndpointFor(PROFILE)).toBe(`https://${PROFILE.authDomain}/oauth2/token`);
  });
});

describe("the refresh exchange", () => {
  it("posts the refresh grant as a public client: no Authorization header", async () => {
    const { fetch, calls } = scriptedFetch([
      { status: 200, body: { id_token: jwt({ sub: "s" }) } },
    ]);
    await refreshIdToken(PROFILE, "the-refresh-token", fetch);

    const call = calls[0];
    expect(call?.url).toBe(tokenEndpointFor(PROFILE));
    expect(call?.headers.authorization).toBeUndefined();
    const form = new URLSearchParams(call?.body ?? "");
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("client_id")).toBe(PROFILE.clientId);
    expect(form.get("refresh_token")).toBe("the-refresh-token");
  });

  /** The claim the control plane resolves an org from lives only in ID tokens. */
  it("returns the id_token, not the access_token", async () => {
    const id = jwt({ sub: "s", token_use: "id" });
    const { fetch } = scriptedFetch([
      { status: 200, body: { id_token: id, access_token: jwt({ token_use: "access" }) } },
    ]);
    expect(await refreshIdToken(PROFILE, "r", fetch)).toBe(id);
  });

  it("says the session is over when the refresh is refused", async () => {
    const { fetch } = scriptedFetch([{ status: 400, body: { error: "invalid_grant" } }]);
    const failure = await rejectionOf(refreshIdToken(PROFILE, "r", fetch));
    expect(failure).toBeInstanceOf(NotLoggedInError);
    expect(failure.message).toContain("invalid_grant");
    expect(failure.message).toContain("nightshift login");
  });

  it("refuses a 200 that carries no id_token", async () => {
    const { fetch } = scriptedFetch([{ status: 200, body: { access_token: "only-this" } }]);
    await expect(refreshIdToken(PROFILE, "r", fetch)).rejects.toBeInstanceOf(NotLoggedInError);
  });

  it("never echoes the refresh token in a failure", async () => {
    const secret = "a-refresh-token-nobody-should-ever-see";
    const { fetch } = scriptedFetch([{ status: 401, body: "unauthorized" }]);
    const failure = await rejectionOf(refreshIdToken(PROFILE, secret, fetch));
    expect(failure.message).not.toContain(secret);
  });
});

describe("the token provider", () => {
  const NOW = 1_800_000_000_000;

  const provider = (answers: readonly { status: number; body: unknown }[], clockNow = NOW) => {
    const { fetch, calls } = scriptedFetch(answers);
    return {
      calls,
      tokens: createTokenProvider({
        profile: PROFILE,
        refreshToken: "r",
        fetch,
        clock: createFixedClock(clockNow),
      }),
    };
  };

  it("mints a token and then serves it from cache", async () => {
    const token = tokenExpiringAt(NOW + 3_600_000);
    const { tokens, calls } = provider([{ status: 200, body: { id_token: token } }]);
    expect(await tokens.idToken()).toBe(token);
    expect(await tokens.idToken()).toBe(token);
    expect(await tokens.idToken()).toBe(token);
    expect(calls).toHaveLength(1);
  });

  it("mints again once the token is within the refresh margin of expiry", async () => {
    const nearlyExpired = tokenExpiringAt(NOW + TOKEN_REFRESH_MARGIN_MS - 1);
    const fresh = tokenExpiringAt(NOW + 3_600_000);
    const { tokens, calls } = provider([
      { status: 200, body: { id_token: nearlyExpired } },
      { status: 200, body: { id_token: fresh } },
    ]);
    expect(await tokens.idToken()).toBe(nearlyExpired);
    expect(await tokens.idToken()).toBe(fresh);
    expect(calls).toHaveLength(2);
  });

  /** A burst of progress events on a cold cache must not mint a token each. */
  it("shares one in-flight refresh between concurrent callers", async () => {
    const token = tokenExpiringAt(NOW + 3_600_000);
    const { tokens, calls } = provider([{ status: 200, body: { id_token: token } }]);
    const all = await Promise.all([tokens.idToken(), tokens.idToken(), tokens.idToken()]);
    expect(all).toEqual([token, token, token]);
    expect(calls).toHaveLength(1);
  });

  it("retries soon rather than caching forever when a token has no readable expiry", async () => {
    const opaque = "not-a-jwt";
    const { tokens, calls } = provider([{ status: 200, body: { id_token: opaque } }]);
    expect(await tokens.idToken()).toBe(opaque);
    // Cached for one margin and no longer, so the next call mints again.
    expect(await tokens.idToken()).toBe(opaque);
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });

  it("surfaces NotLoggedIn when the refresh is refused, not a cached stale token", async () => {
    const { tokens } = provider([{ status: 400, body: { error: "invalid_grant" } }]);
    await expect(tokens.idToken()).rejects.toBeInstanceOf(NotLoggedInError);
    // And again: a failure is not cached as a success.
    await expect(tokens.idToken()).rejects.toBeInstanceOf(NotLoggedInError);
  });

  it("reads the profile and credentials from disk when it is given neither", async () => {
    const tokens = createTokenProvider({
      paths: { env: { NIGHTSHIFT_CONFIG_DIR: "/nonexistent-nightshift-config" } },
      clock: createSteppingClock(NOW),
    });
    await expect(tokens.idToken()).rejects.toBeInstanceOf(NotLoggedInError);
  });
});

describe("the static provider", () => {
  it("hands back the token it was given, for a script that already holds one", async () => {
    expect(await staticTokenProvider("a-machine-token").idToken()).toBe("a-machine-token");
  });
});
