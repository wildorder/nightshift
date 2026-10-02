import { describe, expect, it } from "vitest";
import {
  CLAUDE_OAUTH_TOKEN_ENV,
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

  it("shows the last four characters and nothing more", () => {
    expect(lastFourOf("sk-ant-oat01-abcdef")).toBe("cdef");
    expect(lastFourOf("ab")).toBe("**ab");
  });
});
