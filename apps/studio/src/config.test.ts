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
    expect(config).toEqual({
      kind: "cognito",
      stage: "dev",
      apiEndpoint: "https://api.dev.nightshift.wildorder.dev",
      authDomain: "nightshift-dev-1.auth.us-west-2.amazoncognito.com",
      clientId: "abc",
    });
  });

  it("reads the hosted stack's auth block and a local instance's token config (P12)", async () => {
    const hosted = await loadConfig(
      answer(
        200,
        JSON.stringify({
          stage: "dev",
          apiEndpoint: "https://api.dev.nightshift.wildorder.dev",
          auth: { kind: "cognito", authDomain: "d.example", clientId: "c" },
        }),
      ),
    );
    expect(hosted).toMatchObject({ kind: "cognito", authDomain: "d.example", clientId: "c" });
    const local = await loadConfig(
      answer(
        200,
        JSON.stringify({
          stage: "local",
          apiEndpoint: "http://127.0.0.1:47820/api",
          auth: { kind: "token" },
        }),
      ),
    );
    expect(local).toEqual({
      kind: "token",
      stage: "local",
      apiEndpoint: "http://127.0.0.1:47820/api",
    });
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
