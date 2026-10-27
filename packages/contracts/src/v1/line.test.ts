import { describe, expect, it } from "vitest";
import { inheritFromConfig, NightshiftConfigSchema } from "./config.js";
import { AGGREGATE_EXAMPLES } from "./examples.js";
import {
  LineBundleUploadUrlBodySchema,
  LineCompositionBodySchema,
  LineConfigSchema,
  LineDispatchSchema,
  LineParkBodySchema,
  LinePushBodySchema,
  LineRecordSchema,
  LineVerificationSchema,
  LineViewSchema,
  TakeLineBatchBodySchema,
} from "./line.js";
import { LinePrincipalSchema, LineTokenClaimsSchema, TokenClaimsSchema } from "./principal.js";
import { ProgramContractSchema } from "./program-contract.js";

const PROJECT = "proj_01J0000000000000000000000A";
const PROGRAM = "prog_01J0000000000000000000000A";
const AGENT = "agent_01J0000000000000000000000A";
const VER = "ver_01J0000000000000000000000A";
const A = "a".repeat(40);
const B = "b".repeat(40);
const AT = "2026-10-27T00:00:00.000Z";

const verification = {
  verificationId: VER,
  phase: "line",
  commitSha: B,
  baseSha: A,
  commands: [{ stepId: "test", command: "npm test", exitCode: 0, durationMs: 5 }],
  outcome: "passed",
  startedAt: AT,
  endedAt: AT,
};

const record = {
  schemaVersion: 1,
  projectId: PROJECT,
  branch: "nightshift/develop",
  repositoryUrl: "https://github.com/example/app",
  version: 1,
  queue: [{ program: PROGRAM, upTo: A, enqueuedAt: AT }],
  compositions: [],
  parked: [],
  updatedAt: AT,
};

describe("the line setting", () => {
  const base = NightshiftConfigSchema.parse({
    schemaVersion: 1,
    projectId: PROJECT,
    contextDocs: [],
    verification: [{ id: "test", command: "npm test" }],
    modelPolicy: { allowedProviders: ["anthropic"], allowedModels: [], forbiddenModels: [] },
    delegationLimits: { maxDepth: 3, maxConcurrency: 4 },
    costPolicy: {},
  });

  it("accepts a branch, and a positive monthly cap", () => {
    expect(LineConfigSchema.parse({ branch: "nightshift/develop" })).toEqual({
      branch: "nightshift/develop",
    });
    expect(LineConfigSchema.safeParse({ branch: "x", monthlyUsd: 10 }).success).toBe(true);
    expect(LineConfigSchema.safeParse({ branch: "" }).success).toBe(false);
    expect(LineConfigSchema.safeParse({ branch: "x", monthlyUsd: 0 }).success).toBe(false);
    expect(LineConfigSchema.safeParse({ branch: "x", extra: 1 }).success).toBe(false);
  });

  it("is optional on the config, which means off", () => {
    expect(base.line).toBeUndefined();
    const on = NightshiftConfigSchema.parse({ ...base, line: { branch: "nightshift/develop" } });
    expect(on.line).toEqual({ branch: "nightshift/develop" });
  });

  it("is inherited into a contract that does not state it, and a stated one wins", () => {
    const on = NightshiftConfigSchema.parse({
      ...base,
      line: { branch: "nightshift/develop", monthlyUsd: 40 },
    });
    const merged = inheritFromConfig({ objective: "x" }, on) as Record<string, unknown>;
    expect(merged.line).toEqual({ branch: "nightshift/develop", monthlyUsd: 40 });
    const stated = inheritFromConfig({ line: { branch: "other" } }, on) as Record<string, unknown>;
    expect(stated.line).toEqual({ branch: "other" });
    expect("line" in (inheritFromConfig({ objective: "x" }, base) as object)).toBe(false);
  });

  it("leaves a contract without it parsing exactly as before, and carries it when stated", () => {
    const example = AGGREGATE_EXAMPLES.ProgramContract as Record<string, unknown>;
    const parsed = ProgramContractSchema.parse(example);
    expect("line" in parsed).toBe(false);
    expect(JSON.stringify(parsed)).toBe(JSON.stringify(ProgramContractSchema.parse(parsed)));
    const withLine = ProgramContractSchema.parse({ ...example, line: { branch: "x" } });
    expect(withLine.line).toEqual({ branch: "x" });
  });
});

describe("the line record", () => {
  it("parses a queued line, and refuses a stray key", () => {
    expect(LineRecordSchema.safeParse(record).success).toBe(true);
    expect(LineRecordSchema.safeParse({ ...record, stray: 1 }).success).toBe(false);
    expect(LineRecordSchema.safeParse({ ...record, version: 0 }).success).toBe(false);
  });

  it("holds a composition whose verification agrees with its commands", () => {
    const composition = {
      compositionId: "comp-1",
      commit: B,
      parent: A,
      ranges: [{ program: PROGRAM, upTo: A }],
      verification,
      resolver: { decision: "resolved", attempts: 2 },
      composedAt: AT,
    };
    expect(LineRecordSchema.safeParse({ ...record, compositions: [composition] }).success).toBe(
      true,
    );
    const lying = { ...verification, outcome: "failed" };
    expect(LineVerificationSchema.safeParse(lying).success).toBe(false);
    expect(
      LineRecordSchema.safeParse({
        ...record,
        compositions: [{ ...composition, verification: lying }],
      }).success,
    ).toBe(false);
  });

  it("bounds the resolver's attempts at three", () => {
    const body = {
      batchId: "batch-1",
      commit: B,
      parent: A,
      ranges: [{ program: PROGRAM, from: A, upTo: B }],
      verification,
    };
    expect(
      LineCompositionBodySchema.safeParse({
        ...body,
        resolver: { decision: "gave_up", attempts: 3 },
      }).success,
    ).toBe(true);
    expect(
      LineCompositionBodySchema.safeParse({
        ...body,
        resolver: { decision: "gave_up", attempts: 4 },
      }).success,
    ).toBe(false);
  });

  it("only ever carries a line verification", () => {
    expect(LineVerificationSchema.safeParse({ ...verification, phase: "queue" }).success).toBe(
      false,
    );
  });
});

describe("the line's request bodies and view", () => {
  it("parses each body", () => {
    expect(TakeLineBatchBodySchema.safeParse({ generation: 2 }).success).toBe(true);
    expect(TakeLineBatchBodySchema.safeParse({ generation: 0 }).success).toBe(false);
    expect(
      LineParkBodySchema.safeParse({
        batchId: "b",
        ranges: [{ program: PROGRAM, upTo: A }],
        reason: "conflict the resolver gave up on",
      }).success,
    ).toBe(true);
    expect(
      LinePushBodySchema.safeParse({ head: B, expectedPredecessor: A, bundleKey: "k" }).success,
    ).toBe(true);
    expect(LineBundleUploadUrlBodySchema.safeParse({ generation: 1, id: "x" }).success).toBe(true);
  });

  it("views a line with its programs", () => {
    expect(
      LineViewSchema.safeParse({
        record,
        programs: [{ program: PROGRAM, branch: "program/x" }],
      }).success,
    ).toBe(true);
  });
});

describe("the line dispatch", () => {
  const dispatch = {
    schemaVersion: 1,
    projectId: PROJECT,
    branch: "nightshift/develop",
    version: 1,
    status: "stopped",
    tier: "good",
    instanceType: "c8id.2xlarge",
    usdPerHour: 0.4,
    amiVersion: "1.0.0",
    generation: 3,
    engineAgentId: AGENT,
    attempts: [{ generation: 3, reason: "dispatch", startedAt: AT }],
    spend: { estimatedUsd: 0.4, meteredUsd: 0.1, meteredSeconds: 900 },
    cleanup: { volumeDeleted: true, failures: [], settledAt: AT },
    requestedAt: AT,
    updatedAt: AT,
  };

  it("records when its cleanup settled, and the line's own failure codes", () => {
    expect(LineDispatchSchema.parse(dispatch).cleanup.settledAt).toBe(AT);
    for (const code of ["line_cap", "org_month"]) {
      expect(
        LineDispatchSchema.safeParse({
          ...dispatch,
          status: "failed",
          failure: { code, message: "m" },
        }).success,
      ).toBe(true);
    }
    expect(
      LineDispatchSchema.safeParse({
        ...dispatch,
        failure: { code: "input_refused", message: "m" },
      }).success,
    ).toBe(false);
  });
});

describe("the line principal and its token", () => {
  const principal = {
    kind: "line",
    projectId: PROJECT,
    branch: "nightshift/develop",
    agentId: AGENT,
    generation: 2,
  };

  it("is a principal with a generation and no run", () => {
    expect(LinePrincipalSchema.safeParse(principal).success).toBe(true);
    expect(LinePrincipalSchema.safeParse({ ...principal, runId: "x" }).success).toBe(false);
  });

  it("is an alternative in the token claims", () => {
    const claims = {
      iss: "https://api.example",
      sub: AGENT,
      aud: "nightshift-api",
      nightshift: principal,
      iat: 1,
      exp: 2,
    };
    expect(LineTokenClaimsSchema.safeParse(claims).success).toBe(true);
    expect(TokenClaimsSchema.safeParse(claims).success).toBe(true);
  });
});
