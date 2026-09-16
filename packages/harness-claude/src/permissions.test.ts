import type { Scope } from "@nightshift/contracts";
import { WORKER_PERMISSIONS } from "@nightshift/core";
import { describe, expect, it } from "vitest";
import {
  claudeMcpToolName,
  claudeToolPolicy,
  FORBIDDEN_GIT_SUBCOMMANDS,
  gitWriteDenials,
  PLANNING_TOOLS,
  READ_TOOLS,
  SHELL_TOOLS,
  SUBAGENT_TOOLS,
  WRITE_TOOLS,
} from "./permissions.js";

const scopeWith = (permissions: readonly string[]): Scope => ({
  includes: ["src/**"],
  excludes: [],
  permissions: [...permissions],
  forbiddenActions: [],
});

const policyFor = (permissions: readonly string[]) =>
  claudeToolPolicy({ scope: scopeWith(permissions), mcpServerName: "nightshift" });

/** Every subset of the three-permission vocabulary. Eight of them, by construction. */
const subsets = (): readonly (readonly string[])[] => {
  const all = WORKER_PERMISSIONS;
  const result: string[][] = [];
  for (let mask = 0; mask < 1 << all.length; mask += 1) {
    const subset: string[] = [];
    for (const [index, permission] of all.entries()) {
      if ((mask & (1 << index)) !== 0) subset.push(permission);
    }
    result.push(subset);
  }
  return result;
};

/** Which permission each built-in tool depends on. Nothing is granted without it. */
const GATED_BY: readonly (readonly [string, readonly string[]])[] = [
  ["fs.read", [...READ_TOOLS, ...PLANNING_TOOLS, ...SUBAGENT_TOOLS]],
  ["fs.write", WRITE_TOOLS],
  ["shell.exec", SHELL_TOOLS],
];

describe("the permission vocabulary, every subset (D-P3-15)", () => {
  it("enumerates exactly eight subsets", () => {
    expect(subsets()).toHaveLength(8);
  });

  it.each(
    subsets().map((permissions) => [permissions.join("+") || "(none)", permissions] as const),
  )("maps %s to the tools that permission names and nothing more", (_label, permissions) => {
    const policy = policyFor(permissions);
    const expected = new Set<string>();
    if (permissions.includes("fs.read")) {
      for (const tool of [...READ_TOOLS, ...PLANNING_TOOLS, ...SUBAGENT_TOOLS]) expected.add(tool);
    }
    if (permissions.includes("fs.write")) for (const tool of WRITE_TOOLS) expected.add(tool);
    if (permissions.includes("shell.exec")) for (const tool of SHELL_TOOLS) expected.add(tool);
    expect(new Set(policy.tools)).toEqual(expected);
    expect(policy.granted).toEqual(permissions);
  });

  it.each(
    subsets().map((permissions) => [permissions.join("+") || "(none)", permissions] as const),
  )(
    "never grants a write tool without fs.write, or a shell tool without shell.exec, for %s",
    (_label, permissions) => {
      const policy = policyFor(permissions);
      for (const [permission, tools] of GATED_BY) {
        if (permissions.includes(permission)) continue;
        for (const tool of tools) {
          expect(policy.tools, `${tool} was granted without ${permission}`).not.toContain(tool);
        }
      }
    },
  );

  it.each(
    subsets().map((permissions) => [permissions.join("+") || "(none)", permissions] as const),
  )("denies every git write command for %s, whatever the scope granted", (_label, permissions) => {
    const policy = policyFor(permissions);
    expect(policy.denied).toEqual(gitWriteDenials());
    for (const subcommand of FORBIDDEN_GIT_SUBCOMMANDS) {
      expect(policy.denied).toContain(`Bash(git ${subcommand}:*)`);
    }
  });

  it.each(
    subsets().map((permissions) => [permissions.join("+") || "(none)", permissions] as const),
  )(
    "always leaves the worker able to reach its own Nightshift tools, for %s",
    (_label, permissions) => {
      // The one thing a worker must always be able to do is end its job. Without
      // the MCP prefix in `--allowedTools`, `--permission-prompts none` would
      // deny `job.complete` and no job could ever finish well.
      expect(policyFor(permissions).allowed).toContain("mcp__nightshift");
    },
  );

  it("pre-approves exactly the built-in tools it granted, so a granted tool never prompts", () => {
    const policy = policyFor(["fs.read", "fs.write"]);
    for (const tool of policy.tools) expect(policy.allowed).toContain(tool);
    expect(policy.allowed).toHaveLength(policy.tools.length + 1);
  });

  it("gives a scope that granted nothing no built-in tool at all", () => {
    // Verified on 2.1.273: `--tools ""` disables every built-in tool and leaves
    // the `--mcp-config` server's tools in place, so a worker with no
    // permissions can still end its own job and do nothing else.
    expect(policyFor([]).tools).toEqual([]);
    expect(policyFor([]).allowed).toEqual(["mcp__nightshift"]);
  });

  it("chooses the narrower permission mode when no write permission was granted", () => {
    expect(policyFor([]).permissionMode).toBe("manual");
    expect(policyFor(["fs.read"]).permissionMode).toBe("manual");
    expect(policyFor(["shell.exec"]).permissionMode).toBe("manual");
    expect(policyFor(["fs.write"]).permissionMode).toBe("acceptEdits");
  });

  it("never denies a read-only git command: a worker must be able to see what it changed", () => {
    const denied = gitWriteDenials();
    for (const readOnly of ["status", "diff", "log", "show", "ls-files", "rev-parse", "blame"]) {
      expect(denied).not.toContain(`Bash(git ${readOnly}:*)`);
    }
  });
});

describe("an unrecognised permission", () => {
  it("grants nothing and is reported rather than silently dropped", () => {
    const policy = policyFor(["fs.read", "kubernetes.apply", "aws.assume-role"]);
    expect(policy.granted).toEqual(["fs.read"]);
    expect(policy.unknown).toEqual(["kubernetes.apply", "aws.assume-role"]);
    expect(new Set(policy.tools)).toEqual(
      new Set([...READ_TOOLS, ...PLANNING_TOOLS, ...SUBAGENT_TOOLS]),
    );
  });

  it("cannot smuggle a tool in by spelling itself like one", () => {
    expect(policyFor(["Bash", "shell.exec.all", "fs.write "]).tools).toEqual([]);
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
