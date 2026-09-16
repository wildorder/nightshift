/**
 * The paste path for `nightshift login`.
 *
 * The loopback redirect is the right flow when the browser and the CLI share a
 * machine. Over SSH they do not: Cognito sends the browser to
 * `http://localhost:47821/callback?code=…&state=…`, the browser reports that
 * nothing is listening, and the whole authorization result is sitting in the
 * address bar. This module turns that pasted address back into a code.
 *
 * This is what Claude Code and the older `gcloud` do, minus a hosted page to
 * display the code. Cognito has no device-authorization grant, so polling is not
 * available (P2 T9); a hosted page would need an unauthenticated route on an
 * API whose every route is behind the JWT authorizer (A-19). Reading the failed
 * redirect from the operator's clipboard needs neither.
 *
 * Safety: an authorization code is useless without the PKCE verifier, which
 * never leaves the CLI process, and it is single-use and short-lived. `state`
 * is checked exactly as the listener checks it whenever the paste carries one.
 * A bare code carries none, and is accepted because the human who typed it is
 * the one the state check protects; that trade is stated here rather than
 * hidden.
 */

export class PastedCallbackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PastedCallbackError";
  }
}

const looksLikeUrl = (text: string): boolean => /^[a-z][a-z0-9+.-]*:\/\//i.test(text);

/**
 * The authorization code in a pasted line: a full redirect URL, a bare query
 * string (`code=…&state=…`), or a bare code.
 *
 * Throws `PastedCallbackError` for anything that cannot be a callback, and
 * whatever `checkState` throws when the paste carries a `state` that is wrong.
 */
export const parsePastedCallback = (
  input: string,
  checkState: (received: string | null) => void,
): string => {
  const text = input.trim();
  if (text === "") throw new PastedCallbackError("nothing was pasted");

  let params: URLSearchParams | undefined;
  if (looksLikeUrl(text)) {
    try {
      params = new URL(text).searchParams;
    } catch {
      throw new PastedCallbackError("that looks like a URL but does not parse as one");
    }
  } else if (text.includes("=")) {
    params = new URLSearchParams(text.replace(/^\?/, ""));
  }

  if (params !== undefined) {
    const error = params.get("error");
    if (error !== null) {
      const description = params.get("error_description");
      throw new PastedCallbackError(
        `the sign-in was refused: ${error}${description === null ? "" : ` (${description})`}`,
      );
    }
    const code = params.get("code");
    if (code === null || code === "") {
      throw new PastedCallbackError("the pasted address carries no `code` parameter");
    }
    checkState(params.get("state"));
    return code;
  }

  if (/\s/.test(text)) {
    throw new PastedCallbackError(
      "paste either the whole address from the browser's address bar or just the code",
    );
  }
  return text;
};
