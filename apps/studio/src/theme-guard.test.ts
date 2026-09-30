// @vitest-environment node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { findColours } from "./theme-guard";

const SRC = fileURLToPath(new URL(".", import.meta.url));

/**
 * Files not yet rebuilt on the theme (P13, T3 and T4). A ratchet: each rebuilt
 * page comes off, nothing goes on, and T5 holds the list empty.
 */
const NOT_YET_MIGRATED: readonly string[] = ["pages/decision.tsx", "pages/run.tsx"];

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });

describe("the theme guard (D-P13-02)", () => {
  it("finds no colour in src/ outside theme.css and components/ui/", () => {
    const findings = walk(SRC)
      .filter((file) => /\.(tsx?|css)$/.test(file) && !file.endsWith("theme-guard.test.ts"))
      .flatMap((file) =>
        findColours(relative(SRC, file).replace(/\\/g, "/"), readFileSync(file, "utf8")),
      );
    const outside = findings.filter((f) => !NOT_YET_MIGRATED.includes(f.path));
    expect(outside.map((f) => `${f.path}:${f.line} ${f.rule}: ${f.text}`)).toEqual([]);
    // A file on the list that no longer holds a colour comes off it.
    const clean = NOT_YET_MIGRATED.filter((path) => !findings.some((f) => f.path === path));
    expect(clean, "these are migrated; take them off NOT_YET_MIGRATED").toEqual([]);
  });

  it("catches each kind of colour, and allows tokens and non-colour hashes", () => {
    const flagged = (line: string) => findColours("pages/x.tsx", line).map((f) => f.rule);
    expect(flagged('className="text-slate-600"')).toEqual(["a Tailwind palette colour"]);
    expect(flagged('className="bg-white"')).toEqual(["a Tailwind palette colour"]);
    expect(flagged('style={{ color: "#fff" }}')).toEqual(["a hex colour"]);
    expect(flagged("color: oklch(0.5 0 0);")).toEqual(["a colour function"]);
    expect(flagged('className="bg-[#123456]"')).toContain("an arbitrary colour value");
    expect(flagged('className="bg-background text-muted-foreground border-border"')).toEqual([]);
    expect(flagged('className="bg-status-danger text-status-danger-foreground"')).toEqual([]);
    expect(flagged('href="#why" or "#token=abc"')).toEqual([]);
    expect(findColours("theme.css", "--x: oklch(1 0 0);")).toEqual([]);
    expect(findColours("components/ui/button.tsx", "bg-white")).toEqual([]);
  });
});
