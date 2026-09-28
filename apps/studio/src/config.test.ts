import { describe, expect, it } from "vitest";
import { loadConfig, StudioConfigError } from "./config.js";

const answer =
  (status: number, body = "") =>
  async () => ({ status, text: async () => body });

describe("loadConfig", () => {
  it("reads config.json when it is served", async () => {
    const config = await loadConfig(
      answer(
        200,
        JSON.stringify({
          stage: "dev",
          apiEndpoint: "https://api.dev.nightshift.wildorder.dev/",
          authDomain: "nightshift-dev-1.auth.us-west-2.amazoncognito.com",
          clientId: "abc",
        }),
      ),
    );
    expect(config.apiEndpoint).toBe("https://api.dev.nightshift.wildorder.dev");
    expect(config.clientId).toBe("abc");
  });

  it("refuses a malformed config rather than guessing", async () => {
    await expect(loadConfig(answer(200, JSON.stringify({ stage: "dev" })))).rejects.toBeInstanceOf(
      StudioConfigError,
    );
    await expect(loadConfig(answer(500))).rejects.toBeInstanceOf(StudioConfigError);
  });

  it("falls back to the stage's defaults only when a client id is baked", async () => {
    await expect(loadConfig(answer(404), "nowhere")).rejects.toThrow(/no baked Studio client id/);
  });
});
