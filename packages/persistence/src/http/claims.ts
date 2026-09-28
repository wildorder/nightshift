/**
 * Reading a JWT's claims without verifying it.
 *
 * A client reads; the gateway verifies. This module is the one implementation
 * of that reading, shared by the Node session (`session/tokens.ts`) and the
 * browser entry (`browser/index.ts`), so it uses nothing Node-only: `atob` and
 * `TextDecoder` are in both runtimes; Node's byte buffer class is not.
 */

/** base64url to UTF-8, or `undefined` when the text is not base64url at all. */
const decodeBase64Url = (text: string): string | undefined => {
  const padded = text
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(text.length / 4) * 4, "=");
  try {
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
};

/** A JWT's claims, unverified. The gateway verifies; a client only reads. */
export const tokenClaims = (token: string): Readonly<Record<string, unknown>> => {
  const payload = token.split(".")[1];
  if (payload === undefined) return {};
  const json = decodeBase64Url(payload);
  if (json === undefined) return {};
  try {
    const parsed: unknown = JSON.parse(json);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
};

/** A JWT's `exp`, in epoch milliseconds, read without verifying the signature. */
export const tokenExpiry = (token: string): number | undefined => {
  const exp = tokenClaims(token).exp;
  return typeof exp === "number" ? exp * 1000 : undefined;
};
