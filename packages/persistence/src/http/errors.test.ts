import type { DomainErrorCode } from "@nightshift/core";
import { describe, expect, it } from "vitest";
import { ControlPlaneError, toThrowable } from "./errors.js";
import { DOMAIN_ERROR_CODES_FOR_TEST } from "./errors-test-support.js";

const refusal = (code: string, message: string) => ({ error: { code, message } });

describe("turning a refusal into a typed failure", () => {
  it("reconstructs the class for every DomainErrorCode, with the server's message", () => {
    for (const code of DOMAIN_ERROR_CODES_FOR_TEST) {
      const error = toThrowable(409, refusal(code, `the server said ${code}`));
      expect(error, code).not.toBeInstanceOf(ControlPlaneError);
      expect((error as { code?: string }).code, code).toBe(code);
      expect(error.message, code).toBe(`the server said ${code}`);
    }
  });

  it("keeps the class stable, so instanceof works across the network", async () => {
    const { DelegationRefusedError, IllegalTransitionError } = await import("@nightshift/core");
    expect(
      toThrowable(403, refusal("delegation_refused", "the parent is a job and holds no authority")),
    ).toBeInstanceOf(DelegationRefusedError);
    expect(
      toThrowable(409, refusal("illegal_transition", 'no legal transition from "created"')),
    ).toBeInstanceOf(IllegalTransitionError);
  });

  it("falls back to ControlPlaneError for a refusal that is not a domain rule", () => {
    const error = toThrowable(404, refusal("not_found", "run run_x does not exist"));
    expect(error).toBeInstanceOf(ControlPlaneError);
    expect((error as ControlPlaneError).status).toBe(404);
    expect((error as ControlPlaneError).code).toBe("not_found");
  });

  it("carries validation issues through, so a caller can say which field", () => {
    const error = toThrowable(400, {
      error: {
        code: "validation_failed",
        message: "request body failed validation",
        issues: [{ path: ["objective"], message: "Required" }],
      },
    });
    expect((error as ControlPlaneError).issues).toEqual([
      { path: ["objective"], message: "Required" },
    ]);
  });

  it("survives a body that is not the error shape at all", () => {
    for (const body of [undefined, null, "<html>502</html>", {}, { error: {} }]) {
      const error = toThrowable(502, body);
      expect(error).toBeInstanceOf(ControlPlaneError);
      expect(error.message.length).toBeGreaterThan(0);
    }
  });

  it("does not mistake an unknown code for a domain rule", () => {
    const error = toThrowable(409, refusal("conflict", "a different record already exists"));
    expect(error).toBeInstanceOf(ControlPlaneError);
  });
});

/** The map in `errors.ts` is exhaustive by type; this asserts the list stayed in step. */
describe("the code list", () => {
  it("names every code the domain defines", () => {
    const codes: readonly DomainErrorCode[] = DOMAIN_ERROR_CODES_FOR_TEST;
    expect(new Set(codes).size).toBe(codes.length);
  });
});
