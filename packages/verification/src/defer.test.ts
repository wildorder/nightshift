import { describe, expect, it } from "vitest";
import { DEFER_EXIT_CODE, deferSignalOf } from "./defer.js";

describe("deferSignalOf (D-P7-10)", () => {
  it("needs both the exit code and the line", () => {
    const line = "checking...\nNIGHTSHIFT_DEFER HP-03 The deploy key is missing\n";
    expect(deferSignalOf(DEFER_EXIT_CODE, line)).toEqual({
      prerequisiteId: "HP-03",
      description: "The deploy key is missing",
      remediation: "",
    });
    expect(deferSignalOf(1, line)).toBeUndefined();
    expect(deferSignalOf(DEFER_EXIT_CODE, "no line")).toBeUndefined();
    expect(deferSignalOf(DEFER_EXIT_CODE, "NIGHTSHIFT_DEFER token missing")).toBeUndefined();
  });

  it("takes a remediation when the command gives one", () => {
    const out =
      "NIGHTSHIFT_DEFER HP-03 key missing\r\nNIGHTSHIFT_REMEDIATION run `aws sso login`\r\n";
    expect(deferSignalOf(75, out)?.remediation).toBe("run `aws sso login`");
  });
});
