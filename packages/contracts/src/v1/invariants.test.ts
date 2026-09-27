/**
 * Schema-level invariants that go beyond field presence.
 *
 * These are the checks that make a record self-consistent before `core` ever
 * sees it: a verification whose outcome contradicts its exit codes, an
 * examination by the implementer, an event whose inline payload would put large
 * output in DynamoDB.
 */
import { describe, expect, it } from "vitest";
import { ArtifactSchema } from "./artifact.js";
import { PathGlobSchema, ScopeRequestSchema, ScopeSchema } from "./common.js";
import { EventSchema, inlinePayloadBytes, MAX_INLINE_PAYLOAD_BYTES } from "./event.js";
import { ExaminationSchema } from "./examination.js";
import { AGGREGATE_EXAMPLES, EXAMPLE_IDS } from "./examples.js";
import { ProgramContractSchema } from "./program-contract.js";
import { RoutingDecisionSchema } from "./routing-decision.js";
import { VerificationSchema } from "./verification.js";

const clone = <T>(value: T): Record<string, unknown> =>
  structuredClone(value) as Record<string, unknown>;

describe("Verification", () => {
  it("rejects outcome passed when a command failed", () => {
    const record = clone(AGGREGATE_EXAMPLES.Verification);
    const commands = record.commands as Record<string, unknown>[];
    commands[0] = { ...commands[0], exitCode: 1 };
    expect(VerificationSchema.safeParse(record).success).toBe(false);
  });

  it("rejects outcome failed when every command passed", () => {
    const record = clone(AGGREGATE_EXAMPLES.Verification);
    record.outcome = "failed";
    expect(VerificationSchema.safeParse(record).success).toBe(false);
  });

  it("accepts outcome failed when a command failed", () => {
    const record = clone(AGGREGATE_EXAMPLES.Verification);
    const commands = record.commands as Record<string, unknown>[];
    commands[1] = { ...commands[1], exitCode: 1 };
    record.outcome = "failed";
    expect(VerificationSchema.safeParse(record).success).toBe(true);
  });

  describe("a step that could not run (P7, D-P7-10)", () => {
    const withDeferred = (patch: Record<string, unknown> = {}) => {
      const record = clone(AGGREGATE_EXAMPLES.Verification);
      const commands = record.commands as Record<string, unknown>[];
      const { exitCode: _exitCode, ...step } = commands[1] as Record<string, unknown>;
      commands[1] = { ...step, deferred: { prerequisiteId: "HP-01" }, ...patch };
      return { record, commands };
    };

    it("is deferred, never passed: a deferral verifies nothing", () => {
      const { record } = withDeferred();
      record.outcome = "deferred";
      expect(VerificationSchema.safeParse(record).success).toBe(true);
      record.outcome = "passed";
      expect(VerificationSchema.safeParse(record).success).toBe(false);
    });

    it("never hides a step that ran and failed", () => {
      const { record, commands } = withDeferred();
      commands[0] = { ...commands[0], exitCode: 1 };
      record.outcome = "deferred";
      expect(VerificationSchema.safeParse(record).success).toBe(false);
      record.outcome = "failed";
      expect(VerificationSchema.safeParse(record).success).toBe(true);
    });

    it("has no exit code, and a step that ran cannot also be deferred", () => {
      const both = withDeferred({ exitCode: 0 });
      both.record.outcome = "deferred";
      expect(VerificationSchema.safeParse(both.record).success).toBe(false);

      const neither = clone(AGGREGATE_EXAMPLES.Verification);
      const commands = neither.commands as Record<string, unknown>[];
      const { exitCode: _exitCode, ...step } = commands[0] as Record<string, unknown>;
      commands[0] = step;
      expect(VerificationSchema.safeParse(neither).success).toBe(false);
    });

    it("names a prerequisite by its id", () => {
      const { record } = withDeferred({ deferred: { prerequisiteId: "the token" } });
      record.outcome = "deferred";
      expect(VerificationSchema.safeParse(record).success).toBe(false);
    });
  });

  it("requires at least one command, so a verification cannot be vacuously green", () => {
    const record = clone(AGGREGATE_EXAMPLES.Verification);
    record.commands = [];
    expect(VerificationSchema.safeParse(record).success).toBe(false);
  });

  it("never carries inline log output", () => {
    const record = clone(AGGREGATE_EXAMPLES.Verification);
    const commands = record.commands as Record<string, unknown>[];
    commands[0] = { ...commands[0], log: "a".repeat(1000) };
    expect(VerificationSchema.safeParse(record).success).toBe(false);
  });
});

describe("Examination", () => {
  it("rejects self-examination", () => {
    const record = clone(AGGREGATE_EXAMPLES.Examination);
    record.examinerAgentId = EXAMPLE_IDS.workerAgentId;
    expect(ExaminationSchema.safeParse(record).success).toBe(false);
  });

  it("rejects outcome passed alongside findings", () => {
    const record = clone(AGGREGATE_EXAMPLES.Examination);
    record.outcome = "passed";
    expect(ExaminationSchema.safeParse(record).success).toBe(false);
  });

  it("accepts outcome passed with no findings", () => {
    const record = clone(AGGREGATE_EXAMPLES.Examination);
    record.outcome = "passed";
    record.findings = [];
    expect(ExaminationSchema.safeParse(record).success).toBe(true);
  });

  it("requires evidence on every finding", () => {
    const record = clone(AGGREGATE_EXAMPLES.Examination);
    const findings = record.findings as Record<string, unknown>[];
    findings[0] = { ...findings[0], evidence: [] };
    expect(ExaminationSchema.safeParse(record).success).toBe(false);
  });
});

describe("Event", () => {
  it("rejects an unknown event type", () => {
    const record = clone(AGGREGATE_EXAMPLES.Event);
    record.type = "node.teleported";
    expect(EventSchema.safeParse(record).success).toBe(false);
  });

  it("rejects an inline payload above the A-08 bound", () => {
    const record = clone(AGGREGATE_EXAMPLES.Event);
    record.payload = { transcript: "x".repeat(MAX_INLINE_PAYLOAD_BYTES + 1) };
    expect(inlinePayloadBytes(record.payload as Record<string, unknown>)).toBeGreaterThan(
      MAX_INLINE_PAYLOAD_BYTES,
    );
    expect(EventSchema.safeParse(record).success).toBe(false);
  });

  it("accepts a payload at the bound", () => {
    const record = clone(AGGREGATE_EXAMPLES.Event);
    // 12 bytes of JSON scaffolding around the string value.
    record.payload = { t: "x".repeat(MAX_INLINE_PAYLOAD_BYTES - 12) };
    expect(inlinePayloadBytes(record.payload as Record<string, unknown>)).toBeLessThanOrEqual(
      MAX_INLINE_PAYLOAD_BYTES,
    );
    expect(EventSchema.safeParse(record).success).toBe(true);
  });

  it("requires an idempotency key", () => {
    const record = clone(AGGREGATE_EXAMPLES.Event);
    record.idempotencyKey = "";
    expect(EventSchema.safeParse(record).success).toBe(false);
  });

  it("records which channel the event arrived on", () => {
    const record = clone(AGGREGATE_EXAMPLES.Event);
    for (const source of ["mcp", "hook", "control-plane"]) {
      expect(EventSchema.safeParse({ ...record, source }).success).toBe(true);
    }
    expect(EventSchema.safeParse({ ...record, source: "guesswork" }).success).toBe(false);
  });
});

describe("RoutingDecision", () => {
  it("requires a reason for every ineligible option", () => {
    const record = clone(AGGREGATE_EXAMPLES.RoutingDecision);
    const options = record.eligibleOptions as Record<string, unknown>[];
    options[1] = { target: (options[1] as Record<string, unknown>).target, eligible: false };
    expect(RoutingDecisionSchema.safeParse(record).success).toBe(false);
  });

  it("rejects a first attempt that claims a previous route", () => {
    const record = clone(AGGREGATE_EXAMPLES.RoutingDecision);
    record.previousRouteId = EXAMPLE_IDS.routingDecisionId;
    expect(RoutingDecisionSchema.safeParse(record).success).toBe(false);
  });

  it("accepts an escalation that references its predecessor", () => {
    const record = clone(AGGREGATE_EXAMPLES.RoutingDecision);
    record.attempt = 2;
    record.previousRouteId = EXAMPLE_IDS.routingDecisionId;
    expect(RoutingDecisionSchema.safeParse(record).success).toBe(true);
  });

  it("requires at least one considered option, so a choice is always explainable", () => {
    const record = clone(AGGREGATE_EXAMPLES.RoutingDecision);
    record.eligibleOptions = [];
    expect(RoutingDecisionSchema.safeParse(record).success).toBe(false);
  });
});

describe("Artifact", () => {
  it("requires a scheme-qualified reference", () => {
    const record = clone(AGGREGATE_EXAMPLES.Artifact);
    for (const uri of ["/tmp/local.log", "nightshift-artifacts/key", "s3://", ""]) {
      expect(
        ArtifactSchema.safeParse({ ...record, uri }).success,
        `accepted uri ${JSON.stringify(uri)}`,
      ).toBe(false);
    }
  });

  it("has no field for inline content (A-08)", () => {
    const record = clone(AGGREGATE_EXAMPLES.Artifact);
    record.content = "the whole transcript";
    expect(ArtifactSchema.safeParse(record).success).toBe(false);
  });
});

describe("path globs", () => {
  it.each(["/etc/passwd", "C:/Windows", "c:/windows", "../outside/**", "src/../../escape"])(
    "rejects %s",
    (candidate) => {
      expect(PathGlobSchema.safeParse(candidate).success).toBe(false);
    },
  );

  it.each(["src/**", "src/billing/**/*.ts", "migrations/**", "package.json"])(
    "accepts %s",
    (candidate) => {
      expect(PathGlobSchema.safeParse(candidate).success).toBe(true);
    },
  );
});

describe("scope", () => {
  it("requires at least one include, so an empty scope is never authority", () => {
    expect(
      ScopeSchema.safeParse({
        includes: [],
        excludes: [],
        permissions: [],
        forbiddenActions: [],
      }).success,
    ).toBe(false);
  });

  it("distinguishes an omitted request field from an empty one", () => {
    const omitted = ScopeRequestSchema.parse({ includes: ["src/**"] });
    expect(omitted.permissions).toBeUndefined();

    const empty = ScopeRequestSchema.parse({ includes: ["src/**"], permissions: [] });
    expect(empty.permissions).toEqual([]);
  });
});

describe("a program contract's step identifiers (P3, T4)", () => {
  const contract = (overrides: Record<string, unknown>) => ({
    ...clone(AGGREGATE_EXAMPLES.ProgramContract),
    ...overrides,
  });

  it("refuses two verification steps sharing an id", () => {
    // They are what a Verification's exit code and log artifact are labelled
    // with, so a duplicate loses one of the two logs silently.
    const result = ProgramContractSchema.safeParse(
      contract({
        verification: [
          { id: "test", command: "node --test" },
          { id: "test", command: "npm run lint" },
        ],
      }),
    );
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("unique");
  });

  it("refuses two success criteria sharing an id", () => {
    const result = ProgramContractSchema.safeParse(
      contract({
        successCriteria: [
          { id: "SC-01", outcome: "It works." },
          { id: "SC-01", outcome: "It also works." },
        ],
      }),
    );
    expect(result.success).toBe(false);
  });

  it("accepts distinct identifiers", () => {
    expect(
      ProgramContractSchema.safeParse(
        contract({
          verification: [
            { id: "test", command: "node --test" },
            { id: "lint", command: "npm run lint" },
          ],
        }),
      ).success,
    ).toBe(true);
  });
});
