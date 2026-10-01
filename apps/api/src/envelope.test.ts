/**
 * Envelope encryption for an org's secrets (P10, D-P10-23).
 */
import type { OrgId } from "@nightshift/contracts";
import { describe, expect, it } from "vitest";
import { createLocalEnvelope, generateMasterKey } from "./envelope.js";

const ORG_A = "org_00000000000000000000000001" as OrgId;
const ORG_B = "org_00000000000000000000000002" as OrgId;

describe("the local envelope", () => {
  it("seals and opens under the org and the provider, with a fresh data key each time", async () => {
    const envelope = createLocalEnvelope(generateMasterKey());
    const first = await envelope.seal(ORG_A, "anthropic", "sk-ant-secret-1234");
    const second = await envelope.seal(ORG_A, "anthropic", "sk-ant-secret-1234");
    expect(first.ciphertext).not.toBe(second.ciphertext);
    expect(first.wrappedKey).not.toBe(second.wrappedKey);
    expect(await envelope.open(ORG_A, "anthropic", first)).toBe("sk-ant-secret-1234");
    expect(await envelope.open(ORG_A, "anthropic", second)).toBe("sk-ant-secret-1234");
  });

  it("refuses a ciphertext moved to another org's row, or another provider's", async () => {
    const envelope = createLocalEnvelope(generateMasterKey());
    const sealed = await envelope.seal(ORG_A, "anthropic", "sk-ant-secret-1234");
    await expect(envelope.open(ORG_B, "anthropic", sealed)).rejects.toThrow();
    await expect(envelope.open(ORG_A, "openai", sealed)).rejects.toThrow();
  });

  it("refuses a ciphertext under another master key", async () => {
    const one = createLocalEnvelope(generateMasterKey());
    const other = createLocalEnvelope(generateMasterKey());
    const sealed = await one.seal(ORG_A, "openai", "sk-proj-secret-5678");
    await expect(other.open(ORG_A, "openai", sealed)).rejects.toThrow();
  });

  it("never carries the plaintext in what it stores", async () => {
    const envelope = createLocalEnvelope(generateMasterKey());
    const sealed = await envelope.seal(ORG_A, "openai", "sk-proj-secret-5678");
    expect(Buffer.from(sealed.ciphertext, "base64").toString("latin1")).not.toContain("secret");
    expect(sealed.wrappedKey).not.toContain("secret");
  });

  it("wants a 32-byte master key", () => {
    expect(() => createLocalEnvelope(new Uint8Array(16))).toThrow(/32 bytes/);
  });
});
