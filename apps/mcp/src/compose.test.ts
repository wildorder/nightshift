/**
 * The composition root's one piece of pure logic.
 *
 * Everything else `compose.ts` does is wiring, and the slice suite proves that
 * by running the real binary. This is the exception: a rule about specifiers
 * whose Windows half cannot be observed on a POSIX machine, and which CI found
 * the hard way — the scripted harness is handed an absolute path through
 * `NIGHTSHIFT_HARNESS_MODULE`, and on Windows `await import()` refuses it.
 */
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { harnessModuleSpecifier } from "./compose.js";

describe("harnessModuleSpecifier", () => {
  it("turns a Windows absolute path into a file:// URL", () => {
    // Stated as a literal rather than built from `process.platform`, so this
    // assertion holds on the machine of whoever is reading it.
    const specifier = harnessModuleSpecifier("C:\\work\\nightshift\\test\\dist\\scripted.js");
    expect(specifier.startsWith("file:///")).toBe(true);
    expect(specifier).toContain("scripted.js");
    // Never the bare path: `C:` would be read as a URL scheme.
    expect(specifier.startsWith("C:")).toBe(false);
  });

  it("turns a POSIX absolute path into a file:// URL too", () => {
    expect(harnessModuleSpecifier("/work/nightshift/test/dist/scripted.js")).toBe(
      pathToFileURL("/work/nightshift/test/dist/scripted.js").href,
    );
  });

  it("converts a relative path, which import() resolves against this module otherwise", () => {
    expect(harnessModuleSpecifier("./scripted.js").startsWith("file://")).toBe(true);
    expect(harnessModuleSpecifier("../scripted.js").startsWith("file://")).toBe(true);
  });

  it("leaves a bare package name exactly as written", () => {
    // The other legitimate form: a harness published as a package.
    expect(harnessModuleSpecifier("@nightshift/harness-codex")).toBe("@nightshift/harness-codex");
    expect(harnessModuleSpecifier("some-harness")).toBe("some-harness");
  });
});
