import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  assertState,
  CODE_CHALLENGE_METHOD,
  challengeFor,
  createPkce,
  createState,
  StateMismatchError,
  VERIFIER_MAX_LENGTH,
  VERIFIER_MIN_LENGTH,
} from "./pkce.js";

/** RFC 7636 §4.1: `[A-Za-z0-9-._~]`. */
const UNRESERVED = /^[A-Za-z0-9\-._~]+$/;

describe("the code verifier", () => {
  it("is unreserved characters within the length RFC 7636 allows", () => {
    for (let n = 0; n < 50; n += 1) {
      const { verifier } = createPkce();
      expect(verifier).toMatch(UNRESERVED);
      expect(verifier.length).toBeGreaterThanOrEqual(VERIFIER_MIN_LENGTH);
      expect(verifier.length).toBeLessThanOrEqual(VERIFIER_MAX_LENGTH);
    }
  });

  it("differs on every call", () => {
    const verifiers = new Set(Array.from({ length: 20 }, () => createPkce().verifier));
    expect(verifiers.size).toBe(20);
  });

  it("is derived from the injected randomness, so a test replays one exchange", () => {
    const fixed = Buffer.alloc(48, 7);
    expect(createPkce(() => fixed).verifier).toBe(createPkce(() => fixed).verifier);
  });
});

describe("the code challenge", () => {
  it("is base64url of the verifier's SHA-256, with method S256", () => {
    const { verifier, challenge, method } = createPkce();
    expect(method).toBe(CODE_CHALLENGE_METHOD);
    expect(challenge).toBe(createHash("sha256").update(verifier, "ascii").digest("base64url"));
    // base64url, so no padding and none of `+`, `/`, `=`.
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("matches the worked example in RFC 7636 appendix B", () => {
    expect(challengeFor("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });
});

describe("the state parameter", () => {
  it("is refused when it does not match, which is the whole point of sending one", () => {
    expect(() => {
      assertState("expected", "something-else");
    }).toThrow(StateMismatchError);
  });

  it("is refused when the callback carried none at all", () => {
    expect(() => {
      assertState("expected", null);
    }).toThrow(StateMismatchError);
  });

  it("names neither value, so nothing attacker-controlled reaches a log", () => {
    const attacker = "<script>stolen</script>";
    try {
      assertState("the-real-state", attacker);
      expect.unreachable("the mismatch must be refused");
    } catch (error) {
      expect((error as Error).message).not.toContain(attacker);
      expect((error as Error).message).not.toContain("the-real-state");
    }
  });

  it("accepts the value that was sent", () => {
    const state = createState();
    expect(() => {
      assertState(state, state);
    }).not.toThrow();
  });
});
