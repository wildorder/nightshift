/**
 * PKCE (RFC 7636) and `state`, for a browser.
 *
 * The Studio client is public: no secret, so the verifier is what proves the
 * redemption is legitimate, as it is for the CLI (`apps/cli/src/pkce.ts`, whose
 * constants these restate). `state` binds the callback to the sign-in this tab
 * started; a mismatch is refused, never ignored.
 */

export const VERIFIER_BYTES = 48;
export const STATE_BYTES = 32;
export const CODE_CHALLENGE_METHOD = "S256";

/** The slice of Web Crypto this needs, injected so a test controls the bytes. */
export interface Randomness {
  getRandomValues(array: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer>;
}
export interface Digest {
  digest(algorithm: "SHA-256", data: Uint8Array<ArrayBuffer>): Promise<ArrayBuffer>;
}

export const base64Url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const randomBase64Url = (random: Randomness, size: number): string =>
  base64Url(random.getRandomValues(new Uint8Array(size)));

export interface Pkce {
  readonly verifier: string;
  readonly challenge: string;
  readonly method: typeof CODE_CHALLENGE_METHOD;
}

/** base64url of the verifier's SHA-256 (RFC 7636 §4.2). */
export const challengeFor = async (verifier: string, digest: Digest): Promise<string> =>
  base64Url(new Uint8Array(await digest.digest("SHA-256", new TextEncoder().encode(verifier))));

export const createPkce = async (random: Randomness, digest: Digest): Promise<Pkce> => {
  const verifier = randomBase64Url(random, VERIFIER_BYTES);
  return {
    verifier,
    challenge: await challengeFor(verifier, digest),
    method: CODE_CHALLENGE_METHOD,
  };
};

export const createState = (random: Randomness): string => randomBase64Url(random, STATE_BYTES);

export class StateMismatchError extends Error {
  override readonly name = "StateMismatchError";
  readonly code = "state_mismatch" as const;
  constructor() {
    // Neither value is quoted: one is this tab's secret, the other is text
    // somebody else chose.
    super(
      "the sign-in callback carried a state this page did not send, so it was refused. Sign in again from this page.",
    );
  }
}

export const assertState = (expected: string, received: string | null): void => {
  if (received === null || received !== expected) throw new StateMismatchError();
};
