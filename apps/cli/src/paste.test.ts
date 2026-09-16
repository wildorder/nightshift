import { describe, expect, it } from "vitest";
import { PastedCallbackError, parsePastedCallback } from "./paste.js";
import { assertState, StateMismatchError } from "./pkce.js";

const check = (received: string | null) => assertState("expected-state", received);

describe("parsePastedCallback", () => {
  it("reads the code out of a full redirect URL and checks its state", () => {
    expect(
      parsePastedCallback("http://localhost:47821/callback?code=abc&state=expected-state", check),
    ).toBe("abc");
  });

  it("reads a bare query string", () => {
    expect(parsePastedCallback("?code=abc&state=expected-state", check)).toBe("abc");
    expect(parsePastedCallback("code=abc&state=expected-state", check)).toBe("abc");
  });

  it("accepts a bare code, trimmed", () => {
    expect(parsePastedCallback("  abc-123  ", check)).toBe("abc-123");
  });

  it("refuses the wrong state and a missing state on an address", () => {
    expect(() =>
      parsePastedCallback("http://localhost:47821/callback?code=abc&state=other", check),
    ).toThrow(StateMismatchError);
    expect(() => parsePastedCallback("http://localhost:47821/callback?code=abc", check)).toThrow(
      StateMismatchError,
    );
  });

  it("names a refusal Cognito sent back", () => {
    expect(() =>
      parsePastedCallback(
        "http://localhost:47821/callback?error=access_denied&error_description=nope",
        check,
      ),
    ).toThrow(/access_denied.*nope/);
  });

  it("refuses an empty paste, an address without a code, and prose", () => {
    expect(() => parsePastedCallback("   ", check)).toThrow(PastedCallbackError);
    expect(() => parsePastedCallback("http://localhost:47821/callback", check)).toThrow(
      /no `code`/,
    );
    expect(() => parsePastedCallback("it said connection refused", check)).toThrow(
      PastedCallbackError,
    );
  });
});
