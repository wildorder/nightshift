/**
 * PKCE (RFC 7636) and the `state` parameter.
 *
 * The interactive app client is **public**: it has no secret, so possession of
 * the client id is not evidence of anything. PKCE is what makes the
 * authorization code useless to anyone who intercepts it — the code is redeemed
 * with the verifier, and only the process that generated the verifier has it.
 *
 * `state` is a separate job and a smaller one: it proves the callback the
 * listener received belongs to the authorization *this* process started, not to
 * some other page that happened to hit `http://localhost:47821/callback`. A
 * mismatch is refused (`assertState`), because a `state` that is generated,
 * sent, and then not compared is decoration.
 */
import { createHash, randomBytes } from "node:crypto";

/**
 * How many random bytes a verifier is built from.
 *
 * base64url of 48 bytes is 64 characters with no padding, comfortably inside
 * RFC 7636's 43-128 and well above its 32-byte entropy recommendation. Every
 * character base64url produces is in the spec's unreserved set, so no escaping
 * or filtering is needed.
 */
export const VERIFIER_BYTES = 48;
export const STATE_BYTES = 32;

/** Bounds RFC 7636 §4.1 puts on a `code_verifier`. */
export const VERIFIER_MIN_LENGTH = 43;
export const VERIFIER_MAX_LENGTH = 128;

/** The only method Nightshift uses. `plain` is not offered and never will be. */
export const CODE_CHALLENGE_METHOD = "S256";

/** Injected so a test replays one exact exchange. Defaults to `node:crypto`. */
export type RandomBytes = (size: number) => Buffer;

export interface Pkce {
  readonly verifier: string;
  readonly challenge: string;
  readonly method: typeof CODE_CHALLENGE_METHOD;
}

/** base64url of the verifier's SHA-256, per RFC 7636 §4.2. */
export const challengeFor = (verifier: string): string =>
  createHash("sha256").update(verifier, "ascii").digest("base64url");

export const createPkce = (random: RandomBytes = randomBytes): Pkce => {
  const verifier = random(VERIFIER_BYTES).toString("base64url");
  return { verifier, challenge: challengeFor(verifier), method: CODE_CHALLENGE_METHOD };
};

export const createState = (random: RandomBytes = randomBytes): string =>
  random(STATE_BYTES).toString("base64url");

/** Raised when a callback's `state` is not the one this process sent. */
export class StateMismatchError extends Error {
  override readonly name = "StateMismatchError";
  readonly code = "state_mismatch" as const;

  constructor() {
    // Neither value is quoted. The expected one is this process's secret, and
    // the received one is attacker-controlled text that would end up in a log.
    super(
      "the sign-in callback carried a `state` this process did not send, so it was refused. " +
        "Run `nightshift login` again, and finish the sign-in it opens rather than an older tab.",
    );
  }
}

/**
 * Compares the callback's `state` with the one that was sent.
 *
 * Length-independent constant-time comparison is not worth reaching for here —
 * the value is single-use, lives for one sign-in, and an attacker who could time
 * this could simply read the terminal — but the comparison itself is the whole
 * point of the parameter, so it lives in a named function that is tested
 * directly rather than inline in the request handler.
 */
export const assertState = (expected: string, received: string | null): void => {
  if (received === null || received !== expected) throw new StateMismatchError();
};
