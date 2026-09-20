import type { Scope } from "@nightshift/contracts";
import { WORKER_PERMISSIONS } from "@nightshift/core";
import { describe, expect, it } from "vitest";
import {
  claudeMcpToolName,
  claudeToolPolicy,
  FORBIDDEN_GIT_SUBCOMMANDS,
  gitWriteDenials,
} from "./permissions.js";

const scopeWith = (permissions: readonly string[]): Scope => ({
  includes: ["src/**"],
  excludes: [],
  permissions: [...permissions],
  forbiddenActions: [],
});

const policyFor = (permissions: readonly string[]) =>
  claudeToolPolicy({ scope: scopeWith(permissions) });

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

describe("the tool policy, for every subset of the vocabulary (owner's ruling, 2026-09-19)", () => {
  it("enumerates exactly eight subsets", () => {
    expect(subsets()).toHaveLength(8);
  });

  it("is the same for all of them: bypassPermissions, and no list of what a worker may use", () => {
    for (const permissions of subsets()) {
      const policy = policyFor(permissions);
      expect(policy.permissionMode, permissions.join("+")).toBe("bypassPermissions");
      // An allow-list is a guess at everything a worker will need. There is none.
      expect(Object.keys(policy).sort()).toEqual([
        "denied",
        "granted",
        "permissionMode",
        "unknown",
      ]);
    }
  });

  it("denies git writes unconditionally, whatever the scope says (A-29)", () => {
    for (const permissions of subsets()) {
      expect(policyFor(permissions).denied).toEqual(gitWriteDenials());
    }
    expect(gitWriteDenials()).toHaveLength(FORBIDDEN_GIT_SUBCOMMANDS.length);
    for (const subcommand of ["commit", "add", "push", "reset", "checkout", "rebase"]) {
      expect(gitWriteDenials()).toContain(`Bash(git ${subcommand}:*)`);
    }
  });

  it("still reports what the scope named, which the brief tells the worker", () => {
    expect(policyFor(["shell.exec", "fs.read"]).granted).toEqual(["fs.read", "shell.exec"]);
    expect(policyFor([]).granted).toEqual([]);
  });

  it("never denies a read-only git command: a worker must be able to see what it changed", () => {
    const denied = gitWriteDenials();
    for (const readOnly of ["status", "diff", "log", "show", "ls-files", "rev-parse", "blame"]) {
      expect(denied).not.toContain(`Bash(git ${readOnly}:*)`);
    }
  });
});

describe("an unrecognised permission", () => {
  it("is reported rather than silently dropped, and changes nothing else", () => {
    const policy = policyFor(["fs.read", "kubernetes.apply"]);
    expect(policy.unknown).toEqual(["kubernetes.apply"]);
    expect(policy.granted).toEqual(["fs.read"]);
    expect(policy.denied).toEqual(gitWriteDenials());
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
