/** A verification step says when it runs (A-57), and a run's verification has no job. */
import { describe, expect, it } from "vitest";
import {
  SetupStepSchema,
  stepRunsAt,
  stepTime,
  VerificationStepSchema,
} from "./program-contract.js";
import { VerificationSchema } from "./verification.js";

const scope = {
  schemaVersion: 1,
  projectId: "proj_01HZZZZZZZZZZZZZZZZZZZZZZZ",
  programId: "prog_01HZZZZZZZZZZZZZZZZZZZZZZZ",
  runId: "run_01HZZZZZZZZZZZZZZZZZZZZZZZ",
};
const verification = {
  ...scope,
  verificationId: "ver_01HZZZZZZZZZZZZZZZZZZZZZZZ",
  executionNodeId: "node_01HZZZZZZZZZZZZZZZZZZZZZZZ",
  agentId: "agent_01HZZZZZZZZZZZZZZZZZZZZZZZ",
  commitSha: "a".repeat(40),
  commands: [{ stepId: "e2e", command: "npm run e2e", exitCode: 0, durationMs: 1 }],
  outcome: "passed",
  startedAt: "2026-10-15T00:00:00.000Z",
  endedAt: "2026-10-15T00:01:00.000Z",
};

describe("when a verification step runs", () => {
  it("is on every landing unless the step says the end", () => {
    const landing = VerificationStepSchema.parse({ id: "test", command: "npm test" });
    const end = VerificationStepSchema.parse({ id: "e2e", command: "npm run e2e", at: "end" });
    expect(stepRunsAt(landing)).toBe("landing");
    expect(stepRunsAt(end)).toBe("end");
    expect(
      VerificationStepSchema.safeParse({ id: "e2e", command: "npm run e2e", at: "nightly" })
        .success,
    ).toBe(false);
  });
});

describe("a run verification", () => {
  it("has no job, and only it may have none", () => {
    expect(
      VerificationSchema.safeParse({ ...verification, phase: "run", jobContractId: null }).success,
    ).toBe(true);
    expect(
      VerificationSchema.safeParse({
        ...verification,
        jobContractId: "job_01HZZZZZZZZZZZZZZZZZZZZZZZ",
      }).success,
    ).toBe(true);
    // A queue verification without a job, or a run verification with one, is neither.
    expect(VerificationSchema.safeParse({ ...verification, jobContractId: null }).success).toBe(
      false,
    );
    expect(
      VerificationSchema.safeParse({
        ...verification,
        phase: "run",
        jobContractId: "job_01HZZZZZZZZZZZZZZZZZZZZZZZ",
      }).success,
    ).toBe(false);
  });
});

describe("a step's own time (P19)", () => {
  const schemas = [
    ["verification", VerificationStepSchema],
    ["setup", SetupStepSchema],
  ] as const;

  it.each(schemas)("%s accepts the fields, and stepTime reads them in ms", (_name, schema) => {
    const step = schema.parse({ id: "trial", command: "x", timeoutSeconds: 90, cleanupSeconds: 5 });
    expect(stepTime(step)).toEqual({ timeoutMs: 90_000, cleanupMs: 5_000 });
  });

  it.each(schemas)("%s: absent fields give the defaults", (_name, schema) => {
    expect(stepTime(schema.parse({ id: "trial", command: "x" }))).toEqual({
      timeoutMs: 600_000,
      cleanupMs: 30_000,
    });
  });

  it.each(schemas)("%s accepts exactly the maximums", (_name, schema) => {
    const step = schema.parse({
      id: "trial",
      command: "x",
      timeoutSeconds: 7200,
      cleanupSeconds: 3600,
    });
    expect(stepTime(step)).toEqual({ timeoutMs: 7_200_000, cleanupMs: 3_600_000 });
  });

  it.each(schemas)("%s refuses past the maximums, naming step, field and maximum", (_n, schema) => {
    const result = schema.safeParse({
      id: "trial",
      command: "x",
      timeoutSeconds: 7201,
      cleanupSeconds: 3601,
    });
    expect(result.success).toBe(false);
    const issues = result.error?.issues ?? [];
    expect(issues.map((i) => [i.path, i.message])).toEqual([
      [
        ["timeoutSeconds"],
        'step "trial": timeoutSeconds 7201 is over the maximum of 7200 seconds (two hours); past that, skip the step (D-04)',
      ],
      [
        ["cleanupSeconds"],
        'step "trial": cleanupSeconds 3601 is over the maximum of 3600 seconds (one hour)',
      ],
    ]);
  });

  it.each(schemas)("%s refuses zero, negative and fractional values", (_name, schema) => {
    for (const field of ["timeoutSeconds", "cleanupSeconds"]) {
      for (const value of [0, -1, 1.5]) {
        expect(schema.safeParse({ id: "t", command: "x", [field]: value }).success).toBe(false);
      }
    }
  });
});
