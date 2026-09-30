import {
  AgentStatusSchema,
  ExaminationOutcomeSchema,
  ExecutionNodeStatusSchema,
  RouteOutcomeSchema,
  RunStatusSchema,
  VerificationOutcomeSchema,
} from "@nightshift/contracts";
import { describe, expect, it } from "vitest";
import { KNOWN_STATUSES, toneOf } from "./status";

describe("the status table (D-P13-03)", () => {
  it("names every status the contracts define", () => {
    const all = [
      ...ExecutionNodeStatusSchema.options,
      ...AgentStatusSchema.options,
      ...RunStatusSchema.options,
      ...RouteOutcomeSchema.options,
      ...VerificationOutcomeSchema.options,
      ...ExaminationOutcomeSchema.options,
      "provisional",
      "not delegated",
    ];
    expect(all.filter((status) => !KNOWN_STATUSES.includes(status))).toEqual([]);
  });

  it("says what a failure, a landing and a wait look like", () => {
    expect(toneOf("verification_failed")).toBe("danger");
    expect(toneOf("integrated")).toBe("success");
    expect(toneOf("deferred")).toBe("warning");
    expect(toneOf("something new")).toBe("neutral");
  });
});
