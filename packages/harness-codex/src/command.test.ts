import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Scope } from "@nightshift/contracts";
import type { McpLaunch } from "@nightshift/harness";
import { afterAll, describe, expect, it } from "vitest";
import {
  buildCodexArgs,
  buildGitGuard,
  codexBriefAddendum,
  codexSandboxFor,
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

const scopeWith = (permissions: readonly string[]): Scope => ({
  includes: ["src/**"],
  excludes: [],
  permissions: [...permissions],
  forbiddenActions: [],
});

describe("the command line (D-P5-02)", () => {
  const args = buildCodexArgs({
    prompt: "-- a brief that starts like a flag",
    model: { harness: "codex", provider: "openai", model: "gpt-5.5" },
    worktree: "/state/wt/1",
    sandbox: "workspace-write",
    mcp: MCP,
  });

  it("is exactly the verified one, in order", () => {
    expect(args).toEqual([
      "exec",
      "--json",
      "-C",
      "/state/wt/1",
      "--sandbox",
      "workspace-write",
      "-c",
      'approval_policy="never"',
      "-c",
      "allow_login_shell=false",
      "-c",
      'mcp_servers.nightshift.command="/usr/local/bin/node"',
      "-c",
      'mcp_servers.nightshift.args=["/opt/nightshift/bin/nightshift-mcp.js"]',
      "-c",
      'mcp_servers.nightshift.env={"NIGHTSHIFT_ROLE" = "worker", "NIGHTSHIFT_EXECUTION_TOKEN" = "a.b\\"c\\\\d"}',
      "-c",
      'mcp_servers.nightshift.default_tools_approval_mode="approve"',
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--skip-git-repo-check",
      "-m",
      "gpt-5.5",
      "-- a brief that starts like a flag",
    ]);
  });

  it("never lets a model or a human decide an approval at run time", () => {
    expect(args).not.toContain("--approve-for-me");
    expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(args.join(" ")).not.toContain("danger-full-access");
  });

  it("pre-approves the Nightshift server's tools and no other server's", () => {
    const approvals = args.filter((arg) => arg.includes("approval_mode"));
    expect(approvals).toEqual(['mcp_servers.nightshift.default_tools_approval_mode="approve"']);
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

describe("the sandbox", () => {
  it("is workspace-write only when fs.write is granted", () => {
    expect(codexSandboxFor(scopeWith(["fs.read", "fs.write", "shell.exec"]))).toBe(
      "workspace-write",
    );
    expect(codexSandboxFor(scopeWith(["fs.read"]))).toBe("read-only");
    expect(codexSandboxFor(scopeWith([]))).toBe("read-only");
  });

  it("tells the worker which one it has, and that nothing will be approved", () => {
    const writable = codexBriefAddendum({
      mcpServerName: "nightshift",
      sandbox: "workspace-write",
    });
    expect(writable).toContain("write inside your working directory");
    expect(writable).toContain("job.complete");
    expect(codexBriefAddendum({ mcpServerName: "nightshift", sandbox: "read-only" })).toContain(
      "you may not write",
    );
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
