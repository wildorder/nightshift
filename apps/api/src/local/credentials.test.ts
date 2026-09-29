import { sign, verify } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadOrCreateKeys, loadOrCreateSecret } from "./credentials.js";

let dir = "";
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("the local instance's secrets (D-P12-03)", () => {
  it("makes the secret once and reads the same one back", () => {
    dir = mkdtempSync(join(tmpdir(), "nightshift-cred-"));
    const path = join(dir, "state", "token");
    const secret = loadOrCreateSecret(path);
    expect(secret.length).toBeGreaterThanOrEqual(32);
    expect(loadOrCreateSecret(path)).toBe(secret);
  });

  it("persists the signing key, so a token signed before a restart verifies after it", () => {
    dir = mkdtempSync(join(tmpdir(), "nightshift-cred-"));
    const path = join(dir, "signing-key.pem");
    const before = loadOrCreateKeys(path);
    const signature = sign("sha256", Buffer.from("header.payload"), before.privateKey);
    const after = loadOrCreateKeys(path);
    expect(verify("sha256", Buffer.from("header.payload"), after.publicKey, signature)).toBe(true);
  });
});
