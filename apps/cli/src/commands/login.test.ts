/**
 * The PKCE sign-in, end to end.
 *
 * "End to end" means what it says: the **real** loopback listener is bound (on a
 * port the operating system picks, because the registered one is fixed and a
 * test must not fight a developer who is signed in), the test reads the
 * authorize URL the injected opener was handed, extracts `state` from it, and
 * performs the callback GET itself. Only two things are stand-ins — `fetch` and
 * the browser — so everything between the authorize URL and `credentials.json`
 * is the code that will run against Cognito.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { credentialsPath, profilePath } from "@nightshift/persistence/http";
import { afterEach, describe, expect, it } from "vitest";
import type { TestEnvironment } from "../testing/harness.js";
import { createFakeFetch, createTestEnvironment, fakeIdToken } from "../testing/harness.js";
import { login, resolveProfile } from "./login.js";

const API = "https://4xnsx809u6.execute-api.us-west-2.amazonaws.com";
const DOMAIN = "nightshift-dev-755348349819.auth.us-west-2.amazoncognito.com";
const CLIENT = "1exampleinteractiveclient";
const SUBJECT = "11111111-2222-3333-4444-555555555555";
const EMAIL = "tim@wingitlabs.com";
/** The one secret. Every failure assertion below checks this string is absent. */
const REFRESH_TOKEN = "eyJjdHkiOiJKV1QiLCJlbmMi.THE-REFRESH-TOKEN.zzz";

const FLAGS = { api: API, authDomain: DOMAIN, clientId: CLIENT };

const live: TestEnvironment[] = [];

afterEach(async () => {
  await Promise.all(live.splice(0).map((created) => created.cleanup()));
});

/**
 * A browser stand-in that finishes the sign-in.
 *
 * It is handed the authorize URL exactly as a real browser would be, reads
 * `state` and `redirect_uri` out of it, and performs the callback request
 * against the listener that is already bound. `codeFor` lets a test send a
 * different `state` than the one it was given, which is the mismatch case.
 */
const browserThatSignsIn =
  (
    captured: { url?: string },
    options: { readonly code?: string; readonly state?: (sent: string) => string } = {},
  ) =>
  async (url: string): Promise<boolean> => {
    captured.url = url;
    const authorize = new URL(url);
    const redirect = new URL(authorize.searchParams.get("redirect_uri") ?? "");
    const sentState = authorize.searchParams.get("state") ?? "";
    redirect.searchParams.set("code", options.code ?? "the-authorization-code");
    redirect.searchParams.set("state", options.state?.(sentState) ?? sentState);
    // The listener binds 127.0.0.1; the registered URL says `localhost`. Same
    // socket, and the test uses the address rather than the name so it does not
    // depend on how this machine resolves `localhost`.
    redirect.hostname = "127.0.0.1";
    await fetch(redirect.toString());
    return true;
  };

const tokenEndpointAnswering = (body: Record<string, unknown>, status = 200) =>
  createFakeFetch(() => ({ status, body: JSON.stringify(body) }));

describe("nightshift login", () => {
  it("runs the whole PKCE exchange and stores a session", async () => {
    const captured: { url?: string } = {};
    const fake = tokenEndpointAnswering({
      id_token: fakeIdToken({ sub: SUBJECT, email: EMAIL }),
      refresh_token: REFRESH_TOKEN,
      access_token: "access",
      expires_in: 3600,
    });
    const created = await createTestEnvironment({
      fetch: fake.fetch,
      openBrowser: browserThatSignsIn(captured),
    });
    live.push(created);

    const result = await login(created.environment, { flags: FLAGS });

    // --- what the browser was sent ---------------------------------------
    const authorize = new URL(captured.url ?? "");
    expect(authorize.origin).toBe(`https://${DOMAIN}`);
    expect(authorize.pathname).toBe("/oauth2/authorize");
    expect(authorize.searchParams.get("client_id")).toBe(CLIENT);
    expect(authorize.searchParams.get("scope")).toBe("openid email profile nightshift/api");
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");

    // --- the token exchange ----------------------------------------------
    const exchange = fake.find("/oauth2/token");
    expect(exchange?.method).toBe("POST");
    expect(Object.keys(exchange?.headers ?? {})).not.toContain("authorization");
    const form = fake.form(exchange as never);
    expect(form.grant_type).toBe("authorization_code");
    expect(form.client_id).toBe(CLIENT);
    expect(form.code).toBe("the-authorization-code");
    // The redirect URI must be the same string that was sent to /authorize.
    expect(form.redirect_uri).toBe(authorize.searchParams.get("redirect_uri"));
    // And the verifier must actually hash to the challenge that was sent.
    expect(
      createHash("sha256")
        .update(form.code_verifier ?? "", "ascii")
        .digest("base64url"),
    ).toBe(authorize.searchParams.get("code_challenge"));

    // --- what was stored --------------------------------------------------
    const credentials = JSON.parse(
      await readFile(credentialsPath(created.environment.paths), "utf8"),
    ) as Record<string, unknown>;
    expect(credentials).toEqual({
      refreshToken: REFRESH_TOKEN,
      subject: SUBJECT,
      clientId: CLIENT,
      obtainedAt: "2026-09-15T12:00:00.000Z",
    });
    const profile = JSON.parse(
      await readFile(profilePath(created.environment.paths), "utf8"),
    ) as Record<string, unknown>;
    expect(profile).toEqual({
      apiEndpoint: API,
      authDomain: DOMAIN,
      clientId: CLIENT,
      stage: "dev",
    });

    // --- what the operator saw -------------------------------------------
    expect(result).toEqual({ profile, subject: SUBJECT, email: EMAIL });
    expect(created.out.join("\n")).toContain(`signed in as ${EMAIL}`);
    expect(created.out.join("\n")).not.toContain(REFRESH_TOKEN);
  });

  it("refuses a callback whose state it did not send, and stores nothing", async () => {
    const captured: { url?: string } = {};
    const fake = tokenEndpointAnswering({});
    const created = await createTestEnvironment({
      fetch: fake.fetch,
      openBrowser: browserThatSignsIn(captured, { state: () => "a-state-from-somewhere-else" }),
    });
    live.push(created);

    await expect(login(created.environment, { flags: FLAGS })).rejects.toThrow(/did not send/);

    // No exchange was attempted, so no code was spent and no session exists.
    expect(fake.requests).toHaveLength(0);
    await expect(readFile(credentialsPath(created.environment.paths), "utf8")).rejects.toThrow();
  });

  it("never names the refresh token when the exchange half-fails", async () => {
    const captured: { url?: string } = {};
    // A 200 that carries the token and is still unusable: the shape where a
    // careless "echo the body" would put the secret on the terminal.
    const fake = tokenEndpointAnswering({ refresh_token: REFRESH_TOKEN, token_type: "Bearer" });
    const created = await createTestEnvironment({
      fetch: fake.fetch,
      openBrowser: browserThatSignsIn(captured),
    });
    live.push(created);

    const failure = await login(created.environment, { flags: FLAGS }).catch(
      (error: unknown) => error,
    );

    expect((failure as Error).message).not.toContain(REFRESH_TOKEN);
    expect((failure as Error).stack ?? "").not.toContain(REFRESH_TOKEN);
    expect(created.out.join("\n")).not.toContain(REFRESH_TOKEN);
    expect(created.err.join("\n")).not.toContain(REFRESH_TOKEN);
  });

  it("prints the URL when no browser can be opened, and still completes", async () => {
    const fake = tokenEndpointAnswering({
      id_token: fakeIdToken({ sub: SUBJECT, email: EMAIL }),
      refresh_token: REFRESH_TOKEN,
    });
    const created = await createTestEnvironment({
      fetch: fake.fetch,
      // A machine with no browser: the opener answers `false` and the human
      // finishes the sign-in from somewhere else.
      openBrowser: async (url) => {
        const authorize = new URL(url);
        const redirect = new URL(authorize.searchParams.get("redirect_uri") ?? "");
        redirect.hostname = "127.0.0.1";
        redirect.searchParams.set("code", "code-from-another-browser");
        redirect.searchParams.set("state", authorize.searchParams.get("state") ?? "");
        await fetch(redirect.toString());
        return false;
      },
    });
    live.push(created);

    await login(created.environment, { flags: FLAGS });

    const printed = created.out.join("\n");
    expect(printed).toContain("could not open a browser");
    expect(printed).toContain(`https://${DOMAIN}/oauth2/authorize?`);
  });

  it("remembers the flags, so a second login needs none", async () => {
    const answer = {
      id_token: fakeIdToken({ sub: SUBJECT, email: EMAIL }),
      refresh_token: REFRESH_TOKEN,
    };
    const first = await createTestEnvironment({
      fetch: tokenEndpointAnswering(answer).fetch,
      openBrowser: browserThatSignsIn({}),
    });
    live.push(first);
    await login(first.environment, { flags: FLAGS });

    // The same config directory, a second invocation, no flags at all.
    const second = {
      ...first.environment,
      fetch: tokenEndpointAnswering(answer).fetch,
      openBrowser: browserThatSignsIn({}),
    };
    const result = await login(second, { flags: {} });

    expect(result.profile).toEqual({
      apiEndpoint: API,
      authDomain: DOMAIN,
      clientId: CLIENT,
      stage: "dev",
    });
  });
});

describe("the files login writes", () => {
  it("writes the profile and the credentials owner-only", async () => {
    const created = await createTestEnvironment({
      fetch: tokenEndpointAnswering({
        id_token: fakeIdToken({ sub: SUBJECT, email: EMAIL }),
        refresh_token: REFRESH_TOKEN,
      }).fetch,
      openBrowser: browserThatSignsIn({}),
    });
    live.push(created);

    await login(created.environment, { flags: FLAGS });

    const paths = [
      profilePath(created.environment.paths),
      credentialsPath(created.environment.paths),
    ];
    if (process.platform === "win32") {
      // Windows has no POSIX mode bits, so `0600` is not a thing to assert. The
      // guarantee there is the ACL on the user's own LOCALAPPDATA, which is not
      // this test's to check — said out loud rather than silently skipped.
      for (const path of paths) expect((await stat(path)).isFile()).toBe(true);
      return;
    }
    for (const path of paths) {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
  });

  it("rewrites an existing credentials file back to 0600", async () => {
    const created = await createTestEnvironment({
      fetch: tokenEndpointAnswering({
        id_token: fakeIdToken({ sub: SUBJECT, email: EMAIL }),
        refresh_token: REFRESH_TOKEN,
      }).fetch,
      openBrowser: browserThatSignsIn({}),
    });
    live.push(created);
    const path = credentialsPath(created.environment.paths);
    await mkdir(dirname(path), { recursive: true });
    // A world-readable leftover from before the rule existed.
    await writeFile(path, "{}", { mode: 0o644 });

    await login(created.environment, { flags: FLAGS });

    if (process.platform === "win32") {
      expect((await stat(path)).isFile()).toBe(true);
      return;
    }
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
});

describe("resolving the flags against the stored profile", () => {
  it("defaults the stage to dev", () => {
    expect(resolveProfile(FLAGS, undefined).stage).toBe("dev");
  });

  it("accepts an auth domain pasted as a URL", () => {
    expect(
      resolveProfile({ ...FLAGS, authDomain: `https://${DOMAIN}/` }, undefined).authDomain,
    ).toBe(DOMAIN);
  });

  it("strips a trailing slash from the API endpoint, which would double every path", () => {
    expect(resolveProfile({ ...FLAGS, api: `${API}/` }, undefined).apiEndpoint).toBe(API);
  });

  it("names every missing flag on a first login", () => {
    expect(() => resolveProfile({}, undefined)).toThrow(/--api, --auth-domain, --client-id/);
  });

  it("lets a flag override what is stored", () => {
    const stored = { apiEndpoint: API, authDomain: DOMAIN, clientId: CLIENT, stage: "dev" };
    expect(resolveProfile({ stage: "prod" }, stored)).toEqual({ ...stored, stage: "prod" });
  });
});
