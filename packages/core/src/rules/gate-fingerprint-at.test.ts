import { describe, expect, it } from "vitest";
import { GATE_LOCKFILES, gateFingerprint, gateFingerprintAt } from "./gate-fingerprint.js";

describe("gateFingerprintAt", () => {
  const hex = (bytes: Uint8Array): string =>
    Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
  const steps = { setup: [], verification: [{ id: "test", command: "npm test" }] };

  it("reads each machinery path, absent ones as absent, and every lockfile present", async () => {
    const tree: Record<string, string> = {
      "package.json": "{}",
      "package-lock.json": "lock",
      "uv.lock": "uv",
    };
    const asked: string[] = [];
    const read = async (path: string) => {
      asked.push(path);
      return tree[path] === undefined ? undefined : utf8(tree[path]);
    };
    const at = await gateFingerprintAt(
      { ...steps, machinery: ["package.json", "scripts/gone.mjs"] },
      read,
      hex,
    );
    expect(asked).toEqual(["package.json", "scripts/gone.mjs", ...GATE_LOCKFILES]);
    expect(at).toBe(
      gateFingerprint(
        {
          ...steps,
          files: [
            { path: "package.json", bytes: utf8("{}") },
            { path: "scripts/gone.mjs", bytes: undefined },
            { path: "package-lock.json", bytes: utf8("lock") },
            { path: "uv.lock", bytes: utf8("uv") },
          ],
        },
        hex,
      ),
    );
  });

  it("reads a lockfile named as machinery once", async () => {
    const asked: string[] = [];
    await gateFingerprintAt(
      { ...steps, machinery: ["package-lock.json"] },
      async (path) => {
        asked.push(path);
        return undefined;
      },
      hex,
    );
    expect(asked.filter((path) => path === "package-lock.json")).toHaveLength(1);
  });
});
