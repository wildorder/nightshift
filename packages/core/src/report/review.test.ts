import {
  AGGREGATE_EXAMPLES,
  type AttemptCause,
  type Decision,
  type Event,
  type Examination,
  type ExaminationFinding,
  type ExecutionNode,
  type ExecutionNodeStatus,
  type MeasurementSummary,
  type RoutingDecision,
} from "@nightshift/contracts";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  createFixtures,
  FIXTURE_TIMESTAMP,
  makeDecision,
  makeEvent,
  makeNode,
} from "../testing/factories.js";
import { DISPOSITION_NOTE, type ReviewReport, reviewOf } from "./review.js";

const world = () => {
  const f = createFixtures();
  const nodes: ExecutionNode[] = [];
  const routes: RoutingDecision[] = [];
  const examinations: Examination[] = [];
  const decisions: Decision[] = [];
  const measurements: MeasurementSummary[] = [];
  const events: Event[] = [];
  let seq = 0;
  const job = (status: ExecutionNodeStatus, parent?: ExecutionNode): ExecutionNode => {
    const node = makeNode(f, parent?.executionNodeId ?? f.rootNodeId, { status });
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
    delete (decision as { purpose?: unknown }).purpose;
    delete (decision as { causes?: unknown }).causes;
    delete (decision as { concerning?: unknown }).concerning;
    Object.assign(decision, over);
    routes.push(decision);
    return decision;
  };
  const summary = (decision: RoutingDecision, over: Partial<MeasurementSummary>) => {
    seq += 1;
    measurements.push({
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
    } as MeasurementSummary);
  };
  const finding = (id: string, over: Partial<ExaminationFinding> = {}): ExaminationFinding => ({
    id,
    severity: "material",
    summary: "s",
    evidence: [{ kind: "contract", clause: "c" }],
    resolution: "unresolved",
    ...over,
  });
  let clock = 0;
  const exam = (
    node: ExecutionNode,
    id: string,
    findings: ExaminationFinding[],
    over: Partial<Examination> = {},
  ): Examination => {
    clock += 1;
    const e = {
      ...structuredClone(AGGREGATE_EXAMPLES.Examination as Examination),
      examinationId: id as never,
      executionNodeId: node.executionNodeId,
      findings,
      outcome: findings.length === 0 ? "passed" : "findings_raised",
      createdAt: `2026-10-01T00:00:${String(clock).padStart(2, "0")}.000Z`,
      ...over,
    } as Examination;
    delete (e as { followsRulings?: unknown }).followsRulings;
    Object.assign(e, over);
    examinations.push(e);
    return e;
  };
  const decision = (node: ExecutionNode, agentId: string | null): Decision => {
    const d = makeDecision(f, node.executionNodeId, { agentId: agentId as never });
    decisions.push(d);
    return d;
  };
  const agentId = (): string => f.ids.next("agent");
  const skipped = (node: ExecutionNode) =>
    events.push(
      makeEvent(f, { type: "examination.skipped", executionNodeId: node.executionNodeId }),
    );
  const report = () =>
    reviewOf({
      nodes,
      jobs: [],
      routes,
      examinations,
      decisions,
      agents: [],
      measurements,
      events,
    });
  return { nodes, job, strand, route, summary, finding, exam, decision, skipped, agentId, report };
};

const cause = (c: AttemptCause): AttemptCause => c;
const usage = { inputTokens: 10, outputTokens: 1, inputIncludesCache: true };

describe("reviewOf findings", () => {
  it("joins a repeated finding into one chain, fixed by a clean examination, with its repair linked", () => {
    const w = world();
    const n = w.job("integrated");
    w.exam(n, "E1", [
      w.finding("F-01", {
        resolution: "fixed",
        resolvedBy: { authority: "agent", examinationId: "E3" as never, at: FIXTURE_TIMESTAMP },
      }),
    ]);
    w.exam(n, "E2", [
      w.finding("F-02", {
        repeats: { examinationId: "E1" as never, findingId: "F-01" },
        resolution: "fixed",
        resolvedBy: { authority: "agent", examinationId: "E3" as never, at: FIXTURE_TIMESTAMP },
      }),
    ]);
    w.exam(n, "E3", []);
    w.route(n, 1);
    const fix = w.route(n, 2, {
      causes: [
        cause({ kind: "examination_findings", examinationId: "E1" as never, findingIds: ["F-01"] }),
      ],
    });
    const r = w.report();
    expect(r.findings).toHaveLength(1);
    const [u] = r.findings;
    expect(u?.occurrences.map((o) => `${o.examinationId}:${o.findingId}`)).toEqual([
      "E1:F-01",
      "E2:F-02",
    ]);
    expect(u?.latest).toBe("fixed");
    expect(u?.open).toBe(false);
    expect(u?.fixedBy).toBe("E3");
    expect(u?.repairAttempts).toEqual([fix.routingDecisionId]);
    expect(u?.linkage).toBe("linked");
    expect(r.dispositions.unique).toBe(1);
    expect(r.dispositions.byLatest.fixed).toBe(1);
    expect(r.coverage.examinations).toEqual({
      total: 3,
      byOutcome: { passed: 1, findings_raised: 2, failed: 0 },
    });
    expect(r.linkage.findings).toEqual({ linked: 1, unresolved: 0, unknown: 0 });
  });

  it("follows a three-hop chain transitively and leaves it open", () => {
    const w = world();
    const n = w.job("running");
    w.exam(n, "E1", [w.finding("F-01", { severity: "minor" })]);
    w.exam(n, "E2", [
      w.finding("F-02", { repeats: { examinationId: "E1" as never, findingId: "F-01" } }),
    ]);
    w.exam(n, "E3", [
      w.finding("F-03", { repeats: { examinationId: "E2" as never, findingId: "F-02" } }),
    ]);
    const r = w.report();
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]?.occurrences).toHaveLength(3);
    expect(r.findings[0]?.severity).toBe("material");
    expect(r.findings[0]?.open).toBe(true);
    expect(r.findings[0]?.linkage).toBe("unresolved");
    expect(r.dispositions.byLatest.unresolved).toBe(1);
  });

  it("keeps an upheld ruling and its carrying-out attempt, even when the finding is repeated afterwards", () => {
    const w = world();
    const n = w.job("running");
    const arbiter = w.agentId();
    const d = w.decision(n, arbiter);
    w.exam(n, "E1", [
      w.finding("F-01", {
        resolution: "upheld",
        resolvedBy: { authority: "agent", decisionId: d.decisionId, at: FIXTURE_TIMESTAMP },
      }),
    ]);
    w.route(n, 1);
    const carry = w.route(n, 2, {
      causes: [
        cause({
          kind: "ruling",
          examinationId: "E1" as never,
          findingIds: ["F-01"],
          decisionIds: [d.decisionId],
        }),
      ],
    });
    let r = w.report();
    expect(r.findings[0]?.linkage).toBe("linked");
    expect(r.findings[0]?.repairAttempts).toEqual([carry.routingDecisionId]);
    expect(r.findings[0]?.open).toBe(false);
    expect(r.findings[0]?.repeatedAfterRuling).toBe(false);
    expect(r.findings[0]?.rulings).toEqual([
      {
        disposition: "upheld",
        examinationId: "E1",
        findingId: "F-01",
        decisionId: d.decisionId,
        agentId: arbiter,
      },
    ]);
    expect(r.dispositions.rulings).toEqual({ upheld: 1, overturned: 0, risk_accepted: 0 });
    expect(r.repairs.attempts).toBe(1);

    w.exam(n, "E2", [w.finding("F-09", { concerns: "F-01" })], {
      followsRulings: [
        { findingId: "F-01", decisionId: d.decisionId, summary: "s", rationale: "r" },
      ],
    });
    r = w.report();
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]?.occurrences).toHaveLength(2);
    expect(r.findings[0]?.open).toBe(true);
    expect(r.findings[0]?.repeatedAfterRuling).toBe(true);
    expect(r.findings[0]?.rulings).toHaveLength(1);
    expect(r.dispositions.rulings.upheld).toBe(1);
    expect(r.dispositions.byLatest.unresolved).toBe(1);
    expect(r.dispositions.byLatest.upheld).toBe(0);
  });

  it("leaves a finding unresolved when a failed empty examination follows", () => {
    const w = world();
    const n = w.job("running");
    w.exam(n, "E1", [w.finding("F-01")]);
    w.exam(n, "E2", [], { outcome: "failed" });
    const r = w.report();
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]?.latest).toBe("unresolved");
    expect(r.findings[0]?.fixedBy).toBeUndefined();
    expect(r.findings[0]?.linkage).toBe("unresolved");
    expect(r.linkage.findings).toEqual({ linked: 0, unresolved: 1, unknown: 0 });
    expect(r.coverage.examinations.byOutcome).toEqual({ passed: 0, findings_raised: 1, failed: 1 });
  });

  it("marks a legacy fixed finding with no naming attempt as unknown", () => {
    const w = world();
    const n = w.job("integrated");
    w.exam(n, "E1", [w.finding("F-01", { resolution: "fixed" })]);
    w.route(n, 1);
    w.route(n, 2, { causes: [cause({ kind: "integration_conflict" })] });
    const r = w.report();
    expect(r.findings[0]?.linkage).toBe("unknown");
    expect(r.linkage.findings).toEqual({ linked: 0, unresolved: 0, unknown: 1 });
    expect(r.repairs.attempts).toBe(0);
  });

  it("counts an attempt naming the examination with no finding list as a repair of every finding", () => {
    const w = world();
    const n = w.job("integrated");
    w.exam(n, "E1", [
      w.finding("F-01", { resolution: "fixed" }),
      w.finding("F-02", { resolution: "fixed" }),
    ]);
    w.route(n, 1);
    w.route(n, 2, {
      causes: [cause({ kind: "examination_findings", examinationId: "E1" as never })],
    });
    const r = w.report();
    expect(r.findings).toHaveLength(2);
    expect(r.linkage.findings.linked).toBe(2);
    expect(r.linkage.repairsWithoutFindings).toBe(1);
  });
});

describe("reviewOf overhead and repairs", () => {
  it("splits helper routes by role and counts unlinked helpers", () => {
    const w = world();
    const n = w.job("running");
    const concerning = { kind: "examination", examinationId: "E1" as never } as const;
    w.route(n, 1, { purpose: "examine", concerning });
    w.route(n, 1, { purpose: "examine" });
    w.route(n, 1, { purpose: "answer", concerning });
    w.route(n, 1, { purpose: "arbitrate", concerning: { ...concerning, findingId: "F-01" } });
    w.route(n, 1, { purpose: "examine", concerning: { kind: "plan_review" } });
    const r = w.report();
    expect(r.overhead.examiner.calls).toBe(2);
    expect(r.overhead.answerer.calls).toBe(1);
    expect(r.overhead.arbiter.calls).toBe(1);
    expect(r.overhead.planReview.calls).toBe(1);
    expect(r.linkage.helpersUnlinked).toBe(1);
    expect(r.repairs.attempts).toBe(0);
  });

  it("keeps repair resources apart from examiner resources, each with its coverage", () => {
    const w = world();
    const n = w.job("integrated");
    w.route(n, 1, { usage: { inputTokens: 1000, outputTokens: 100, inputIncludesCache: true } });
    const ex = w.route(n, 1, { purpose: "examine", usage });
    w.summary(ex, {
      totals: { inputTokens: 10, outputTokens: 1, inputIncludesCache: true },
      coverage: "partial",
    });
    const fix = w.route(n, 2, {
      usage: { inputTokens: 500, outputTokens: 50, inputIncludesCache: true },
      causes: [
        cause({ kind: "examination_findings", examinationId: "E1" as never, findingIds: ["F-01"] }),
      ],
    });
    w.summary(fix, { totals: { inputTokens: 500, outputTokens: 50, inputIncludesCache: true } });
    w.route(n, 3, { usage, causes: [cause({ kind: "integration_conflict" })] });
    const r = w.report();
    expect(r.overhead.examiner.calls).toBe(1);
    expect(r.overhead.examiner.resources.tokens.input).toBe(10);
    expect(r.overhead.examiner.resources.coverage.partial).toBe(1);
    expect(r.repairs.attempts).toBe(1);
    expect(r.repairs.resources.tokens.input).toBe(500);
    expect(r.repairs.resources.tokens.output).toBe(50);
    expect(r.repairs.resources.coverage.complete).toBe(1);
    expect(r.repairs.resources.coverage.partial).toBe(0);
  });
});

describe("reviewOf coverage", () => {
  it("separates merged jobs under an examined strand from landed work nobody examined", () => {
    const w = world();
    const examined = w.strand("integrated");
    const unexamined = w.strand("integrated");
    const open = w.strand("running");
    const a = w.job("merged", examined);
    const b = w.job("merged", examined);
    const c = w.job("merged", unexamined);
    w.job("merged", open);
    const direct = w.job("integrated");
    const reviewed = w.job("integrated");
    w.exam(examined, "ES", []);
    w.exam(reviewed, "ER", []);
    expect([a, b, c].length).toBe(3);
    expect(direct.status).toBe("integrated");
    const r = w.report();
    expect(r.coverage.examinedByStrand).toBe(2);
    expect(r.coverage.landedUnexamined).toBe(2);
    expect(r.coverage.examinedNodes).toBe(2);
    expect(r.coverage.examinations.total).toBe(2);
  });

  it("counts skipped examinations by node, latest only", () => {
    const w = world();
    const a = w.job("integrated");
    const b = w.job("integrated");
    w.skipped(a);
    w.skipped(a);
    w.skipped(b);
    expect(w.report().coverage.skipped).toBe(2);
  });
});

describe("reviewOf report shape", () => {
  it("states what dispositions do and do not establish and has no accuracy field", () => {
    const r = world().report();
    expect(r.dispositions.note).toBe(DISPOSITION_NOTE);
    expect(r.dispositions.note).toContain("not raised again");
    expect(r.dispositions.note).toContain("arbiter agreed");
    for (const key of ["accuracy", "precision", "truePositive", "defectFree"]) {
      expect(JSON.stringify(r)).not.toContain(key);
    }
    expectTypeOf<keyof ReviewReport>().toEqualTypeOf<
      "coverage" | "findings" | "dispositions" | "overhead" | "repairs" | "linkage"
    >();
    expectTypeOf<ReviewReport["dispositions"]>().not.toHaveProperty("accuracy");
  });
});
