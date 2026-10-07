import { describe, expect, it } from "vitest";
import { createFixtures, makeProgramContract, makeRun } from "../testing/factories.js";
import type { JobReport, RunReport, StrandReport } from "./report.js";
import { programStatus } from "./status.js";

const f = createFixtures();
const job = (over: Partial<JobReport> = {}): JobReport => ({
  nodeId: "node_x",
  objective: "a job",
  status: "integrated",
  commitSha: "a".repeat(40),
  attempts: 1,
  reason: undefined,
  routes: [],
  examinations: [],
  ...over,
});
const strand = (over: Partial<StrandReport> = {}): StrandReport => ({
  id: "S-01",
  name: "The store",
  outcome: "succeeded",
  acceptance: ["it works"],
  reason: undefined,
  blockedBy: [],
  jobs: [job()],
  departures: [],
  attempts: 1,
  waitingOn: [],
  nodeIds: [],
  ...over,
});
const report = (over: Partial<RunReport> = {}): RunReport => ({
  program: makeProgramContract(f, { costPolicy: { maxUsd: 25 } }),
  run: makeRun(f, { status: "succeeded" }),
  strands: [],
  criteria: [],
  pendingPrerequisites: [],
  graph: [],
  corrections: [],
  usage: [],
  rulings: [],
  gateHealth: { audit: undefined, red: undefined, repairs: [], flakes: [] },
  ...over,
});

describe("programStatus (D-P13-09)", () => {
  it("counts what landed, what failed, what was retried and examined, and the spend against the budget", () => {
    const status = programStatus(
      report({
        strands: [
          strand({
            jobs: [job(), job({ attempts: 2 }), job({ status: "failed", commitSha: null })],
          }),
          strand({ id: "S-02", outcome: "failed", reason: "tests failed twice", jobs: [] }),
        ],
        usage: [
          {
            harness: "claude",
            model: "m",
            purpose: "work",
            attempts: 3,
            inputTokens: 1,
            outputTokens: 1,
            costUsd: 14.2,
            estimated: true,
            unpriced: 1,
          },
        ],
      }),
    );
    expect(status.strands).toEqual({ total: 2, succeeded: 1 });
    expect(status.jobs).toMatchObject({ total: 3, landed: 2, failed: 1, retried: 1 });
    expect(status.spend).toEqual({ usd: 14.2, estimated: true, unpriced: 1, budgetUsd: 25 });
    expect(status.waiting).toEqual([
      { kind: "failed", subject: "S-02 The store", reason: "tests failed twice" },
    ]);
  });

  it("puts a human prerequisite first, then provisional and blocked strands, each with a reason", () => {
    const status = programStatus(
      report({
        pendingPrerequisites: [
          {
            id: "HP-01",
            description: "The deploy key is in the store",
            remediation: "…",
            verifyCommand: "true",
            status: "pending",
          },
        ],
        strands: [
          strand({ id: "S-02", outcome: "provisional", waitingOn: ["HP-01"] }),
          strand({ id: "S-03", outcome: "pending", blockedBy: ["S-02"], jobs: [] }),
        ],
      }),
    );
    expect(status.waiting.map((w) => [w.kind, w.subject])).toEqual([
      ["prerequisite", "HP-01"],
      ["blocked", "S-03 The store"],
      ["provisional", "S-02 The store"],
    ]);
    expect(status.waiting[2]?.reason).toContain("HP-01");
  });

  it("counts an unplanned run's jobs when they are passed in", () => {
    const status = programStatus(report(), [
      job(),
      job({ status: "verification_failed", commitSha: null, reason: "npm test failed" }),
    ]);
    expect(status.jobs).toMatchObject({ total: 2, landed: 1, failed: 1 });
    expect(status.waiting).toEqual([
      { kind: "failed", subject: "a job", reason: "npm test failed" },
    ]);
  });
});
