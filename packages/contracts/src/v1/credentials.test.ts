import { describe, expect, it } from "vitest";
import {
  CLAUDE_OAUTH_TOKEN_ENV,
  CODEX_HOME_ENV,
  credentialPlacement,
  isCodexAuthFile,
  lastFourOf,
  PROVIDER_KEY_ENV,
  providerEnvironmentVariable,
} from "./credentials.js";

describe("a stored provider credential becomes the variable its CLI reads (D-P10-23)", () => {
  it("hands an Anthropic API key and a Claude Code subscription token to different variables", () => {
    expect(providerEnvironmentVariable("anthropic", "sk-ant-api03-abcdef")).toBe(
      PROVIDER_KEY_ENV.anthropic,
    );
    expect(providerEnvironmentVariable("anthropic", "sk-ant-oat01-abcdef")).toBe(
      CLAUDE_OAUTH_TOKEN_ENV,
    );
    expect(providerEnvironmentVariable("openai", "sk-proj-abcdef")).toBe(PROVIDER_KEY_ENV.openai);
  });

  it("places a Codex login file under CODEX_HOME and an OpenAI key in its variable", () => {
    const login = JSON.stringify({
      auth_mode: "chatgpt",
      OPENAI_API_KEY: null,
      tokens: { id_token: "x", access_token: "y", refresh_token: "z", account_id: "a" },
      last_refresh: "2026-10-02T00:00:00Z",
    });
    expect(isCodexAuthFile(login)).toBe(true);
    expect(isCodexAuthFile("sk-proj-abcdef")).toBe(false);
    expect(isCodexAuthFile("{not json")).toBe(false);
    expect(credentialPlacement("openai", login)).toEqual({
      kind: "file",
      env: CODEX_HOME_ENV,
      directory: "codex",
      file: "auth.json",
    });
    expect(credentialPlacement("openai", "sk-proj-abcdef")).toEqual({
      kind: "env",
      name: PROVIDER_KEY_ENV.openai,
    });
    expect(credentialPlacement("anthropic", "sk-ant-oat01-abcdef")).toEqual({
      kind: "env",
      name: CLAUDE_OAUTH_TOKEN_ENV,
    });
  });

  it("shows the last four characters and nothing more", () => {
    expect(lastFourOf("sk-ant-oat01-abcdef")).toBe("cdef");
    expect(lastFourOf("ab")).toBe("**ab");
  });
});
