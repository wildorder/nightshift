import { webcrypto } from "node:crypto";
import { describe, expect, it } from "vitest";
import { assertState, challengeFor, createPkce, createState, StateMismatchError } from "./pkce.js";

const digest = webcrypto.subtle;
const random = webcrypto;

describe("pkce", () => {
  it("derives the RFC 7636 appendix B challenge", async () => {
    expect(await challengeFor("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk", digest)).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("makes a verifier inside the RFC's bounds and a state that is not it", async () => {
    const pkce = await createPkce(random, digest);
    expect(pkce.verifier.length).toBeGreaterThanOrEqual(43);
    expect(pkce.verifier.length).toBeLessThanOrEqual(128);
    expect(pkce.verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(pkce.method).toBe("S256");
    expect(createState(random)).not.toBe(pkce.verifier);
  });

  it("refuses a missing or foreign state", () => {
    expect(() => assertState("a", null)).toThrow(StateMismatchError);
    expect(() => assertState("a", "b")).toThrow(StateMismatchError);
    expect(() => assertState("a", "a")).not.toThrow();
  });
});
