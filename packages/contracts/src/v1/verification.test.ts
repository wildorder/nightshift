import { describe, expect, it } from "vitest";
import { AGGREGATE_EXAMPLES, EXAMPLE_IDS } from "./examples.js";
import {
  outcomeOfCommands,
  VerificationCommandResultSchema,
  VerificationSchema,
} from "./verification.js";

const skipped = { decisionId: EXAMPLE_IDS.decisionId };
const skippedStep = { stepId: "build", command: "npm run build", durationMs: 0, skipped };

describe("a skipped step (P19, D-05/D-06)", () => {
  it("parses without an exit code", () => {
    expect(VerificationCommandResultSchema.safeParse(skippedStep).success).toBe(true);
  });

  it.each([
    ["an exit code", { exitCode: 0 }],
    ["a deferral", { deferred: { prerequisiteId: "HP-01" } }],
    ["a quietMs", { quietMs: 5 }],
    ["a flaky record", { flaky: { firstExitCode: 1, firstDurationMs: 3 } }],
  ])("is refused with %s", (_name, extra) => {
    expect(VerificationCommandResultSchema.safeParse({ ...skippedStep, ...extra }).success).toBe(
      false,
    );
  });

  it("outcomeOfCommands lets a skipped step decide nothing", () => {
    expect(outcomeOfCommands([{ exitCode: 0 }, { skipped }])).toBe("passed");
    expect(outcomeOfCommands([{ exitCode: 1 }, { skipped }])).toBe("failed");
    expect(
      outcomeOfCommands([{ exitCode: 0 }, { deferred: { prerequisiteId: "HP-01" } }, { skipped }]),
    ).toBe("deferred");
  });

  it("a Verification with a skipped step follows the same outcome rules", () => {
    const record = structuredClone(AGGREGATE_EXAMPLES.Verification) as Record<string, unknown>;
    const commands = record.commands as Record<string, unknown>[];
    commands[1] = skippedStep;
    record.outcome = "passed";
    expect(VerificationSchema.safeParse(record).success).toBe(true);
    record.outcome = "failed";
    expect(VerificationSchema.safeParse(record).success).toBe(false);
  });
});
