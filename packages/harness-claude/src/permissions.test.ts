import { describe, expect, it } from "vitest";
import {
  claudeMcpToolName,
  claudeToolPolicy,
  FORBIDDEN_GIT_SUBCOMMANDS,
  gitWriteDenials,
} from "./permissions.js";

describe("the tool policy (owner's rulings, 2026-09-19 and 2026-10-09)", () => {
  it("is the same for every worker: bypassPermissions, and no list of what a worker may use", () => {
    const policy = claudeToolPolicy();
    expect(policy.permissionMode).toBe("bypassPermissions");
    // An allow-list is a guess at everything a worker will need, and a permission
    // list or a path scope is the same guess. There is none.
    expect(Object.keys(policy).sort()).toEqual(["denied", "permissionMode"]);
  });

  it("denies git writes unconditionally (A-29)", () => {
    expect(claudeToolPolicy().denied).toEqual(gitWriteDenials());
    expect(gitWriteDenials()).toHaveLength(FORBIDDEN_GIT_SUBCOMMANDS.length);
    for (const subcommand of ["commit", "add", "push", "reset", "checkout", "rebase"]) {
      expect(gitWriteDenials()).toContain(`Bash(git ${subcommand}:*)`);
    }
  });

  it("never denies a read-only git command: a worker must be able to see what it changed", () => {
    const denied = gitWriteDenials();
    for (const readOnly of ["status", "diff", "log", "show", "ls-files", "rev-parse", "blame"]) {
      expect(denied).not.toContain(`Bash(git ${readOnly}:*)`);
    }
  });
});

describe("MCP tool naming", () => {
  it("prefixes the server and replaces the dot, as the CLI does", () => {
    expect(claudeMcpToolName("nightshift", "job.complete")).toBe("mcp__nightshift__job_complete");
    expect(claudeMcpToolName("nightshift", "decision.record")).toBe(
      "mcp__nightshift__decision_record",
    );
  });

  it("leaves a name that needs no rewriting alone", () => {
    expect(claudeMcpToolName("ns", "job_get")).toBe("mcp__ns__job_get");
  });
});

describe("the denial list's shape", () => {
  it("uses a separator no list flag will split on", () => {
    // `--disallowedTools` accepts comma or space separation, and every pattern
    // here contains a space. Commas are what `buildClaudeArgs` joins with; a
    // pattern containing a comma would break that, so there must not be one.
    for (const pattern of gitWriteDenials()) expect(pattern).not.toContain(",");
  });
});
