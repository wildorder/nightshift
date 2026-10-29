import { describe, expect, it } from "vitest";
import { inheritFromConfig, NightshiftConfigSchema } from "./config.js";
import { AGGREGATE_EXAMPLES } from "./examples.js";
import {
  LineBundleUploadUrlBodySchema,
  LineCompositionBodySchema,
  LineConfigSchema,
  LineParkBodySchema,
  LinePushBodySchema,
  LineRecordSchema,
  LineSettleBodySchema,
  LineVerificationSchema,
  LineViewSchema,
  TakeLineBatchBodySchema,
} from "./line.js";
import { ProgramContractSchema } from "./program-contract.js";

const PROJECT = "proj_01J0000000000000000000000A";
const PROGRAM = "prog_01J0000000000000000000000A";
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
    modelPolicy: {
      allowedProviders: ["anthropic"],
      allowedModels: [],
      forbiddenModels: [],
    },
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
    const on = NightshiftConfigSchema.parse({
      ...base,
      line: { branch: "nightshift/develop" },
    });
    expect(on.line).toEqual({ branch: "nightshift/develop" });
  });

  it("is inherited into a contract that does not state it, and a stated one wins", () => {
    const on = NightshiftConfigSchema.parse({
      ...base,
      line: { branch: "nightshift/develop", monthlyUsd: 40 },
    });
    const merged = inheritFromConfig({ objective: "x" }, on) as Record<string, unknown>;
    expect(merged.line).toEqual({
      branch: "nightshift/develop",
      monthlyUsd: 40,
    });
    const stated = inheritFromConfig({ line: { branch: "other" } }, on) as Record<string, unknown>;
    expect(stated.line).toEqual({ branch: "other" });
    expect("line" in (inheritFromConfig({ objective: "x" }, base) as object)).toBe(false);
  });

  it("leaves a contract without it parsing exactly as before, and carries it when stated", () => {
    const example = AGGREGATE_EXAMPLES.ProgramContract as Record<string, unknown>;
    const parsed = ProgramContractSchema.parse(example);
    expect("line" in parsed).toBe(false);
    expect(JSON.stringify(parsed)).toBe(JSON.stringify(ProgramContractSchema.parse(parsed)));
    const withLine = ProgramContractSchema.parse({
      ...example,
      line: { branch: "x" },
    });
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

  it("settles a batch with a composition, parked entries, both or neither", () => {
    const composition = {
      commit: B,
      parent: A,
      ranges: [{ program: PROGRAM, upTo: B }],
      verification,
    };
    const parked = {
      ranges: [{ program: PROGRAM, upTo: A }],
      reason: "conflict",
    };
    const ok = (body: unknown) => LineSettleBodySchema.safeParse(body).success;
    const push = { head: B, expectedPredecessor: A, bundleKey: "k" };
    expect(ok({ batchId: "b", composition, push, parked: [] })).toBe(true);
    expect(ok({ batchId: "b", composition, parked: [] })).toBe(false);
    expect(ok({ batchId: "b", push, parked: [] })).toBe(false);
    expect(ok({ batchId: "b", composition, push: { ...push, head: A }, parked: [] })).toBe(false);
    expect(
      ok({
        batchId: "b",
        composition,
        push: { ...push, expectedPredecessor: B },
        parked: [],
      }),
    ).toBe(false);
    expect(ok({ batchId: "b", parked: [parked] })).toBe(true);
    expect(ok({ batchId: "b", composition, push, parked: [parked] })).toBe(true);
    expect(ok({ batchId: "b", parked: [] })).toBe(true);
    expect(
      ok({
        batchId: "b",
        composition: { ...composition, ranges: [] },
        push,
        parked: [],
      }),
    ).toBe(false);
    expect(
      ok({
        batchId: "b",
        composition: { ...composition, batchId: "b" },
        push,
        parked: [],
      }),
    ).toBe(false);
    expect(ok({ batchId: "b", parked: [], stray: 1 })).toBe(false);
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
      LinePushBodySchema.safeParse({
        head: B,
        expectedPredecessor: A,
        bundleKey: "k",
      }).success,
    ).toBe(true);
    expect(LineBundleUploadUrlBodySchema.safeParse({ generation: 1, id: "x" }).success).toBe(true);
  });

  it("views a line with its programs", () => {
    expect(
      LineViewSchema.safeParse({
        record,
        programId: "prog_01J0000000000000000000000B",
        programs: [{ program: PROGRAM, branch: "program/x" }],
      }).success,
    ).toBe(true);
    expect(
      LineViewSchema.safeParse({
        record,
        programId: "prog_01J0000000000000000000000B",
        runId: "run_01J0000000000000000000000A",
        dispatchStatus: "running",
        generation: 2,
        meteredUsd: 0.5,
        programs: [],
      }).success,
    ).toBe(true);
  });
});

describe("a legacy line record", () => {
  it("reads with its decisions and agents stripped", () => {
    const parsed = LineRecordSchema.parse({ ...record, decisions: [{ choice: "x" }], agents: [] });
    expect(parsed).toEqual(record);
    expect("decisions" in parsed).toBe(false);
  });
});
