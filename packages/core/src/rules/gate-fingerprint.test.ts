import type { PrerequisiteId, SetupStep, VerificationStep } from "@nightshift/contracts";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type GateFile, type GateFingerprintInput, gateFingerprint } from "./gate-fingerprint.js";

/**
 * The hash is injected (`core` imports no `node:crypto`), so these tests stand
 * in a real sha256 with the hex of the canonical byte stream itself. That is
 * not a weaker double: it is injective, so it makes the encoding directly
 * legible — two fingerprints differ exactly when their canonical streams do,
 * which is exactly what the "encoding is unambiguous" cases below are testing.
 * A smoke test that `gateFingerprint` produces a real sha256 digest when wired
 * to `node:crypto` lives in `test/src/properties/gate-fingerprint.test.ts`.
 */
const identity = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const fingerprint = (input: GateFingerprintInput): string => gateFingerprint(input, identity);
const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

const install: SetupStep = { id: "install", command: "npm ci" };
const build: VerificationStep = { id: "build", command: "npm run build" };
const test: VerificationStep = { id: "test", command: "npm test" };
const lockfile: GateFile = { path: "package-lock.json", bytes: utf8('{"lockfileVersion":3}') };
const vitestConfig: GateFile = { path: "vitest.config.ts", bytes: utf8("export default {};") };

const base: GateFingerprintInput = {
  setup: [install],
  verification: [build, test],
  files: [lockfile, vitestConfig],
};

const prereq = (id: string): PrerequisiteId => id as PrerequisiteId;

describe("the gate fingerprint (D-P15-02)", () => {
  it("is deterministic", () => {
    expect(fingerprint(base)).toBe(fingerprint({ ...base, files: [...base.files] }));
  });

  it("counts the order of the gates", () => {
    expect(fingerprint({ ...base, verification: [test, build] })).not.toBe(fingerprint(base));
  });

  it("counts the order of setup", () => {
    const generate: SetupStep = { id: "generate", command: "npm run gen" };
    expect(fingerprint({ ...base, setup: [install, generate] })).not.toBe(
      fingerprint({ ...base, setup: [generate, install] }),
    );
  });

  it("tells a setup step from a gate with the same id and command", () => {
    const step = { id: "build", command: "npm run build" };
    const asSetup = fingerprint({ ...base, setup: [install, step], verification: [test] });
    const asGate = fingerprint({ ...base, setup: [install], verification: [step, test] });
    expect(asSetup).not.toBe(asGate);
    // The boundary between the lists counts too, not only membership.
    expect(fingerprint({ ...base, setup: [], verification: [build, test] })).not.toBe(
      fingerprint({ ...base, setup: [build], verification: [test] }),
    );
  });

  it("counts each step's id, command and requires", () => {
    const original = fingerprint(base);
    expect(fingerprint({ ...base, verification: [{ ...build, id: "compile" }, test] })).not.toBe(
      original,
    );
    expect(
      fingerprint({ ...base, verification: [{ ...build, command: "tsc -b" }, test] }),
    ).not.toBe(original);
    expect(
      fingerprint({ ...base, verification: [build, { ...test, requires: [prereq("P-01")] }] }),
    ).not.toBe(original);
  });

  it("does not count the order of requires", () => {
    const a = { ...test, requires: [prereq("P-01"), prereq("P-02")] };
    const b = { ...test, requires: [prereq("P-02"), prereq("P-01")] };
    expect(fingerprint({ ...base, verification: [build, a] })).toBe(
      fingerprint({ ...base, verification: [build, b] }),
    );
  });

  it("treats an absent requires as an empty one", () => {
    expect(fingerprint({ ...base, verification: [build, { ...test, requires: [] }] })).toBe(
      fingerprint(base),
    );
  });

  it("does not count a step's description", () => {
    expect(
      fingerprint({
        setup: [{ ...install, description: "install dependencies" }],
        verification: [{ ...build, description: "compile" }, test],
        files: base.files,
      }),
    ).toBe(fingerprint(base));
  });

  it("does not count the order of the files", () => {
    expect(fingerprint({ ...base, files: [vitestConfig, lockfile] })).toBe(fingerprint(base));
  });

  it("takes the same path listed twice with the same bytes as once", () => {
    const again: GateFile = { path: lockfile.path, bytes: Uint8Array.from(lockfile.bytes ?? []) };
    expect(fingerprint({ ...base, files: [lockfile, vitestConfig, again] })).toBe(
      fingerprint(base),
    );
    const absent: GateFile = { path: "Makefile", bytes: undefined };
    expect(fingerprint({ ...base, files: [absent, absent] })).toBe(
      fingerprint({ ...base, files: [absent] }),
    );
  });

  it("refuses the same path listed twice with different bytes", () => {
    const changed: GateFile = { path: lockfile.path, bytes: utf8("{}") };
    expect(() => fingerprint({ ...base, files: [lockfile, changed] })).toThrow(/listed twice/);
    const absent: GateFile = { path: lockfile.path, bytes: undefined };
    expect(() => fingerprint({ ...base, files: [lockfile, absent] })).toThrow(/listed twice/);
  });

  it("counts a file's path, and adding or removing a file", () => {
    const original = fingerprint(base);
    expect(
      fingerprint({ ...base, files: [lockfile, { ...vitestConfig, path: "vite.config.ts" }] }),
    ).not.toBe(original);
    expect(fingerprint({ ...base, files: [lockfile] })).not.toBe(original);
    expect(
      fingerprint({
        ...base,
        files: [...base.files, { path: "tsconfig.json", bytes: utf8("{}") }],
      }),
    ).not.toBe(original);
  });

  it("tells an absent file from an empty one, and from no file at all", () => {
    const absent = fingerprint({ ...base, files: [{ path: "Makefile", bytes: undefined }] });
    const empty = fingerprint({ ...base, files: [{ path: "Makefile", bytes: new Uint8Array() }] });
    const none = fingerprint({ ...base, files: [] });
    expect(absent).not.toBe(empty);
    expect(absent).not.toBe(none);
    expect(empty).not.toBe(none);
  });

  describe("its encoding is unambiguous", () => {
    it("does not let a boundary shift between id and command", () => {
      expect(fingerprint({ ...base, verification: [{ id: "ab", command: "c" }] })).not.toBe(
        fingerprint({ ...base, verification: [{ id: "a", command: "bc" }] }),
      );
    });

    it("does not let a boundary shift between steps", () => {
      expect(
        fingerprint({
          ...base,
          verification: [
            { id: "a", command: "x\ny" },
            { id: "z", command: "w" },
          ],
        }),
      ).not.toBe(
        fingerprint({
          ...base,
          verification: [
            { id: "a", command: "x" },
            { id: "y", command: "z\nw" },
          ],
        }),
      );
    });

    it("does not let a path holding a newline pose as two fields", () => {
      const joined: GateFile = { path: "a\nb", bytes: utf8("c") };
      const split: GateFile = { path: "a", bytes: utf8("b\nc") };
      expect(fingerprint({ ...base, files: [joined] })).not.toBe(
        fingerprint({ ...base, files: [split] }),
      );
    });

    it("does not let a boundary shift between a path and its bytes", () => {
      expect(fingerprint({ ...base, files: [{ path: "ab", bytes: utf8("c") }] })).not.toBe(
        fingerprint({ ...base, files: [{ path: "a", bytes: utf8("bc") }] }),
      );
    });

    it("does not let requires blur into the next step", () => {
      expect(
        fingerprint({
          ...base,
          verification: [{ id: "a", command: "x", requires: [prereq("P-01")] }],
        }),
      ).not.toBe(
        fingerprint({
          ...base,
          verification: [
            { id: "a", command: "x" },
            { id: "P-01", command: "x" },
          ],
        }),
      );
    });
  });

  describe("as properties", () => {
    const fileArb = fc.record({
      path: fc.string({ minLength: 1, maxLength: 12 }),
      bytes: fc.option(fc.uint8Array({ maxLength: 24 }), { nil: undefined }),
    });
    const distinctFiles = fc.uniqueArray(fileArb, {
      selector: (file) => file.path,
      minLength: 1,
      maxLength: 8,
    });

    it("does not depend on the order of the files", () => {
      fc.assert(
        fc.property(
          distinctFiles.chain((files) =>
            fc.tuple(fc.constant(files), fc.shuffledSubarray(files, { minLength: files.length })),
          ),
          ([files, shuffled]) => {
            expect(fingerprint({ ...base, files: shuffled })).toBe(fingerprint({ ...base, files }));
          },
        ),
      );
    });

    it("changes when any single byte of any file changes", () => {
      fc.assert(
        fc.property(
          distinctFiles.filter((files) => files.some((file) => (file.bytes?.length ?? 0) > 0)),
          fc.nat(),
          fc.nat(),
          fc.integer({ min: 1, max: 255 }),
          (files, pick, at, delta) => {
            const present = files.filter((file) => (file.bytes?.length ?? 0) > 0);
            const target = present[pick % present.length] as GateFile;
            const bytes = Uint8Array.from(target.bytes ?? []);
            const index = at % bytes.length;
            bytes[index] = ((bytes[index] ?? 0) + delta) % 256;
            const changed = files.map((file) =>
              file === target ? { path: file.path, bytes } : file,
            );
            expect(fingerprint({ ...base, files: changed })).not.toBe(
              fingerprint({ ...base, files }),
            );
          },
        ),
      );
    });
  });
});
