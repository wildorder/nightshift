import { webcrypto } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { StudioConfig } from "../config.js";
import {
  beginSignIn,
  completeSignIn,
  createBrowserTokenProvider,
  hasSession,
  NotSignedInError,
  REFRESH_TOKEN_KEY,
  type SessionEnvironment,
  signOut,
} from "./session.js";

const config: StudioConfig = {
  stage: "dev",
  apiEndpoint: "https://api.dev.nightshift.wildorder.dev",
  authDomain: "pool.auth.us-west-2.amazoncognito.com",
  clientId: "studio-client",
};

const memoryStorage = () => {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    dump: () => Object.fromEntries(map),
  };
};

const jwt = (claims: Record<string, unknown>): string => {
  const part = (v: unknown) => Buffer.from(JSON.stringify(v), "utf8").toString("base64url");
  return `${part({ alg: "none" })}.${part(claims)}.`;
};

interface World {
  readonly env: SessionEnvironment;
  readonly durable: ReturnType<typeof memoryStorage>;
  readonly tab: ReturnType<typeof memoryStorage>;
  readonly navigated: string[];
  readonly requests: { url: string; body: string }[];
  now: number;
}

const world = (answer: (url: string, body: string) => { status: number; body: string }): World => {
  const durable = memoryStorage();
  const tab = memoryStorage();
  const navigated: string[] = [];
  const requests: { url: string; body: string }[] = [];
  const w: World = {
    durable,
    tab,
    navigated,
    requests,
    now: Date.parse("2026-09-28T12:00:00Z"),
    env: {
      config,
      durable,
      tab,
      fetch: async (url, init) => {
        requests.push({ url, body: init.body });
        const a = answer(url, init.body);
        return { status: a.status, text: async () => a.body };
      },
      random: webcrypto,
      digest: webcrypto.subtle,
      origin: "http://localhost:5173",
      navigate: (url) => void navigated.push(url),
      now: () => w.now,
    },
  };
  return w;
};

const expIn = (w: World, seconds: number) => Math.floor(w.now / 1000) + seconds;

describe("the browser session", () => {
  it("signs in: state checked, code redeemed, only the refresh token stored", async () => {
    const w = world((url) =>
      url.endsWith("/oauth2/token")
        ? {
            status: 200,
            body: JSON.stringify({
              id_token: jwt({ sub: "u1", email: "tim@example.test", exp: expIn(w, 3600) }),
              refresh_token: "REFRESH",
            }),
          }
        : { status: 404, body: "" },
    );
    expect(hasSession(w.env)).toBe(false);
    await beginSignIn(w.env);
    const sent = new URL(w.navigated[0] ?? "");
    expect(sent.searchParams.get("redirect_uri")).toBe("http://localhost:5173/callback");
    const state = sent.searchParams.get("state") ?? "";

    await expect(
      completeSignIn(w.env, new URLSearchParams({ code: "c", state: "other" })),
    ).rejects.toThrow(/state/);

    const identity = await completeSignIn(w.env, new URLSearchParams({ code: "c", state }));
    expect(identity).toEqual({
      subject: "u1",
      email: "tim@example.test",
      activeOrgClaim: undefined,
    });
    expect(w.durable.dump()).toEqual({ [REFRESH_TOKEN_KEY]: "REFRESH" });
    expect(w.tab.dump()).toEqual({});
    expect(hasSession(w.env)).toBe(true);
    // The verifier went to the token endpoint and nowhere else.
    expect(w.requests[0]?.body).toContain("code_verifier=");
  });

  it("refuses a callback in a tab that started no sign-in", async () => {
    const w = world(() => ({ status: 500, body: "" }));
    await expect(
      completeSignIn(w.env, new URLSearchParams({ code: "c", state: "s" })),
    ).rejects.toThrow(NotSignedInError);
  });

  it("mints an ID token from the refresh token, caches it, and refreshes near expiry", async () => {
    let mints = 0;
    const w = world(() => {
      mints += 1;
      return {
        status: 200,
        body: JSON.stringify({ id_token: jwt({ sub: "u1", exp: expIn(w, 3600) }) }),
      };
    });
    w.durable.setItem(REFRESH_TOKEN_KEY, "REFRESH");
    const provider = createBrowserTokenProvider(w.env);
    const [a, b] = await Promise.all([provider.idToken(), provider.idToken()]);
    expect(a).toBe(b);
    expect(mints).toBe(1);
    expect(w.requests[0]?.body).toContain("grant_type=refresh_token");
    w.now += 3600 * 1000 - 30_000;
    await provider.idToken();
    expect(mints).toBe(2);
    expect((await provider.identity()).subject).toBe("u1");
  });

  it("signs out: revokes at Cognito and clears the browser whatever Cognito says", async () => {
    const w = world((url) => ({ status: url.endsWith("/oauth2/revoke") ? 400 : 200, body: "{}" }));
    w.durable.setItem(REFRESH_TOKEN_KEY, "REFRESH");
    const result = await signOut(w.env);
    expect(result.revoked).toBe(false);
    expect(result.detail).not.toContain("REFRESH");
    expect(w.durable.dump()).toEqual({});
    expect(hasSession(w.env)).toBe(false);
    await expect(createBrowserTokenProvider(w.env).idToken()).rejects.toThrow(NotSignedInError);
  });
});
