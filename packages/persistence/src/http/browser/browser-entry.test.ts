/**
 * The browser entry stays browser-safe (P11, D-P11-07).
 *
 * Walks every relative import reachable from `browser/index.ts` and refuses a
 * Node builtin (`node:*` or a bare builtin name) and any use of `Buffer`. A
 * regex over raw text, as the architecture rules are: it over-reports rather
 * than under-reports, which is the right way round for a guarantee.
 */
import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const ENTRY = resolve(here, "index.ts");

const specifiersOf = (text: string): string[] =>
  [...text.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((m) => m[1] ?? "");

/** Every file reachable from the entry through relative imports. */
const reachable = (entry: string): Map<string, string> => {
  const seen = new Map<string, string>();
  const visit = (file: string): void => {
    if (seen.has(file)) return;
    const text = readFileSync(file, "utf8");
    seen.set(file, text);
    for (const spec of specifiersOf(text)) {
      if (!spec.startsWith(".")) continue;
      visit(resolve(dirname(file), spec.replace(/\.js$/, ".ts")));
    }
  };
  visit(entry);
  return seen;
};

const builtins = new Set(builtinModules);

describe("the browser entry", () => {
  const files = reachable(ENTRY);

  it("reaches the stores, the transport and the routes", () => {
    const names = [...files.keys()];
    expect(names.some((n) => n.endsWith("stores.ts"))).toBe(true);
    expect(names.some((n) => n.endsWith("transport.ts"))).toBe(true);
    expect(names.some((n) => n.endsWith("routes.ts"))).toBe(true);
  });

  it("imports no Node builtin anywhere in its graph", () => {
    const offenders: string[] = [];
    for (const [file, text] of files) {
      for (const spec of specifiersOf(text)) {
        if (spec.startsWith("node:") || builtins.has(spec)) offenders.push(`${file}: ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("never touches Node's byte buffer class", () => {
    // Spelled without naming it, or this file would flag itself.
    const cls = ["Buf", "fer"].join("");
    const offenders = [...files]
      .filter(([, text]) => new RegExp(`\\b${cls}\\b`).test(text))
      .map(([f]) => f);
    expect(offenders).toEqual([]);
  });

  it("never reaches the session or the artifact body store", () => {
    const names = [...files.keys()];
    expect(names.some((n) => n.includes("/session/"))).toBe(false);
    expect(names.some((n) => n.endsWith("artifact-bodies.ts"))).toBe(false);
    expect(names.some((n) => n.endsWith("planning.ts"))).toBe(false);
  });
});
