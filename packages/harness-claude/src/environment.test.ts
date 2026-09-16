import { describe, expect, it } from "vitest";
import {
  CLAUDE_ENV_ALLOWLIST,
  envAllowlistFor,
  POSIX_ENV_ALLOWLIST,
  sanitizeClaudeEnvironment,
  WINDOWS_ENV_ALLOWLIST,
} from "./environment.js";

/** A parent that looks like the orchestrator's MCP server process really does. */
const PARENT = {
  PATH: "/usr/bin:/bin",
  HOME: "/home/operator",
  LANG: "en_GB.UTF-8",
  SHELL: "/bin/zsh",
  CLAUDE_CONFIG_DIR: "/home/operator/.claude",
  ANTHROPIC_API_KEY: "sk-ant-not-a-real-key",
  HTTPS_PROXY: "http://proxy.invalid:3128",
  // The things a worker must never see.
  NIGHTSHIFT_ROLE: "orchestrator",
  NIGHTSHIFT_RUN_ID: "run_0000000000000000000001",
  NIGHTSHIFT_AGENT_ID: "agent_0000000000000000000001",
  NIGHTSHIFT_API_ENDPOINT: "https://api.invalid",
  AWS_PROFILE: "nightshift-v1",
  AWS_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
  AWS_SECRET_ACCESS_KEY: "not-a-real-secret",
  AWS_SESSION_TOKEN: "not-a-real-token",
  GITHUB_TOKEN: "ghp_notarealtoken",
  TERM: "xterm-256color",
  UNDEFINED_ENTRY: undefined,
} as const;

describe("the child environment is an allowlist", () => {
  const env = sanitizeClaudeEnvironment({ platform: "darwin", parentEnv: PARENT });

  it("passes through what Claude Code needs to find its own configuration and auth", () => {
    expect(env.HOME).toBe("/home/operator");
    expect(env.PATH).toBe("/usr/bin:/bin");
    expect(env.CLAUDE_CONFIG_DIR).toBe("/home/operator/.claude");
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-not-a-real-key");
    expect(env.HTTPS_PROXY).toBe("http://proxy.invalid:3128");
    expect(env.SHELL).toBe("/bin/zsh");
  });

  it("hands the worker none of the parent's Nightshift execution identity", () => {
    for (const name of Object.keys(PARENT).filter((key) => key.startsWith("NIGHTSHIFT_"))) {
      expect(env[name], `${name} reached the worker`).toBeUndefined();
    }
  });

  it("hands the worker no AWS credential or profile", () => {
    for (const name of Object.keys(PARENT).filter((key) => key.startsWith("AWS_"))) {
      expect(env[name], `${name} reached the worker`).toBeUndefined();
    }
  });

  it("hands the worker no unrelated credential that happened to be in the parent", () => {
    expect(env.GITHUB_TOKEN).toBeUndefined();
  });

  it("omits TERM, so the transcript carries no ANSI escapes", () => {
    expect(env.TERM).toBeUndefined();
  });

  it("drops an undefined entry rather than passing an empty string", () => {
    expect("UNDEFINED_ENTRY" in env).toBe(false);
  });

  it("is a denylist for nothing: a name nobody listed does not appear", () => {
    const surprise = sanitizeClaudeEnvironment({
      platform: "darwin",
      parentEnv: { ...PARENT, SOME_FUTURE_SECRET: "leaked" },
    });
    expect(surprise.SOME_FUTURE_SECRET).toBeUndefined();
  });
});

describe("caller additions", () => {
  it("are applied over the base and win a name collision", () => {
    const env = sanitizeClaudeEnvironment({
      platform: "linux",
      parentEnv: PARENT,
      extra: { PATH: "/opt/tools:/usr/bin", EXTRA_ONLY: "yes" },
    });
    expect(env.PATH).toBe("/opt/tools:/usr/bin");
    expect(env.EXTRA_ONLY).toBe("yes");
    // The base is extended, never discarded.
    expect(env.HOME).toBe("/home/operator");
  });
});

describe("platform allowlists", () => {
  it("match a name case-insensitively on Windows, keeping the parent's spelling", () => {
    const env = sanitizeClaudeEnvironment({
      platform: "win32",
      parentEnv: { Path: "C:\\bin", UserProfile: "C:\\Users\\op", NIGHTSHIFT_ROLE: "orchestrator" },
    });
    expect(env.Path).toBe("C:\\bin");
    expect(env.UserProfile).toBe("C:\\Users\\op");
    expect(env.NIGHTSHIFT_ROLE).toBeUndefined();
  });

  it("are case-sensitive on POSIX", () => {
    const env = sanitizeClaudeEnvironment({ platform: "linux", parentEnv: { path: "/nope" } });
    expect(env.path).toBeUndefined();
  });

  it("select by platform and both carry the Claude-specific names", () => {
    expect(envAllowlistFor("win32")).toBe(WINDOWS_ENV_ALLOWLIST);
    expect(envAllowlistFor("darwin")).toBe(POSIX_ENV_ALLOWLIST);
    for (const name of CLAUDE_ENV_ALLOWLIST) {
      expect(POSIX_ENV_ALLOWLIST).toContain(name);
      expect(WINDOWS_ENV_ALLOWLIST).toContain(name);
    }
  });

  it("carries USERPROFILE on Windows, which is where Claude finds its own config there", () => {
    expect(WINDOWS_ENV_ALLOWLIST).toContain("USERPROFILE");
  });
});

describe("the returned environment", () => {
  it("is frozen, so a caller cannot widen it after the fact", () => {
    const env = sanitizeClaudeEnvironment({ platform: "darwin", parentEnv: PARENT });
    expect(Object.isFrozen(env)).toBe(true);
  });
});
