/** A verification step says when it runs (A-57), and a run's verification has no job. */
import { describe, expect, it } from "vitest";
import { stepRunsAt, VerificationStepSchema } from "./program-contract.js";
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
