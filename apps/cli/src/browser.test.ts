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

describe("the platform opener", () => {
  it("uses each platform's own command", () => {
    expect(openerFor("darwin")).toEqual({ command: "open", args: [] });
    expect(openerFor("linux")).toEqual({ command: "xdg-open", args: [] });
    expect(openerFor("freebsd")).toEqual({ command: "xdg-open", args: [] });
  });

  it("gives Windows `start` its empty title argument", () => {
    // Without it, `start "https://…"` takes the URL as the window title and
    // opens nothing at all.
    expect(openerFor("win32")).toEqual({ command: "cmd", args: ["/c", "start", ""] });
  });
});
