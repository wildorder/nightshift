/**
 * Just enough JWT to sign and verify one token kind (T2).
 *
 * No JWT library. What Nightshift needs is a compact serialisation of a header,
 * a claim set and a signature, and the reason to write it here rather than take a
 * dependency is that the *verifier* is the security boundary: a library that
 * accepts `alg: "none"`, or that picks the algorithm from the header rather than
 * from the key, is the classic way this goes wrong. This module never reads an
 * algorithm from a token — {@link splitToken} returns the header for inspection,
 * and the verifier compares it against what it demands.
 *
 * Only RS256 is produced. See `tokens/mint.ts` for why the key is RSA-2048.
 */

/** The only header Nightshift signs, and the only one its verifier accepts. */
export const EXECUTION_TOKEN_HEADER = { alg: "RS256", typ: "JWT" } as const;

export const encodeBase64Url = (bytes: Uint8Array | string): string =>
  Buffer.from(bytes as Uint8Array).toString("base64url");

const decodeBase64Url = (value: string): Buffer => Buffer.from(value, "base64url");

/** The JSON of `value`, base64url encoded, as a JWT segment. */
export const encodeSegment = (value: unknown): string =>
  Buffer.from(JSON.stringify(value), "utf8").toString("base64url");

export interface TokenParts {
  /** `<header>.<payload>`, the bytes a signature covers. */
  readonly signingInput: Buffer;
  readonly header: unknown;
  readonly payload: unknown;
  readonly signature: Buffer;
}

/**
 * Splits a compact JWS, or `undefined` when it is not one.
 *
 * Deliberately total: every malformed input — wrong segment count, a segment
 * that is not base64url, a segment that is not JSON — returns `undefined` rather
 * than throwing, so the caller has one branch for "this is not a token we can
 * read" instead of a try/catch around a parse.
 */
export const splitToken = (token: string): TokenParts | undefined => {
  const segments = token.split(".");
  if (segments.length !== 3) return undefined;
  const [header, payload, signature] = segments as [string, string, string];
  if (header === "" || payload === "" || signature === "") return undefined;

  try {
    return {
      signingInput: Buffer.from(`${header}.${payload}`, "ascii"),
      header: JSON.parse(decodeBase64Url(header).toString("utf8")),
      payload: JSON.parse(decodeBase64Url(payload).toString("utf8")),
      signature: decodeBase64Url(signature),
    };
  } catch {
    return undefined;
  }
};

/** The bytes to sign for a header and a claim set, and the two segments they came from. */
export const signingInputFor = (
  header: unknown,
  claims: unknown,
): { readonly signingInput: Buffer; readonly prefix: string } => {
  const prefix = `${encodeSegment(header)}.${encodeSegment(claims)}`;
  return { signingInput: Buffer.from(prefix, "ascii"), prefix };
};

/** `<header>.<payload>.<signature>`. */
export const compactToken = (prefix: string, signature: Uint8Array): string =>
  `${prefix}.${encodeBase64Url(signature)}`;

/**
 * Whether a token's header is exactly the one Nightshift signs.
 *
 * An unknown `alg`, a missing one, or `none` all fail here, before any key is
 * fetched. `typ` is checked too: it costs nothing and it means a token minted
 * for some other purpose with the same key could not be replayed as this one.
 */
export const hasExecutionTokenHeader = (header: unknown): boolean => {
  if (header === null || typeof header !== "object") return false;
  const { alg, typ } = header as Record<string, unknown>;
  return alg === EXECUTION_TOKEN_HEADER.alg && typ === EXECUTION_TOKEN_HEADER.typ;
};
