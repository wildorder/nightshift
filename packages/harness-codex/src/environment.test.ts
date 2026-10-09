import { describe, expect, it } from "vitest";
import { envAllowlistFor, sanitizeCodexEnvironment } from "./environment.js";

const PARENT = {
  PATH: "/usr/bin",
  HOME: "/Users/op",
  CODEX_HOME: "/Users/op/.codex",
  OPENAI_API_KEY: "sk-operator",
  ANTHROPIC_API_KEY: "sk-ant",
  AWS_PROFILE: "nightshift",
  AWS_SECRET_ACCESS_KEY: "secret",
  NIGHTSHIFT_API_TOKEN: "the operator's session",
  NIGHTSHIFT_EXECUTION_TOKEN: "somebody's token",
  NIGHTSHIFT_CONFIG_DIR: "/Users/op/.config/nightshift",
  HTTPS_PROXY: "http://proxy:3128",
  TERM: "xterm-256color",
};

describe("the Codex worker's environment (D-P5-02)", () => {
  const env = sanitizeCodexEnvironment({ platform: "darwin", parentEnv: PARENT });

  it("passes CODEX_HOME through, with what it takes to start at all", () => {
    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/Users/op",
      CODEX_HOME: "/Users/op/.codex",
      HTTPS_PROXY: "http://proxy:3128",
    });
  });

  it("passes nothing of the operator's: no Nightshift session, no AWS, no API key of any provider", () => {
    for (const name of Object.keys(env)) {
      expect(name).not.toMatch(/^(NIGHTSHIFT_|AWS_|ANTHROPIC_|OPENAI_)/);
    }
    for (const platform of ["darwin", "linux", "win32"] as const) {
      for (const name of envAllowlistFor(platform)) {
        expect(name).not.toMatch(/KEY|TOKEN|SECRET|PASSWORD/i);
      }
    }
  });

  it("passes DOCKER_HOST, so the agent's shell finds the developer's Docker (P16 S-01)", () => {
    const docker = sanitizeCodexEnvironment({
      platform: "linux",
      parentEnv: { ...PARENT, DOCKER_HOST: "unix:///run/user/1000/docker.sock" },
    });
    expect(docker.DOCKER_HOST).toBe("unix:///run/user/1000/docker.sock");
  });

  it("lets the adapter add to it, and the addition wins", () => {
    const extended = sanitizeCodexEnvironment({
      platform: "linux",
      parentEnv: PARENT,
      extra: { PATH: "/guard:/usr/bin" },
    });
    expect(extended.PATH).toBe("/guard:/usr/bin");
  });

  it("matches names case-insensitively on Windows, keeping their spelling", () => {
    const windows = sanitizeCodexEnvironment({
      platform: "win32",
      parentEnv: { Path: "C:\\Windows", SystemRoot: "C:\\Windows", Secret: "x" },
    });
    expect(windows).toEqual({ Path: "C:\\Windows", SystemRoot: "C:\\Windows" });
  });
});
