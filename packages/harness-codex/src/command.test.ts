import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpLaunch } from "@nightshift/harness";
import { afterAll, describe, expect, it } from "vitest";
import {
  buildCodexArgs,
  buildGitGuard,
  codexBriefAddendum,
  FORBIDDEN_GIT_SUBCOMMANDS,
  mcpOverrides,
  tomlInlineTable,
  tomlString,
} from "./command.js";

const MCP: McpLaunch = {
  name: "nightshift",
  command: "/usr/local/bin/node",
  args: ["/opt/nightshift/bin/nightshift-mcp.js"],
  env: { NIGHTSHIFT_ROLE: "worker", NIGHTSHIFT_EXECUTION_TOKEN: 'a.b"c\\d' },
};

describe("the command line (D-P5-02)", () => {
  const args = buildCodexArgs({
    prompt: "-- a brief that starts like a flag",
    model: { harness: "codex", provider: "openai", model: "gpt-5.5" },
    worktree: "/state/wt/1",
    mcp: MCP,
  });

  it("is exactly the verified one, in order", () => {
    expect(args).toEqual([
      "exec",
      "--json",
      "-C",
      "/state/wt/1",
      "--dangerously-bypass-approvals-and-sandbox",
      "-c",
      "allow_login_shell=false",
      "-c",
      'mcp_servers.nightshift.command="/usr/local/bin/node"',
      "-c",
      'mcp_servers.nightshift.args=["/opt/nightshift/bin/nightshift-mcp.js"]',
      "-c",
      'mcp_servers.nightshift.env={"NIGHTSHIFT_ROLE" = "worker", "NIGHTSHIFT_EXECUTION_TOKEN" = "a.b\\"c\\\\d"}',
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--skip-git-repo-check",
      "-m",
      "gpt-5.5",
      "-- a brief that starts like a flag",
    ]);
  });

  it("can never stop for approval, and passes no list of what a worker may use", () => {
    expect(args).toContain("--dangerously-bypass-approvals-and-sandbox");
    const joined = args.join(" ");
    for (const absent of ["--sandbox", "approval_policy", "approval_mode", "--approve-for-me"]) {
      expect(joined, absent).not.toContain(absent);
    }
  });

  it("passes the launch through unchanged, quoting a name that needs it", () => {
    const overrides = mcpOverrides({ ...MCP, name: "night shift" });
    expect(overrides[1]).toBe('mcp_servers."night shift".command="/usr/local/bin/node"');
  });

  it("writes TOML that survives quotes, backslashes and newlines", () => {
    expect(tomlString('a"b\\c\nd')).toBe('"a\\"b\\\\c\\nd"');
    expect(tomlInlineTable({ "A-B": "1" })).toBe('{"A-B" = "1"}');
  });
});

describe("what a Codex worker is told", () => {
  it("that nothing asks for approval, and that git writes are the one exception", () => {
    const addendum = codexBriefAddendum({ mcpServerName: "nightshift" });
    expect(addendum).toContain("Nothing will ask for approval");
    expect(addendum).toContain("git command that writes state is refused");
    expect(addendum).toContain("job.complete");
  });
});

describe.skipIf(process.platform === "win32")("the git guard (rule 5)", () => {
  const dir = mkdtempSync(join(tmpdir(), "nightshift-guard-test-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  // A stand-in for the real git that says what it was given.
  const real = join(dir, "real-git");
  writeFileSync(real, '#!/bin/sh\necho "real:$*"\n');
  chmodSync(real, 0o700);
  const guard = join(dir, "git");
  writeFileSync(guard, buildGitGuard(real));
  chmodSync(guard, 0o700);

  const run = (args: readonly string[]): { code: number; out: string } => {
    try {
      return { code: 0, out: execFileSync(guard, [...args], { encoding: "utf8", stdio: "pipe" }) };
    } catch (error) {
      const failed = error as { status: number; stderr: string };
      return { code: failed.status, out: failed.stderr };
    }
  };

  it("hands read-only commands to the real git, arguments intact", () => {
    expect(run(["status", "--short"])).toEqual({ code: 0, out: "real:status --short\n" });
    expect(run(["-C", "/x", "log", "-1"]).out).toBe("real:-C /x log -1\n");
    expect(run(["diff", "--", "commit"]).out).toBe("real:diff -- commit\n");
    expect(run(["--version"]).code).toBe(0);
  });

  it("refuses every subcommand that writes state, with a sentence a model can act on", () => {
    for (const subcommand of FORBIDDEN_GIT_SUBCOMMANDS) {
      const result = run([subcommand]);
      expect(result.code, subcommand).toBe(126);
      expect(result.out, subcommand).toContain("Nightshift owns every commit");
    }
  });

  it("is not fooled by options in front of the subcommand", () => {
    expect(run(["-c", "user.name=x", "commit", "-m", "mine"]).code).toBe(126);
    expect(run(["--no-pager", "-C", "/somewhere", "push"]).code).toBe(126);
  });
});
