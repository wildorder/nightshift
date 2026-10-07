/**
 * D-P15-02 — the gate fingerprint, wired to a real sha256.
 *
 * `packages/core`'s own tests (`gate-fingerprint.test.ts`) stand in the hash
 * with the hex of the canonical byte stream itself, because `core` imports no
 * `node:crypto` (architecture rule AR-1). That proves every behaviour of
 * `gateFingerprint` the injected hash can see. What it cannot see is that the
 * production wiring — a real sha256 — actually produces the digest a plan
 * record is compared against. That lives here, where `node:crypto` is allowed.
 */
import { createHash } from "node:crypto";
import type { SetupStep, VerificationStep } from "@nightshift/contracts";
import { type GateFile, type GateFingerprintInput, gateFingerprint } from "@nightshift/core";
import { describe, expect, it } from "vitest";

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const install: SetupStep = { id: "install", command: "npm ci" };
const build: VerificationStep = { id: "build", command: "npm run build" };
const test: VerificationStep = { id: "test", command: "npm test" };
const lockfile: GateFile = {
  path: "package-lock.json",
  bytes: new TextEncoder().encode('{"lockfileVersion":3}'),
};

const base: GateFingerprintInput = {
  setup: [install],
  verification: [build, test],
  files: [lockfile],
};

describe("gateFingerprint wired to a real sha256", () => {
  it("is a deterministic, lowercase 64-character hex digest", () => {
    const first = gateFingerprint(base, sha256);
    const second = gateFingerprint({ ...base, files: [...base.files] }, sha256);
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when the gates change, under the real hash too", () => {
    expect(gateFingerprint({ ...base, verification: [test, build] }, sha256)).not.toBe(
      gateFingerprint(base, sha256),
    );
  });
});
