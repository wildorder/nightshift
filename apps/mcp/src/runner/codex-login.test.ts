/** The run's Codex login, offered back when its agents refresh it (2026-10-13). */
import { describe, expect, it } from "vitest";
import { codexLoginOf, codexLoginPaths, watchCodexLogin } from "./root.js";

const login = (refreshed: string, token = "a") =>
  JSON.stringify({
    auth_mode: "chatgpt",
    last_refresh: refreshed,
    tokens: { account_id: "acct-1", access_token: token, refresh_token: token },
  });

describe("watchCodexLogin", () => {
  it("offers the newest refreshed copy once, and nothing while none is newer", async () => {
    const sealed = login("2026-10-02T00:00:00Z", "sealed");
    let copies: string[] = [sealed, sealed];
    const offered: string[] = [];
    const watch = watchCodexLogin({
      sealed,
      read: async () => copies,
      offer: (copy) => offered.push(copy),
      log: () => undefined,
      intervalMs: 60_000,
    });
    await watch.check();
    expect(offered).toEqual([]);

    const project = login("2026-10-14T03:00:00Z", "project");
    copies = [sealed, project];
    await watch.check();
    await watch.check();
    expect(offered).toEqual([project]);

    // The last look, when the root ends, still sees a later refresh.
    const later = login("2026-10-14T09:00:00Z", "later");
    copies = [later, project];
    await watch.stop();
    expect(offered).toEqual([project, later]);
  });

  it("keeps going when a copy cannot be read", async () => {
    const lines: string[] = [];
    const watch = watchCodexLogin({
      sealed: login("2026-10-02T00:00:00Z"),
      read: async () => {
        throw new Error("permission denied");
      },
      offer: () => undefined,
      log: (line) => lines.push(line),
    });
    await watch.stop();
    expect(lines.join()).toMatch(/could not look at the Codex login: permission denied/);
  });

  it("watches only a Codex login file, at the engine's and the project user's paths", () => {
    expect(codexLoginOf({ openai: "sk-proj-1234567890" })).toBeUndefined();
    expect(codexLoginOf({ openai: login("2026-10-02T00:00:00Z") })).toBeDefined();
    expect(codexLoginPaths("run_1")).toEqual({
      engine: "/dev/shm/nightshift/run_1/codex/auth.json",
      project: "/dev/shm/nightshift/run_1/project/CODEX_HOME/auth.json",
    });
  });
});
