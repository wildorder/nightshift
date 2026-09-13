import type { Scope, ScopeRequest } from "@nightshift/contracts";
import { describe, expect, it } from "vitest";
import { ScopeWideningError } from "../errors.js";
import {
  explainWidening,
  globContains,
  globMatchesPath,
  inheritScope,
  isNarrowing,
  narrow,
  scopeAllowsPath,
} from "./scope.js";

const parent: Scope = {
  includes: ["src/**", "migrations/**"],
  excludes: ["src/generated/**"],
  permissions: ["fs.read", "fs.write", "shell.exec"],
  forbiddenActions: ["deploy to production"],
};

describe("globContains", () => {
  it.each([
    ["src/**", "src/**"],
    ["src/**", "src/billing/**"],
    ["src/**", "src/billing/invoice.ts"],
    ["src/**", "src"],
    ["**", "anything/at/all"],
    ["src/*/models/**", "src/billing/models/**"],
    ["src/*", "src/billing"],
    ["src/**/*.ts", "src/a/b/c.ts"],
  ])("accepts %s containing %s", (outer, inner) => {
    expect(globContains(outer, inner)).toBe(true);
  });

  it.each([
    ["src/billing/**", "src/**"],
    ["src/**", "test/**"],
    ["src/*", "src/billing/**"],
    ["src/*", "src/billing/models"],
    ["src/billing/invoice.ts", "src/billing/**"],
    ["migrations/**", "src/migrations/**"],
  ])("rejects %s containing %s", (outer, inner) => {
    expect(globContains(outer, inner)).toBe(false);
  });
});

describe("narrow", () => {
  it("inherits omitted fields unchanged", () => {
    const result = narrow(parent, { includes: ["src/billing/**"] });
    expect(result).toEqual({
      includes: ["src/billing/**"],
      excludes: parent.excludes,
      permissions: parent.permissions,
      forbiddenActions: parent.forbiddenActions,
    });
  });

  it("accepts an exact re-statement of the parent", () => {
    expect(narrow(parent, { ...parent })).toEqual(parent);
  });

  it("accepts dropping permissions", () => {
    const result = narrow(parent, { includes: ["src/**"], permissions: ["fs.read"] });
    expect(result.permissions).toEqual(["fs.read"]);
  });

  it("accepts adding excludes and forbidden actions", () => {
    const result = narrow(parent, {
      includes: ["src/**"],
      excludes: ["src/generated/**", "src/vendor/**"],
      forbiddenActions: ["deploy to production", "rewrite history"],
    });
    expect(result.excludes).toContain("src/vendor/**");
    expect(result.forbiddenActions).toContain("rewrite history");
  });

  // SC-P1-10 — the headline invariant.
  it("rejects an include outside the parent's includes", () => {
    expect(() => narrow(parent, { includes: ["test/**"] })).toThrow(ScopeWideningError);
  });

  it("rejects broadening an include", () => {
    const narrowParent: Scope = { ...parent, includes: ["src/billing/**"] };
    expect(() => narrow(narrowParent, { includes: ["src/**"] })).toThrow(ScopeWideningError);
  });

  it("rejects dropping a parent exclude", () => {
    expect(() => narrow(parent, { includes: ["src/**"], excludes: [] })).toThrow(
      ScopeWideningError,
    );
  });

  it("rejects claiming a permission the parent lacks", () => {
    expect(() => narrow(parent, { includes: ["src/**"], permissions: ["net.fetch"] })).toThrow(
      ScopeWideningError,
    );
  });

  it("rejects dropping a parent forbidden action", () => {
    expect(() => narrow(parent, { includes: ["src/**"], forbiddenActions: [] })).toThrow(
      ScopeWideningError,
    );
  });

  it("reports every widening at once, not just the first", () => {
    const request: ScopeRequest = {
      includes: ["test/**", "docs/**"],
      permissions: ["net.fetch"],
      forbiddenActions: [],
    };
    const reasons = explainWidening(parent, request);
    expect(reasons).toHaveLength(4);
    expect(reasons.join(" ")).toContain("test/**");
    expect(reasons.join(" ")).toContain("docs/**");
    expect(reasons.join(" ")).toContain("net.fetch");
    expect(reasons.join(" ")).toContain("deploy to production");
  });

  it("carries the reasons on the thrown error", () => {
    try {
      narrow(parent, { includes: ["test/**"] });
      expect.unreachable("narrow should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ScopeWideningError);
      expect((error as ScopeWideningError).reasons).toHaveLength(1);
      expect((error as ScopeWideningError).code).toBe("scope_widening");
    }
  });

  it("allows a child whose effective scope is empty", () => {
    // Narrowing to a path the parent excludes is a legal narrowing, not a widening.
    expect(isNarrowing(parent, { includes: ["src/generated/**"] })).toBe(true);
  });
});

describe("inheritScope", () => {
  it("copies rather than aliases", () => {
    const inherited = inheritScope(parent);
    expect(inherited).toEqual(parent);
    expect(inherited.includes).not.toBe(parent.includes);
  });
});

describe("globMatchesPath", () => {
  it.each([
    ["src/**", "src/a/b.ts", true],
    ["src/**", "src", true],
    ["src/*", "src/a.ts", true],
    ["src/*", "src/a/b.ts", false],
    ["src/**/*.ts", "src/a/b.ts", true],
    ["src/**/*.ts", "src/a/b.js", false],
    ["src/?.ts", "src/a.ts", true],
    ["src/?.ts", "src/ab.ts", false],
    ["test/**", "src/a.ts", false],
  ])("%s against %s is %s", (glob, path, expected) => {
    expect(globMatchesPath(glob, path)).toBe(expected);
  });
});

describe("scopeAllowsPath", () => {
  it("allows an included path", () => {
    expect(scopeAllowsPath(parent, "src/billing/invoice.ts")).toBe(true);
  });

  it("refuses a path outside every include", () => {
    expect(scopeAllowsPath(parent, "test/billing.test.ts")).toBe(false);
  });

  it("lets an exclude override an include", () => {
    expect(scopeAllowsPath(parent, "src/generated/client.ts")).toBe(false);
  });
});
