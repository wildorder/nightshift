// @vitest-environment node
/**
 * The Studio restyles from `theme.css` alone (P13, SC-P13-02).
 *
 * Tailwind's own compiler runs over the real stylesheet twice: once as it is,
 * once with a different primary colour, radius and danger tone in `theme.css`
 * and nothing else changed. The utilities the pages use compile to references
 * to the theme's variables, never to a colour, so the second compile changes
 * the theme's values and leaves every utility exactly as it was: the whole
 * Studio follows one file.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "@tailwindcss/node";
import { describe, expect, it } from "vitest";

const SRC = dirname(fileURLToPath(import.meta.url));
const INDEX = readFileSync(join(SRC, "index.css"), "utf8");
const THEME = readFileSync(join(SRC, "theme.css"), "utf8");

/** Utilities the pages lean on: surfaces, text, borders, radius, a status tone. */
const CANDIDATES = [
  "bg-primary",
  "text-primary-foreground",
  "bg-card",
  "text-muted-foreground",
  "border-border",
  "rounded-lg",
  "bg-status-danger",
  "text-status-danger-foreground",
];

const build = async (theme: string): Promise<string> => {
  const dir = mkdtempSync(join(tmpdir(), "nightshift-theme-"));
  const themePath = join(dir, "theme.css");
  writeFileSync(themePath, theme);
  const compiler = await compile(INDEX, {
    base: SRC,
    onDependency: () => {},
    customCssResolver: async (id) => (id === "./theme.css" ? themePath : undefined),
  });
  return compiler.build(CANDIDATES);
};

/** The rule for one utility, as compiled. */
const ruleOf = (css: string, selector: string): string => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\.${escaped}\\s*\\{[^}]*\\}`).exec(css)?.[0] ?? "";
};

describe("restyling from theme.css alone (SC-P13-02)", () => {
  it("compiles every utility to a reference to the theme, never to a colour", async () => {
    const css = await build(THEME);
    expect(ruleOf(css, "bg-primary")).toContain("var(--primary)");
    expect(ruleOf(css, "text-status-danger-foreground")).toContain(
      "var(--status-danger-foreground)",
    );
    expect(ruleOf(css, "rounded-lg")).toContain("var(--radius)");
    for (const candidate of CANDIDATES) {
      const rule = ruleOf(css, candidate);
      expect(rule, candidate).not.toBe("");
      expect(rule, candidate).not.toMatch(/oklch\(|#[0-9a-f]{3,8}\b|rgb\(/);
    }
  });

  it("follows a changed primary, radius and danger tone, with no utility changed", async () => {
    const before = await build(THEME);
    const edited = THEME.replace("--primary: oklch(0.205 0 0);", "--primary: oklch(0.55 0.2 290);")
      .replace("--radius: 0.625rem;", "--radius: 0rem;")
      .replace("--status-danger: oklch(0.94 0.04 25);", "--status-danger: oklch(0.9 0.1 330);");
    expect(edited).not.toBe(THEME);
    const after = await build(edited);

    expect(after).toContain("--primary: oklch(0.55 0.2 290)");
    expect(after).toContain("--radius: 0rem");
    expect(after).toContain("--status-danger: oklch(0.9 0.1 330)");
    expect(after).not.toContain("--primary: oklch(0.205 0 0)");
    for (const candidate of CANDIDATES) {
      expect(ruleOf(after, candidate), candidate).toBe(ruleOf(before, candidate));
    }
  });
});
