/**
 * Only the decision is tested, never the spawn.
 *
 * Running `openBrowser` in a suite would try to open a real window on whatever
 * machine the suite is on — a developer's laptop, or a CI runner with `xdg-open`
 * installed. The outcome that matters to `nightshift login` is "the opener
 * answered false", and `login.test.ts` drives that with an injected opener.
 */
import { describe, expect, it } from "vitest";
import { openerFor } from "./browser.js";

const URL_WITH_AMPERSANDS =
  "https://example.auth.us-west-2.amazoncognito.com/oauth2/authorize?client_id=abc&response_type=code&state=xyz";

describe("the platform opener", () => {
  it("uses each platform's own command, with the URL as one plain argument", () => {
    for (const platform of ["darwin", "linux", "freebsd"] as const) {
      const invocation = openerFor(platform, URL_WITH_AMPERSANDS);
      expect(invocation.command).toBe(platform === "darwin" ? "open" : "xdg-open");
      expect(invocation.args).toEqual([URL_WITH_AMPERSANDS]);
      expect(invocation.windowsVerbatimArguments).toBe(false);
    }
  });

  it("gives Windows `start` its empty title argument and the URL in quotes, verbatim", () => {
    // `start` is a `cmd` builtin: without the title `start "https://…"` opens
    // nothing, and without the quotes `cmd` cuts the URL at the first `&`.
    expect(openerFor("win32", URL_WITH_AMPERSANDS)).toEqual({
      command: "cmd",
      args: ["/c", "start", '""', `"${URL_WITH_AMPERSANDS}"`],
      windowsVerbatimArguments: true,
    });
  });

  it("keeps every `&` inside the one quoted Windows argument", () => {
    const [, , , quoted] = openerFor("win32", URL_WITH_AMPERSANDS).args;
    expect(quoted).toBeDefined();
    expect((quoted ?? "").startsWith('"')).toBe(true);
    expect((quoted ?? "").endsWith('"')).toBe(true);
    expect((quoted ?? "").slice(1, -1)).toBe(URL_WITH_AMPERSANDS);
  });
});
