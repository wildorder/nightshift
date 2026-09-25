import type { RouteTarget, Scope } from "@nightshift/contracts";
import type { McpLaunch } from "@nightshift/harness";
import { describe, expect, it } from "vitest";
import {
  buildClaudeArgs,
  buildMcpConfig,
  buildSettings,
  claudeBriefAddendum,
  claudePrompt,
  VERIFIED_CLAUDE_VERSION,
} from "./command.js";
import { claudeToolPolicy } from "./permissions.js";

const MODEL: RouteTarget = { harness: "claude", provider: "anthropic", model: "claude-sonnet-5" };

const MCP: McpLaunch = {
  name: "nightshift",
  command: "/usr/local/bin/nightshift-mcp",
  args: ["--stdio"],
  env: {
    NIGHTSHIFT_ROLE: "worker",
    NIGHTSHIFT_API_ENDPOINT: "https://api.invalid",
    NIGHTSHIFT_PROJECT_ID: "proj_1",
    NIGHTSHIFT_PROGRAM_ID: "prog_1",
    NIGHTSHIFT_RUN_ID: "run_1",
    NIGHTSHIFT_NODE_ID: "node_1",
    NIGHTSHIFT_AGENT_ID: "agent_1",
    NIGHTSHIFT_JOB_ID: "job_1",
  },
};

const scope = (permissions: readonly string[]): Scope => ({
  includes: ["src/**"],
  excludes: [],
  permissions: [...permissions],
  forbiddenActions: [],
});

const argsFor = (permissions: readonly string[], prompt = "BRIEF") =>
  buildClaudeArgs({
    prompt,
    model: MODEL,
    mcpConfigPath: "/tmp/ns/mcp.json",
    settingsPath: "/tmp/ns/settings.json",
    policy: claudeToolPolicy({ scope: scope(permissions) }),
  });

/** The index of a flag, or -1. */
const at = (args: readonly string[], flag: string): number => args.indexOf(flag);

/** The single value following a flag. */
const flagValue = (args: readonly string[], flag: string): string | undefined => {
  const index = at(args, flag);
  return index === -1 ? undefined : args[index + 1];
};

describe("the command line, against Claude Code 2.1.273", () => {
  const args = argsFor(["fs.read", "fs.write", "shell.exec"]);

  it("records the version its flags were verified against", () => {
    expect(VERIFIED_CLAUDE_VERSION).toBe("2.1.273");
  });

  it("is exactly the documented command line", () => {
    expect(args).toEqual([
      "-p",
      "BRIEF",
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      "claude-sonnet-5",
      "--mcp-config",
      "/tmp/ns/mcp.json",
      "--strict-mcp-config",
      "--settings",
      "/tmp/ns/settings.json",
      "--setting-sources",
      "",
      "--permission-mode",
      "bypassPermissions",
      "--disallowedTools",
      expect.stringContaining("Bash(git commit:*)"),
      "--no-session-persistence",
    ]);
  });

  it("puts the brief before every variadic flag, so none of them swallows it", () => {
    // `--disallowedTools` and `--mcp-config` are `<value...>` in this release. A
    // positional argument after one of them becomes another of its values.
    expect(args[0]).toBe("-p");
    expect(args[1]).toBe("BRIEF");
    for (const variadic of ["--disallowedTools", "--mcp-config"]) {
      expect(at(args, variadic)).toBeGreaterThan(1);
    }
  });

  it("gives the deny flag exactly one comma-separated value", () => {
    const index = at(args, "--disallowedTools");
    expect(typeof args[index + 1]).toBe("string");
    // The value after the value must be the next flag, not another list entry.
    expect(args[index + 2]?.startsWith("--")).toBe(true);
  });

  it("passes the model routing chose, unchanged and with no list of its own", () => {
    expect(flagValue(args, "--model")).toBe(MODEL.model);
    const alias = argsFor([], "B");
    expect(flagValue(alias, "--model")).toBe("claude-sonnet-5");
  });

  it("turns session persistence off and refuses every other configuration source", () => {
    expect(args).toContain("--no-session-persistence");
    expect(args).toContain("--strict-mcp-config");
    expect(flagValue(args, "--setting-sources")).toBe("");
  });

  it("can never stop for approval, and passes no list of what a worker may use", () => {
    expect(flagValue(args, "--permission-mode")).toBe("bypassPermissions");
    // An allow-list is a guess at everything a worker will need; the first miss
    // is a denied tool with nobody there to fix it. The owner ruled them out.
    for (const flag of ["--tools", "--allowedTools", "--allowed-tools", "--permission-prompts"]) {
      expect(args, flag).not.toContain(flag);
    }
  });

  it("carries no flag that would resume another conversation", () => {
    for (const flag of ["--resume", "-r", "--continue", "-c", "--fork-session"]) {
      expect(args).not.toContain(flag);
    }
  });

  it("asks for the structured stream with the verbosity that release requires", () => {
    // Verified: `claude -p --output-format stream-json` without `--verbose`
    // exits 1 with "When using --print, --output-format=stream-json requires
    // --verbose".
    expect(flagValue(args, "--output-format")).toBe("stream-json");
    expect(args).toContain("--verbose");
  });

  it("is the same command line whatever the scope's permissions say", () => {
    expect(argsFor([])).toEqual(args);
    expect(argsFor(["fs.read"])).toEqual(args);
  });
});

describe("the MCP configuration file", () => {
  it("passes McpLaunch through unchanged, entry for entry (D-P3-01)", () => {
    const parsed = JSON.parse(buildMcpConfig(MCP));
    expect(Object.keys(parsed.mcpServers)).toEqual(["nightshift"]);
    expect(parsed.mcpServers.nightshift).toEqual({
      command: MCP.command,
      args: ["--stdio"],
      env: MCP.env,
    });
  });

  it("adds, removes and rewrites nothing in the identity block", () => {
    const parsed = JSON.parse(buildMcpConfig(MCP));
    const env = parsed.mcpServers.nightshift.env as Record<string, string>;
    expect(Object.keys(env).sort()).toEqual(Object.keys(MCP.env).sort());
    for (const [name, value] of Object.entries(MCP.env)) expect(env[name]).toBe(value);
  });

  it("is valid JSON ending in a newline", () => {
    const text = buildMcpConfig(MCP);
    expect(text.endsWith("\n")).toBe(true);
    expect(() => JSON.parse(text)).not.toThrow();
  });
});

describe("the settings file", () => {
  it("configures no hooks, because the stream carries every contract event", () => {
    expect(JSON.parse(buildSettings()).hooks).toEqual({});
  });

  it("stops the worker carrying a commit convention Nightshift does not want", () => {
    expect(JSON.parse(buildSettings()).includeCoAuthoredBy).toBe(false);
  });
});

describe("the Claude-specific brief addendum", () => {
  const addendum = () => claudeBriefAddendum({ mcpServerName: MCP.name });

  it("tells the model the name it must actually call to end the job", () => {
    const text = addendum();
    expect(text).toContain("mcp__nightshift__job_complete");
    expect(text).toContain("mcp__nightshift__job_fail");
  });

  it("says that git writes are denied at the point of use, not escalated", () => {
    expect(addendum()).toContain("denied");
  });

  it("tells the worker nothing will ask for approval, so it does not wait for any", () => {
    expect(addendum()).toContain("nothing will ask for");
  });

  it("repeats nothing from T1's brief: no scope, no acceptance, no commit instructions", () => {
    const text = addendum();
    expect(text).not.toContain("ACCEPTANCE CRITERIA");
    expect(text).not.toContain("SCOPE —");
    expect(text).not.toContain("VERIFICATION —");
  });
});

describe("the full prompt", () => {
  it("is the neutral brief followed by the addendum, in that order", () => {
    const prompt = claudePrompt("NEUTRAL BRIEF\n\n", "ADDENDUM");
    expect(prompt).toBe("NEUTRAL BRIEF\n\nADDENDUM\n");
    expect(prompt.indexOf("NEUTRAL")).toBeLessThan(prompt.indexOf("ADDENDUM"));
  });
});

describe("a rung's reasoning effort (P8)", () => {
  it("is passed as --effort when the route names one, and not otherwise", () => {
    const withEffort = buildClaudeArgs({
      prompt: "BRIEF",
      model: { ...MODEL, effort: "high" },
      mcpConfigPath: "/tmp/ns/mcp.json",
      settingsPath: "/tmp/ns/settings.json",
      policy: claudeToolPolicy({ scope: scope([]) }),
    });
    expect(flagValue(withEffort, "--effort")).toBe("high");
    expect(at(argsFor([]), "--effort")).toBe(-1);
  });
});
