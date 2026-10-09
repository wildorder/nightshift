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
import { PathGlobSchema } from "./common.js";
import { EventSchema, inlinePayloadBytes, MAX_INLINE_PAYLOAD_BYTES } from "./event.js";
import { ExaminationSchema } from "./examination.js";
import { AGGREGATE_EXAMPLES, EXAMPLE_IDS } from "./examples.js";
import { ExecutionNodeSchema } from "./execution-node.js";
import { JobContractSchema } from "./job-contract.js";
import { ProgramContractSchema, ProgramContractScopeSchema } from "./program-contract.js";
import { RoutingDecisionSchema } from "./routing-decision.js";
import { flakyStepIds, VerificationSchema } from "./verification.js";

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

  describe("a flaky check (P15, D-P15-06)", () => {
    const flaky = { firstExitCode: 1, firstDurationMs: 500 };

    it("accepts a check that failed first and passed on the rerun", () => {
      const record = clone(AGGREGATE_EXAMPLES.Verification);
      const commands = record.commands as Record<string, unknown>[];
      commands[0] = { ...commands[0], exitCode: 0, flaky };
      expect(VerificationSchema.safeParse(record).success).toBe(true);
    });

    it("refuses flaky when the rerun itself did not pass", () => {
      const record = clone(AGGREGATE_EXAMPLES.Verification);
      const commands = record.commands as Record<string, unknown>[];
      commands[0] = { ...commands[0], exitCode: 1, flaky };
      record.outcome = "failed";
      expect(VerificationSchema.safeParse(record).success).toBe(false);
    });

    it("refuses flaky when the first run did not actually fail", () => {
      const record = clone(AGGREGATE_EXAMPLES.Verification);
      const commands = record.commands as Record<string, unknown>[];
      commands[0] = { ...commands[0], exitCode: 0, flaky: { ...flaky, firstExitCode: 0 } };
      expect(VerificationSchema.safeParse(record).success).toBe(false);
    });

    it("names only the steps that flaked", () => {
      const record = clone(AGGREGATE_EXAMPLES.Verification);
      const commands = record.commands as Record<string, unknown>[];
      commands[0] = { ...commands[0], exitCode: 0, flaky };
      const parsed = VerificationSchema.parse(record);
      expect(flakyStepIds(parsed)).toEqual(["build"]);
    });

    it("names nothing when nothing flaked", () => {
      const parsed = VerificationSchema.parse(AGGREGATE_EXAMPLES.Verification);
      expect(flakyStepIds(parsed)).toEqual([]);
    });
  });
});

describe("JobContract repair (P15, D-P15-03, D-P15-04)", () => {
  const repair = { cause: "red_base", gates: ["build"], decisionId: EXAMPLE_IDS.decisionId };

  it("accepts a repair job", () => {
    const record = clone(AGGREGATE_EXAMPLES.JobContract);
    record.repair = repair;
    expect(JobContractSchema.safeParse(record).success).toBe(true);
  });

  it("accepts a repair job with cause flaky", () => {
    const record = clone(AGGREGATE_EXAMPLES.JobContract);
    record.repair = { ...repair, cause: "flaky" };
    expect(JobContractSchema.safeParse(record).success).toBe(true);
  });

  it("refuses an unknown cause", () => {
    const record = clone(AGGREGATE_EXAMPLES.JobContract);
    record.repair = { ...repair, cause: "something_else" };
    expect(JobContractSchema.safeParse(record).success).toBe(false);
  });

  it("refuses an empty gates list", () => {
    const record = clone(AGGREGATE_EXAMPLES.JobContract);
    record.repair = { ...repair, gates: [] };
    expect(JobContractSchema.safeParse(record).success).toBe(false);
  });

  it("requires a decisionId", () => {
    const record = clone(AGGREGATE_EXAMPLES.JobContract);
    const { decisionId: _decisionId, ...rest } = repair;
    record.repair = rest;
    expect(JobContractSchema.safeParse(record).success).toBe(false);
  });

  it("is never set together with strandId", () => {
    const record = clone(AGGREGATE_EXAMPLES.JobContract);
    record.repair = repair;
    record.strandId = "S-01";
    expect(JobContractSchema.safeParse(record).success).toBe(false);
  });

  it("every existing stored contract, with no repair, still parses", () => {
    expect(JobContractSchema.safeParse(AGGREGATE_EXAMPLES.JobContract).success).toBe(true);
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

  it("accepts the P15 gate-health types (D-P15-03, D-P15-04, D-P15-06)", () => {
    const record = clone(AGGREGATE_EXAMPLES.Event);
    const commit = "0123456789abcdef0123456789abcdef01234567";

    expect(
      EventSchema.safeParse({
        ...record,
        type: "gate.red",
        payload: { baseCommit: commit, failing: ["build"] },
      }).success,
    ).toBe(true);

    expect(
      EventSchema.safeParse({
        ...record,
        type: "gate.flaked",
        payload: {
          verificationId: EXAMPLE_IDS.verificationId,
          commitSha: commit,
          stepIds: ["test"],
        },
      }).success,
    ).toBe(true);

    expect(
      EventSchema.safeParse({
        ...record,
        type: "gate.repaired",
        payload: {
          jobContractId: EXAMPLE_IDS.jobContractId,
          decisionId: EXAMPLE_IDS.decisionId,
          cause: "red_base",
          definitionsChanged: true,
        },
      }).success,
    ).toBe(true);
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

describe("a program contract's scope", () => {
  it("requires at least one include, so a plan always says where the program lies", () => {
    expect(
      ProgramContractScopeSchema.safeParse({ includes: [], excludes: [], forbiddenActions: [] })
        .success,
    ).toBe(false);
  });

  it("reads a contract written before 2026-10-09 with its permissions, and needs none since", () => {
    const old = {
      includes: ["src/**"],
      excludes: [],
      permissions: ["fs.read", "fs.write", "shell.exec"],
      forbiddenActions: ["deploy to production"],
    };
    expect(ProgramContractScopeSchema.parse(old)).toEqual(old);
    const { permissions: _permissions, ...current } = old;
    expect(ProgramContractScopeSchema.parse(current)).toEqual(current);
  });
});

/**
 * The owner's ruling, 2026-10-09: jobs carry no path scope. A node or a Job
 * Contract stored before it has a `scope`, which every read drops, so nothing
 * that reads one and writes it back carries it on.
 */
describe("records stored before jobs lost their path scope", () => {
  const oldScope = {
    includes: ["src/billing/**"],
    excludes: ["src/generated/**"],
    permissions: ["fs.read", "fs.write"],
    forbiddenActions: ["deploy to production"],
  };

  it("parses a stored ExecutionNode with a scope, and drops it", () => {
    const stored = { ...clone(AGGREGATE_EXAMPLES.ExecutionNode), scope: oldScope };
    const parsed = ExecutionNodeSchema.parse(stored);
    expect(parsed).not.toHaveProperty("scope");
    expect(parsed).toEqual(AGGREGATE_EXAMPLES.ExecutionNode);
  });

  it("parses a stored JobContract with a requested scope, and drops it", () => {
    const stored = {
      ...clone(AGGREGATE_EXAMPLES.JobContract),
      scope: { includes: ["src/billing/**"], excludes: ["src/generated/**"] },
    };
    const parsed = JobContractSchema.parse(stored);
    expect(parsed).not.toHaveProperty("scope");
    expect(parsed).toEqual(AGGREGATE_EXAMPLES.JobContract);
  });

  it("stays strict about every other key", () => {
    expect(
      ExecutionNodeSchema.safeParse({ ...clone(AGGREGATE_EXAMPLES.ExecutionNode), reach: "all" })
        .success,
    ).toBe(false);
    expect(
      JobContractSchema.safeParse({ ...clone(AGGREGATE_EXAMPLES.JobContract), reach: "all" })
        .success,
    ).toBe(false);
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
