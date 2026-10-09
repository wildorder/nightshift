import { describe, expect, it } from "vitest";
import { globContains, globMatchesPath, globSetMatchesPath, uncoveredGlobs } from "./globs.js";

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

describe("uncoveredGlobs", () => {
  it("is empty when every inner glob lies inside an outer one", () => {
    expect(
      uncoveredGlobs(["src/**", "migrations/**"], ["src/billing/**", "migrations/0001.sql"]),
    ).toEqual([]);
  });

  it("names the globs no outer glob contains", () => {
    expect(uncoveredGlobs(["src/**"], ["src/billing/**", "test/**", "docs/*.md"])).toEqual([
      "test/**",
      "docs/*.md",
    ]);
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

describe("globSetMatchesPath", () => {
  const globs = { includes: ["src/**", "migrations/**"], excludes: ["src/generated/**"] };

  it("matches an included path", () => {
    expect(globSetMatchesPath(globs, "src/billing/invoice.ts")).toBe(true);
  });

  it("does not match a path outside every include", () => {
    expect(globSetMatchesPath(globs, "test/billing.test.ts")).toBe(false);
  });

  it("lets an exclude override an include", () => {
    expect(globSetMatchesPath(globs, "src/generated/client.ts")).toBe(false);
  });
});
