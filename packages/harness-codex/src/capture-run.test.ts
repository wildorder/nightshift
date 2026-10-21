import { describe, expect, it } from "vitest";
import { captureEnvironment } from "./capture-run.js";

const runAs = (env?: Record<string, string>) => (env === undefined ? {} : { env });

describe("captureEnvironment", () => {
  const adapter = { PATH: "/usr/bin", HOME: "/Users/op", CODEX_HOME: "/Users/op/.codex" };

  it("passes the adapter environment through without runAs", () => {
    expect(captureEnvironment(adapter, undefined)).toEqual(adapter);
  });

  it("takes the project's CODEX_HOME and drops the engine's home under runAs", () => {
    const env = captureEnvironment(
      { PATH: "/usr/bin", HOME: "/Users/op", USERPROFILE: "C:/op" },
      runAs({ CODEX_HOME: "/project/codex" }),
    );
    expect(env.CODEX_HOME).toBe("/project/codex");
    expect(env).not.toHaveProperty("HOME");
    expect(env).not.toHaveProperty("USERPROFILE");
  });

  it("names no Codex home when none is given anywhere", () => {
    const env = captureEnvironment({ PATH: "/usr/bin", HOME: "/Users/op" }, runAs());
    expect(env.CODEX_HOME).toBeUndefined();
    expect(env.HOME).toBeUndefined();
  });

  it("lets runAs.env win a collision", () => {
    expect(captureEnvironment(adapter, runAs({ CODEX_HOME: "/project/codex" })).CODEX_HOME).toBe(
      "/project/codex",
    );
  });
});
