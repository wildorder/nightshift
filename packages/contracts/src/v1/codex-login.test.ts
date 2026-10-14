/** Which refreshed Codex login may replace an org's sealed one (2026-10-13). */
import { describe, expect, it } from "vitest";
import { refreshedCodexLogin } from "./credentials.js";

const login = (refreshed: string | undefined, account = "acct-1") =>
  JSON.stringify({
    auth_mode: "chatgpt",
    ...(refreshed === undefined ? {} : { last_refresh: refreshed }),
    tokens: { account_id: account, access_token: "a", refresh_token: "r" },
  });

describe("refreshedCodexLogin", () => {
  const sealed = login("2026-10-02T06:31:35Z");

  it("takes the same account, refreshed since", () => {
    expect(refreshedCodexLogin(sealed, login("2026-10-14T03:00:00Z"))).toEqual({ accept: true });
  });

  it("refuses an older or equal refresh, another account, an undated one, or something else", () => {
    for (const [offered, reason] of [
      [login("2026-10-01T00:00:00Z"), /no newer/],
      [login("2026-10-02T06:31:35Z"), /no newer/],
      [login("2026-10-14T03:00:00Z", "acct-2"), /different ChatGPT account/],
      [login(undefined), /nothing of when/],
      ["sk-not-a-login-file", /not a Codex login/],
    ] as const) {
      const verdict = refreshedCodexLogin(sealed, offered);
      expect(verdict.accept, offered).toBe(false);
      if (!verdict.accept) expect(verdict.reason).toMatch(reason);
    }
  });
});
