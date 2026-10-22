import {
  AGGREGATE_EXAMPLES,
  type AttemptCause,
  type ExecutionNode,
  type ExecutionNodeStatus,
  type JobContract,
  type MeasurementSummary,
  type RoutingDecision,
} from "@nightshift/contracts";
import { describe, expect, it } from "vitest";
import {
  createFixtures,
  FIXTURE_TIMESTAMP,
  makeJobContract,
  makeNode,
} from "../testing/factories.js";
import { attemptsOfNode, deliveryOf, finalOutcomeOf, workItemsOf } from "./delivery.js";

const world = () => {
  const f = createFixtures();
  const nodes: ExecutionNode[] = [];
  const jobs: JobContract[] = [];
  const routes: RoutingDecision[] = [];
  const measurements: MeasurementSummary[] = [];
  let seq = 0;
  const job = (
    status: ExecutionNodeStatus,
    opts: { parent?: ExecutionNode; repair?: "red_base" | "flaky"; reason?: string } = {},
  ): ExecutionNode => {
    const contract = makeJobContract(
      f,
      opts.repair === undefined
        ? {}
        : {
            repair: {
              cause: opts.repair,
              gates: ["lint"],
              decisionId: (AGGREGATE_EXAMPLES.Decision as { decisionId: never }).decisionId,
            },
          },
    );
    jobs.push(contract);
    const node = makeNode(f, opts.parent?.executionNodeId ?? f.rootNodeId, {
      jobContractId: contract.jobContractId,
      status,
      ...(opts.reason === undefined ? {} : { outcomeReason: opts.reason }),
    });
    nodes.push(node);
    return node;
  };
  const strand = (status: ExecutionNodeStatus): ExecutionNode => {
    const node = makeNode(f, f.rootNodeId, { kind: "sub-program", status });
    nodes.push(node);
    return node;
  };
  const route = (
    node: ExecutionNode,
    attempt: number,
    over: Partial<RoutingDecision> = {},
  ): RoutingDecision => {
    seq += 1;
    const decision = {
      ...structuredClone(AGGREGATE_EXAMPLES.RoutingDecision as RoutingDecision),
      routingDecisionId: `route-${seq}` as never,
      executionNodeId: node.executionNodeId,
      attempt,
      usage: {},
      ...over,
    } as RoutingDecision;
    routes.push(decision);
    return decision;
  };
  const summary = (
    decision: RoutingDecision,
    over: Partial<MeasurementSummary>,
  ): MeasurementSummary => {
    seq += 1;
    const s = {
      measurementVersion: 1,
      ...f.scope,
      measurementSummaryId: `meas-${seq}`,
      executionNodeId: decision.executionNodeId,
      agentId: `agent-${seq}`,
      role: "worker",
      routingDecisionId: decision.routingDecisionId,
      route: decision.chosen,
      observedModels: [],
      segments: [],
      totals: {},
      coverage: "complete",
      gaps: [],
      ledger: { chunks: 0, artifactIds: [], observationCount: 0, publishedCount: 0 },
      valuation: { source: "unknown" },
      createdAt: FIXTURE_TIMESTAMP,
      updatedAt: FIXTURE_TIMESTAMP,
      ...over,
    } as MeasurementSummary;
    measurements.push(s);
    return s;
  };
  const report = () => deliveryOf({ nodes, jobs, routes, verifications: [], measurements });
  return { nodes, routes, job, strand, route, summary, report };
};

const cause = (kind: AttemptCause["kind"]): AttemptCause => ({ kind });
const usage = { inputTokens: 10, outputTokens: 1, inputIncludesCache: true };

describe("deliveryOf", () => {
  it("counts the population and rework for landed, retried and failed jobs", () => {
    const w = world();
    const a = w.job("integrated");
    const b = w.job("integrated");
    const c = w.job("failed", { reason: "examination_failed: findings" });
    w.strand("running");
    w.route(a, 1, { usage });
    w.route(b, 1, { usage });
    w.route(b, 2, { usage, causes: [cause("integration_conflict")] });
    w.route(c, 1, { usage });
    w.route(c, 2, { usage, causes: [cause("examination_findings")] });
    w.route(c, 3, { usage, causes: [cause("examination_findings")] });
    w.route(a, 1, { purpose: "examine" });
    w.route(c, 1, { purpose: "arbitrate" });

    const r = w.report();
    expect(r).toMatchObject({
      workItems: 3,
      repairJobs: 0,
      strands: 1,
      attempts: 6,
      helperCalls: 2,
    });
    expect(r.firstAttempt).toMatchObject({ succeeded: 1, denominator: 3, unfinished: 0 });
    expect(r.firstAttempt.rate).toBeCloseTo(1 / 3);
    expect(r.outcomes.counts.landed).toBe(2);
    expect(r.outcomes.counts.failed).toBe(1);
    expect(r.outcomes.failedBy.examination_failed).toBe(1);
    expect(r.rework.attempts).toBe(3);
    expect(r.rework.byCause.map((x) => [x.kind, x.attempts, x.sharedAttempts])).toEqual([
      ["examination_findings", 2, 0],
      ["integration_conflict", 1, 0],
    ]);
    expect(r.rework.byCause[0]?.resources.tokens.input).toBe(20);
    expect(r.rework.unknownCause.attempts).toBe(0);
    expect(r.rework.resources.firstAttempts.tokens.input).toBe(30);
    expect(r.rework.resources.rework.tokens.input).toBe(30);
  });

  it("counts a gate repair job apart from first-attempt success excluding repairs", () => {
    const w = world();
    const normal = w.job("integrated");
    const repair = w.job("integrated", { repair: "red_base" });
    w.route(normal, 1, { usage });
    w.route(repair, 1, { usage });
    const r = w.report();
    expect(r.workItems).toBe(2);
    expect(r.repairJobs).toBe(1);
    expect(r.rework.attempts).toBe(1);
    expect(r.rework.byCause).toHaveLength(1);
    expect(r.rework.byCause[0]).toMatchObject({ kind: "gate_repair:red_base", attempts: 1 });
    expect(r.rework.resources.firstAttempts.tokens.input).toBe(10);
    expect(r.firstAttempt).toMatchObject({ succeeded: 2, denominator: 2 });
    expect(r.firstAttempt.excludingRepairs).toMatchObject({ succeeded: 1, denominator: 1 });
  });

  it("settles merged jobs by their strand", () => {
    const w = world();
    const landed = w.strand("integrated");
    const failed = w.strand("failed");
    const running = w.strand("running");
    const m1 = w.job("merged", { parent: landed });
    const m2 = w.job("merged", { parent: failed });
    const m3 = w.job("merged", { parent: running });
    for (const m of [m1, m2, m3]) w.route(m, 1, { usage });
    expect(finalOutcomeOf(m1, w.nodes)).toBe("landed");
    expect(finalOutcomeOf(m2, w.nodes)).toBe("merged_strand_not_landed");
    expect(finalOutcomeOf(m3, w.nodes)).toBe("unfinished");
    const r = w.report();
    expect(r.strands).toBe(3);
    expect(r.outcomes.counts).toMatchObject({
      landed: 1,
      merged_strand_not_landed: 1,
      unfinished: 1,
    });
    expect(r.firstAttempt).toMatchObject({ succeeded: 1, denominator: 2, unfinished: 1 });
  });

  it("counts an attempt with two causes once, and unexplained retries as unknown", () => {
    const w = world();
    const a = w.job("integrated");
    const b = w.job("integrated");
    w.route(a, 1, { usage });
    w.route(a, 2, { usage, causes: [cause("examination_findings"), cause("ruling")] });
    w.route(b, 1, { usage });
    w.route(b, 2, { usage });
    const r = w.report();
    expect(r.rework.attempts).toBe(2);
    expect(r.rework.resources.rework.tokens.input).toBe(20);
    expect(r.rework.byCause.map((x) => [x.kind, x.attempts, x.sharedAttempts])).toEqual([
      ["examination_findings", 1, 1],
      ["ruling", 1, 1],
    ]);
    expect(r.rework.unknownCause.attempts).toBe(1);
    expect(r.rework.unknownCause.resources.tokens.input).toBe(10);
  });

  it("reports an unfinished node beside the denominator", () => {
    const w = world();
    const done = w.job("integrated");
    const running = w.job("running");
    w.route(done, 1, { usage });
    w.route(running, 1, { usage });
    const r = w.report();
    expect(r.firstAttempt).toMatchObject({ succeeded: 1, denominator: 1, unfinished: 1, rate: 1 });
    expect(r.firstAttempt.coverage).toBe("partial");
  });

  it("leaves the rate undefined with an empty denominator", () => {
    const w = world();
    w.route(w.job("running"), 1);
    expect(w.report().firstAttempt.rate).toBeUndefined();
  });

  it("marks coverage partial for a settled node with no routing decision", () => {
    const w = world();
    const a = w.job("integrated");
    w.job("integrated");
    w.route(a, 1, { usage });
    w.summary(w.routes[0] as RoutingDecision, { totals: usage });
    const r = w.report();
    expect(r.firstAttempt).toMatchObject({ succeeded: 1, denominator: 2 });
    expect(r.firstAttempt.coverage).toBe("partial");
    expect(r.firstAttempt.reasons.join(" ")).toContain("no routing decision");
  });

  it("keeps missing, legacy and complete token coverage and inclusive input apart", () => {
    const w = world();
    const n = w.job("integrated");
    const r1 = w.route(n, 1);
    const r2 = w.route(n, 2, { usage: { inputTokens: 5 }, causes: [cause("worker_failed")] });
    const r3 = w.route(n, 3, { causes: [cause("worker_failed")] });
    w.summary(r3, {
      totals: {
        inputTokens: 10,
        cacheReadTokens: 100,
        cacheWriteTokens: 5,
        inputIncludesCache: false,
      },
    });
    void r1;
    void r2;
    const r = w.report();
    const rework = r.rework.resources.rework;
    expect(rework.coverage).toMatchObject({ legacy: 1, complete: 1, missing: 0 });
    expect(rework.tokens.input).toBe(5 + 115);
    expect(rework.tokens.inputConventionUnknown).toBe(1);
    expect(rework.tokenCoverage).toBe("partial");
    expect(r.rework.resources.firstAttempts.coverage.missing).toBe(1);
    expect(r.firstAttempt.coverage).toBe("partial");
    expect(r.firstAttempt.reasons).toContain("token coverage of the work attempts is partial");
  });

  it("keeps estimated and reported dollars apart", () => {
    const w = world();
    const n = w.job("integrated");
    w.route(n, 1);
    w.route(n, 2, {
      usage: { estimatedCostUsd: 0.5, costSource: "estimated" },
      causes: [cause("worker_failed")],
    });
    w.route(n, 3, { usage: { actualCostUsd: 0.25 }, causes: [cause("worker_failed")] });
    const usd = w.report().rework.resources.rework.usd;
    expect(usd).toEqual({ estimated: 0.5, reported: 0.25 });
  });
});

describe("helpers", () => {
  it("selects job nodes and sorted work attempts", () => {
    const w = world();
    const n = w.job("integrated");
    w.strand("running");
    w.route(n, 2);
    w.route(n, 1);
    w.route(n, 1, { purpose: "examine" });
    expect(workItemsOf(w.nodes)).toHaveLength(1);
    expect(attemptsOfNode(w.routes).map((x) => x.attempt)).toEqual([1, 2]);
  });
});
