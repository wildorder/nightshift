import { describe, expect, it } from "vitest";
import { ExaminationSchema } from "./examination.js";
import { AGGREGATE_EXAMPLES, EXAMPLE_IDS } from "./examples.js";
import { RouteUsageSchema } from "./routing-decision.js";
import {
  outcomeOfCommands,
  VerificationCommandResultSchema,
  VerificationSchema,
} from "./verification.js";

const skipped = { decisionId: EXAMPLE_IDS.decisionId };
const skippedStep = { stepId: "build", command: "npm run build", durationMs: 0, skipped };

describe("a failed rerun (D-P15-06, P19 D-06)", () => {
  const ran = { stepId: "build", command: "npm run build", exitCode: 124, durationMs: 5 };
  const rerun = { exitCode: 1, durationMs: 3 };

  it("parses on a step that ran and failed, with or without a log", () => {
    expect(VerificationCommandResultSchema.safeParse({ ...ran, rerun }).success).toBe(true);
    expect(
      VerificationCommandResultSchema.safeParse({
        ...ran,
        rerun: { ...rerun, logArtifactId: EXAMPLE_IDS.artifactId },
      }).success,
    ).toBe(true);
  });

  it.each([
    ["a passed command", { exitCode: 0 }],
    ["a flaky command", { exitCode: 0, flaky: { firstExitCode: 1, firstDurationMs: 3 } }],
    ["a deferred command", { exitCode: undefined, deferred: { prerequisiteId: "HP-01" } }],
    ["a skipped command", { exitCode: undefined, skipped }],
    ["a passing rerun", { rerun: { exitCode: 0, durationMs: 3 } }],
  ])("is refused on %s", (_name, extra) => {
    expect(VerificationCommandResultSchema.safeParse({ ...ran, rerun, ...extra }).success).toBe(
      false,
    );
  });
});

describe("a skipped step (P19, D-05/D-06)", () => {
  it("parses without an exit code", () => {
    expect(VerificationCommandResultSchema.safeParse(skippedStep).success).toBe(true);
  });

  it.each([
    ["an exit code", { exitCode: 0 }],
    ["a deferral", { deferred: { prerequisiteId: "HP-01" } }],
    ["a quietMs", { quietMs: 5 }],
    ["a flaky record", { flaky: { firstExitCode: 1, firstDurationMs: 3 } }],
    ["a rerun", { rerun: { exitCode: 1, durationMs: 3 } }],
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

describe("attempt attribution (P20)", () => {
  const example = AGGREGATE_EXAMPLES.Verification as Record<string, unknown>;

  it("parses with and without the routing decision it judged", () => {
    expect(VerificationSchema.safeParse(example).success).toBe(true);
    expect(
      VerificationSchema.safeParse({
        ...example,
        routingDecisionId: EXAMPLE_IDS.routingDecisionId,
      }).success,
    ).toBe(true);
    expect(VerificationSchema.safeParse({ ...example, routingDecisionId: "nope" }).success).toBe(
      false,
    );
  });

  it("lets an examination name the attempt it judged, optionally", () => {
    const record = AGGREGATE_EXAMPLES.Examination as Record<string, unknown>;
    expect(ExaminationSchema.safeParse(record).success).toBe(true);
    expect(
      ExaminationSchema.safeParse({
        ...record,
        implementerRoutingDecisionId: EXAMPLE_IDS.routingDecisionId,
      }).success,
    ).toBe(true);
    expect(
      ExaminationSchema.safeParse({ ...record, implementerRoutingDecisionId: "nope" }).success,
    ).toBe(false);
  });

  it("carries agent time apart from settlement time in route usage", () => {
    expect(RouteUsageSchema.safeParse({ wallClockMs: 900 }).success).toBe(true);
    expect(RouteUsageSchema.safeParse({ wallClockMs: 900, agentMs: 400 }).success).toBe(true);
    expect(RouteUsageSchema.safeParse({ agentMs: -1 }).success).toBe(false);
    expect(RouteUsageSchema.safeParse({ agentMs: 1.5 }).success).toBe(false);
  });
});
