import type { Scope } from "@nightshift/contracts";
import { describe, expect, it } from "vitest";
import { checkChangedPaths, describeScopeViolation } from "./scope-check.js";

const scope = (overrides: Partial<Scope> = {}): Scope => ({
  includes: ["src/**"],
  excludes: ["src/generated/**"],
  permissions: ["fs.read", "fs.write"],
  forbiddenActions: [],
  ...overrides,
});

describe("the scope check at commit", () => {
  it("allows a change inside the scope", () => {
    expect(checkChangedPaths(scope(), ["src/math/median.ts"])).toEqual({
      allowed: true,
      offending: [],
    });
  });

  it("allows an empty change set: a worker may correctly change nothing", () => {
    expect(checkChangedPaths(scope(), []).allowed).toBe(true);
  });

  it("refuses a change no include covers", () => {
    const result = checkChangedPaths(scope(), ["src/ok.ts", "docs/readme.md"]);
    expect(result.allowed).toBe(false);
    expect(result.offending).toEqual(["docs/readme.md"]);
  });

  it("refuses a change an exclude knocks out, even though an include covers it", () => {
    // An exclude is authority, not a hint: it always wins.
    const result = checkChangedPaths(scope(), ["src/generated/schema.ts"]);
    expect(result.allowed).toBe(false);
    expect(result.offending).toEqual(["src/generated/schema.ts"]);
  });

  it("reports every offender, not the first", () => {
    const result = checkChangedPaths(scope(), [
      "src/ok.ts",
      "docs/a.md",
      "package.json",
      "src/generated/b.ts",
    ]);
    expect(result.offending).toEqual(["docs/a.md", "package.json", "src/generated/b.ts"]);
  });

  it("keeps the order git reported, so a reader can match it to a diff", () => {
    const result = checkChangedPaths(scope(), ["z.md", "a.md"]);
    expect(result.offending).toEqual(["z.md", "a.md"]);
  });

  /**
   * A rename out of scope is reported by `changedPaths` as a deletion and an
   * addition (`--no-renames`), so the destination is visible here. This is the
   * check that makes that choice matter.
   */
  it("catches a file moved out of scope", () => {
    const result = checkChangedPaths(scope(), ["src/math/median.ts", "vendor/median.ts"]);
    expect(result.offending).toEqual(["vendor/median.ts"]);
  });

  it("names every offending path in the reason a human reads", () => {
    const reason = describeScopeViolation(["docs/a.md", "package.json"]);
    expect(reason).toContain("docs/a.md");
    expect(reason).toContain("package.json");
    expect(reason).toContain("outside the job's effective scope");
  });

  it("narrows with the scope: what one node may touch, a narrower one may not", () => {
    const narrow = scope({ includes: ["src/math/**"] });
    expect(checkChangedPaths(narrow, ["src/math/median.ts"]).allowed).toBe(true);
    expect(checkChangedPaths(narrow, ["src/http/client.ts"]).allowed).toBe(false);
  });
});
