import type {
  AttemptCause,
  ExecutionNode,
  IsoTimestamp,
  LifecycleObservation,
  RoutingDecision,
} from "@nightshift/contracts";
import { describe, expect, it } from "vitest";
import {
  createFixtures,
  makeAgent,
  makeJobContract,
  makeNode,
  makeRun,
} from "../testing/factories.js";
import { type OperationsInput, type OperationsReport, operationsOf } from "./operations.js";

const BASE = Date.parse("2026-01-01T00:00:00.000Z");
const at = (offsetMs: number): IsoTimestamp =>
  new Date(BASE + offsetMs).toISOString() as IsoTimestamp;

type Blockers = readonly { kind: string; ref: string }[];
interface Extra {
  op?: string;
  attempt?: number;
  reason?: string | undefined;
  blockers?: Blockers;
  /** No source time: only the receipt time is known. */
  receivedOnly?: boolean;
}

const makeWorld = (runEnd?: number) => {
  const f = createFixtures();
  const run = makeRun(f, {
    startedAt: at(0),
    ...(runEnd === undefined ? {} : { endedAt: at(runEnd), status: "succeeded" }),
  });
  const jobs: ReturnType<typeof makeJobContract>[] = [];
  const nodes: ExecutionNode[] = [];
  const addNode = (strandId?: string): ExecutionNode => {
    const job = makeJobContract(f, strandId === undefined ? {} : { strandId });
    jobs.push(job);
    const node = makeNode(f, f.rootNodeId, { jobContractId: job.jobContractId });
    nodes.push(node);
    return node;
  };
  const observations: LifecycleObservation[] = [];
  let n = 0;
  const emit = (
    node: ExecutionNode,
    phase: string,
    transition: "start" | "end" | "note",
    when: number,
    extra: Extra = {},
  ): void => {
    n += 1;
    observations.push({
      schemaVersion: 1,
      ...f.scope,
      observationId: `obs-${n}`,
      executionNodeId: node.executionNodeId,
      source: "engine",
      provenance: { adapter: "engine" },
      ...(extra.receivedOnly ? {} : { occurredAt: at(when) }),
      receivedAt: at(extra.receivedOnly ? when : when + 500),
      inclusion: "self",
      kind: "lifecycle",
      operationId: extra.op ?? `${phase}:${node.executionNodeId}`,
      ...(extra.attempt === undefined ? {} : { attempt: extra.attempt }),
      phase,
      transition,
      ...(extra.reason === undefined ? {} : { reason: extra.reason }),
      blockers: extra.blockers ?? [],
    } as LifecycleObservation);
  };
  /** start + end of one occurrence. */
  const span = (
    node: ExecutionNode,
    phase: string,
    from: number,
    to: number,
    extra: Extra & { endReason?: string } = {},
  ): void => {
    const { endReason, ...rest } = extra;
    emit(node, phase, "start", from, rest);
    emit(node, phase, "end", to, { ...rest, blockers: [], reason: endReason });
  };
  const report = (over: Partial<OperationsInput> = {}): OperationsReport =>
    operationsOf({
      run,
      nodes,
      jobs,
      agents: [],
      routes: [],
      verifications: [],
      examinations: [],
      observations,
      asOf: at(runEnd ?? 100_000),
      ...over,
    });
  return { f, run, nodes, jobs, observations, addNode, emit, span, report };
};

const ids = (r: OperationsReport) =>
  r.chain.steps.map((s) => `${s.phase}:${s.from}>${s.to}:${s.link}`);
const stepOf = (phase: string, from: number, to: number, link: string) =>
  `${phase}:${at(from)}>${at(to)}:${link}`;

describe("operationsOf: dependencies and concurrency", () => {
  it("chains through the dependency that landed last, and counts peak 2", () => {
    const w = makeWorld(14_000);
    const p1 = w.addNode("S-01");
    const p2 = w.addNode();
    const c = w.addNode();
    w.span(p1, "work", 0, 6000);
    w.span(p1, "integration", 6000, 8000, { endReason: "integrated" });
    w.span(p2, "work", 0, 8000);
    w.span(p2, "integration", 8000, 10_000, { endReason: "integrated" });
    const p2Job = w.jobs[1]?.jobContractId as string;
    w.emit(c, "wait", "start", 0, {
      blockers: [
        { kind: "job", ref: p2Job },
        { kind: "strand", ref: "S-01" },
      ],
    });
    w.emit(c, "wait", "end", 10_000);
    w.span(c, "work", 10_000, 12_000);
    w.span(c, "integration", 12_000, 14_000, { endReason: "integrated" });

    const r = w.report();
    expect(ids(r)).toEqual([
      stepOf("integration", 12_000, 14_000, "end"),
      stepOf("work", 10_000, 12_000, "work"),
      stepOf("wait", 0, 10_000, "attempt"),
      stepOf("integration", 8000, 10_000, "dependency"),
      stepOf("work", 0, 8000, "work"),
    ]);
    expect(r.chain.steps[3]?.nodeId).toBe(p2.executionNodeId);
    expect(r.chain.incomplete).toBe(false);
    expect(r.chain.coveredMs).toBe(14_000);
    expect(r.chain.coverage).toBe(1);
    expect(r.concurrency.peak).toBe(2);
    expect(r.concurrency.series.map((p) => [p.at, p.running])).toEqual([
      [at(0), 2],
      [at(6000), 1],
      [at(8000), 0],
      [at(10_000), 1],
      [at(12_000), 0],
    ]);
    expect(r.unions.work).toBe(10_000);
    expect(r.unions.wait).toBe(10_000);
    expect(r.unions.integration).toBe(6000);
    // 8 + 6 + 2 = 16 s of work in 14 s: summed work is not elapsed.
    expect(r.concurrency.averageOverElapsed).toBeCloseTo(16_000 / 14_000, 10);
    expect(r.unattributedMs).toBe(0);
  });

  it("follows the strand blocker when it lands last", () => {
    const w = makeWorld(13_000);
    const sub = w.addNode("S-01");
    const c = w.addNode();
    w.span(sub, "work", 0, 5000);
    w.span(sub, "integration", 5000, 9000, { endReason: "merged" });
    w.emit(c, "wait", "start", 0, { blockers: [{ kind: "strand", ref: "S-01" }] });
    w.emit(c, "wait", "end", 9000);
    w.span(c, "work", 9000, 12_000);
    w.span(c, "integration", 12_000, 13_000, { endReason: "integrated" });
    const r = w.report();
    expect(ids(r)).toEqual([
      stepOf("integration", 12_000, 13_000, "end"),
      stepOf("work", 9000, 12_000, "work"),
      stepOf("wait", 0, 9000, "attempt"),
      stepOf("integration", 5000, 9000, "dependency"),
      stepOf("work", 0, 5000, "work"),
    ]);
  });

  it("stops a capacity wait as unattributed", () => {
    const w = makeWorld(8000);
    const c = w.addNode();
    w.emit(c, "wait", "start", 0, { blockers: [{ kind: "parent_slot", ref: "slot" }] });
    w.emit(c, "wait", "end", 5000);
    w.span(c, "work", 5000, 7000);
    w.span(c, "integration", 7000, 8000, { endReason: "integrated" });
    const r = w.report();
    expect(r.chain.incomplete).toBe(true);
    expect(r.chain.stoppedBecause).toBe("capacity wait: unattributed");
    expect(ids(r)).toEqual([
      stepOf("integration", 7000, 8000, "end"),
      stepOf("work", 5000, 7000, "work"),
      stepOf("wait", 0, 5000, "attempt"),
    ]);
    expect(r.chain.coveredMs).toBe(8000);
  });
});

describe("operationsOf: own work against queue order", () => {
  const scenario = (aEnd: number) => {
    const w = makeWorld(11_000);
    const a = w.addNode();
    const b = w.addNode();
    w.span(a, "integration", 0, aEnd, { endReason: "integrated" });
    w.span(b, "work", 0, 9000);
    w.emit(b, "queue", "start", 9000, {
      blockers: [{ kind: "queue_predecessor", ref: a.executionNodeId }],
    });
    w.emit(b, "queue", "end", 10_000);
    w.span(b, "integration", 10_000, 11_000, { endReason: "integrated" });
    return { w, a, b };
  };

  it("goes through the predecessor's integration when it ended inside the queue span", () => {
    const { w, a } = scenario(10_000);
    const r = w.report();
    expect(ids(r)).toEqual([
      stepOf("integration", 10_000, 11_000, "end"),
      stepOf("integration", 0, 10_000, "queue_order"),
    ]);
    expect(r.chain.steps[1]?.nodeId).toBe(a.executionNodeId);
    expect(r.chain.coveredMs).toBe(11_000);
    expect(r.chain.ambiguous).toEqual([]);
    expect(r.unions.queue).toBe(1000);
  });

  it("goes through its own work when the predecessor ended before the queue span", () => {
    const { w, b } = scenario(8000);
    const r = w.report();
    expect(ids(r)).toEqual([
      stepOf("integration", 10_000, 11_000, "end"),
      stepOf("work", 0, 9000, "work"),
    ]);
    expect(r.chain.steps[1]?.nodeId).toBe(b.executionNodeId);
    expect(r.chain.coveredMs).toBe(10_000);
    expect(r.chain.coverage).toBeCloseTo(10 / 11, 10);
  });

  it("reports a tie within 1 ms and takes the first candidate", () => {
    const w = makeWorld(11_000);
    const a = w.addNode();
    const b = w.addNode();
    w.span(a, "integration", 0, 10_000, { endReason: "integrated" });
    w.span(b, "work", 0, 9999);
    w.emit(b, "queue", "start", 9999, {
      blockers: [{ kind: "queue_predecessor", ref: a.executionNodeId }],
    });
    w.emit(b, "queue", "end", 10_000);
    w.span(b, "integration", 10_000, 11_000, { endReason: "integrated" });
    const r = w.report();
    expect(r.chain.steps[1]?.link).toBe("queue_order");
    expect(r.chain.steps[1]?.nodeId).toBe(a.executionNodeId);
    expect(r.chain.ambiguous).toHaveLength(1);
    expect(r.chain.ambiguous[0]?.candidates.map((c) => [c.nodeId, c.link])).toEqual([
      [a.executionNodeId, "queue_order"],
      [b.executionNodeId, "work"],
    ]);
  });
});

describe("operationsOf: waits", () => {
  it("counts overlapping blocker sets once and keeps every kind", () => {
    const w = makeWorld(12_000);
    const n1 = w.addNode();
    const n2 = w.addNode();
    w.emit(n1, "wait", "start", 0, { blockers: [{ kind: "job", ref: "j1" }] });
    w.emit(n1, "wait", "note", 2000, {
      blockers: [
        { kind: "job", ref: "j1" },
        { kind: "parent_slot", ref: "p" },
      ],
    });
    // The same set again opens no new span.
    w.emit(n1, "wait", "note", 3000, {
      blockers: [
        { kind: "parent_slot", ref: "p" },
        { kind: "job", ref: "j1" },
      ],
    });
    w.emit(n1, "wait", "note", 5000, { blockers: [{ kind: "parent_slot", ref: "p" }] });
    w.emit(n1, "wait", "end", 8000, { reason: "started" });
    w.span(n2, "wait", 4000, 10_000, { blockers: [{ kind: "job", ref: "j2" }] });
    const r = w.report();
    const first = r.operations[0];
    expect(first?.state).toBe("closed");
    expect(first?.durationMs).toBe(8000);
    expect(first?.blockerSpans).toEqual([
      { from: at(0), to: at(2000), blockers: [{ kind: "job", ref: "j1" }] },
      {
        from: at(2000),
        to: at(5000),
        blockers: [
          { kind: "job", ref: "j1" },
          { kind: "parent_slot", ref: "p" },
        ],
      },
      { from: at(5000), to: at(8000), blockers: [{ kind: "parent_slot", ref: "p" }] },
    ]);
    expect(r.unions.wait).toBe(10_000);
    // job: 0..5 (n1) with 4..10 (n2); parent_slot: 2..8.
    expect(r.unions.waitByBlockerKind).toEqual({ job: 10_000, parent_slot: 6000 });
    expect(r.nodes[0]?.byPhase).toEqual({ wait: 8000 });
  });
});

describe("operationsOf: recovery and re-entry", () => {
  it("continues a recovered start as one occurrence from the earliest start", () => {
    const w = makeWorld(10_000);
    const n = w.addNode();
    w.emit(n, "work", "start", 1000);
    w.emit(n, "work", "start", 3000, { reason: "recovered" });
    w.emit(n, "work", "end", 6000);
    const r = w.report();
    expect(r.operations).toHaveLength(1);
    const op = r.operations[0];
    expect(op?.state).toBe("closed");
    expect(op?.startedAt).toBe(at(1000));
    expect(op?.durationMs).toBe(5000);
    expect(op?.notes).toEqual([{ at: at(3000), reason: "recovered" }]);
    expect(r.unions.work).toBe(5000);
  });

  it("keeps an unfinished operation after recovery open, apart from every union", () => {
    const w = makeWorld();
    const n = w.addNode();
    const m = w.addNode();
    w.emit(n, "work", "start", 1000);
    w.emit(n, "work", "start", 3000, { reason: "recovered" });
    // m's work was never finished, but its integration was observed to end.
    w.emit(m, "work", "start", 2000);
    w.span(m, "integration", 5000, 7000, { endReason: "integrated" });
    const r = w.report({ asOf: at(9000) });
    expect(r.operations.filter((o) => o.state === "open").map((o) => o.nodeId)).toEqual([
      n.executionNodeId,
      m.executionNodeId,
    ]);
    expect(r.ambiguousMs).toBe(8000 + 7000);
    expect(r.unions.work).toBe(0);
    expect(r.unions.integration).toBe(2000);
    expect(r.nodes[0]?.openCount).toBe(1);
    expect(r.nodes[0]?.activeSpan).toEqual({ from: at(1000) });
    expect(r.nodes[0]?.unattributedMs).toBeUndefined();
    expect(r.chain.incomplete).toBe(true);
    expect(r.chain.stoppedBecause).toBe(
      `no admissible predecessor of integration:${m.executionNodeId}#1 (unfinished: work:${m.executionNodeId}#1)`,
    );
    expect(r.elapsedMs).toBeUndefined();
    expect(r.concurrency.peak).toBe(2);
  });

  it("has no chain without an observed end", () => {
    const w = makeWorld();
    const n = w.addNode();
    w.emit(n, "work", "start", 0);
    const r = w.report();
    expect(r.chain).toEqual({
      steps: [],
      coveredMs: 0,
      incomplete: true,
      stoppedBecause: "no observed end",
      ambiguous: [],
    });
  });

  it("makes a re-entry a second occurrence and counts the idle time in neither", () => {
    const w = makeWorld(13_000);
    const n = w.addNode();
    w.span(n, "integration", 0, 4000, { endReason: "examination_stopped" });
    w.span(n, "integration", 10_000, 13_000, { reason: "readmitted", endReason: "integrated" });
    const r = w.report();
    expect(r.operations.map((o) => [o.occurrence, o.durationMs, o.reason])).toEqual([
      [1, 4000, "examination_stopped"],
      [2, 3000, "integrated"],
    ]);
    expect(r.unions.integration).toBe(7000);
    expect(r.unattributedMs).toBe(6000);
    expect(r.endings.examination_stopped).toBe(1);
    expect(r.endings.integrated).toBe(1);
    expect(r.nodes[0]?.unattributedMs).toBe(6000);
  });

  it("marks the first occurrence incomplete when a non-recovery start follows an open one", () => {
    const w = makeWorld(9000);
    const n = w.addNode();
    w.emit(n, "work", "start", 0);
    w.emit(n, "work", "start", 5000);
    w.emit(n, "work", "end", 8000);
    const r = w.report();
    expect(r.operations.map((o) => [o.occurrence, o.state])).toEqual([
      [1, "incomplete"],
      [2, "closed"],
    ]);
    expect(r.operations[0]?.observedUntil).toBe(at(5000));
    expect(r.ambiguousMs).toBe(5000);
    expect(r.unions.work).toBe(3000);
    expect(r.nodes[0]?.incompleteCount).toBe(1);
    expect(r.nodes[0]?.byPhase).toEqual({ work: 3000 });
  });

  it("reports an end without a start as end_only with no duration", () => {
    const w = makeWorld(9000);
    const n = w.addNode();
    w.emit(n, "work", "end", 4000);
    const r = w.report();
    expect(r.operations[0]?.state).toBe("end_only");
    expect(r.operations[0]?.endedAt).toBe(at(4000));
    expect(r.operations[0]?.startedAt).toBeUndefined();
    expect(r.operations[0]?.durationMs).toBeUndefined();
    expect(r.unions.work).toBe(0);
    expect(r.ambiguousMs).toBe(0);
  });
});

describe("operationsOf: integration endings", () => {
  it("counts endings and skipped examination, with their time in the integration union", () => {
    const w = makeWorld(10_000);
    const a = w.addNode();
    const b = w.addNode();
    const c = w.addNode();
    w.span(a, "integration", 0, 2000, { endReason: "verification_failed" });
    w.emit(b, "integration", "start", 2000);
    w.emit(b, "integration", "note", 2500, { reason: "examination: skipped (low risk)" });
    w.emit(b, "integration", "end", 3000, { reason: "deferred" });
    w.span(c, "integration", 5000, 6000, { endReason: "integrated" });
    const r = w.report();
    expect(r.endings).toEqual({
      integrated: 1,
      merged: 0,
      integration_conflict: 0,
      verification_failed: 1,
      deferred: 1,
      examination_stopped: 0,
      failed: 0,
      other: 0,
      examinationSkipped: 1,
    });
    expect(r.unions.integration).toBe(4000);
  });
});

describe("operationsOf: coverage and time basis", () => {
  it("labels a node without observations legacy and invents no phase time", () => {
    const w = makeWorld(10_000);
    const legacy = w.addNode();
    const observed = w.addNode();
    w.span(observed, "work", 0, 1000);
    const agents = [
      makeAgent(w.f, legacy.executionNodeId, { startedAt: at(1000), endedAt: at(4000) }),
      makeAgent(w.f, legacy.executionNodeId, { startedAt: at(3000), endedAt: at(6000) }),
    ];
    const r = w.report({ agents });
    const node = r.nodes.find((x) => x.nodeId === legacy.executionNodeId);
    expect(node?.coverage).toBe("legacy");
    expect(node?.operations).toEqual([]);
    expect(node?.byPhase).toEqual({});
    expect(node?.activeSpan).toBeUndefined();
    expect(node?.legacyWorkMs).toBe(5000);
    expect(r.legacyWorkMs).toBe(5000);
    expect(r.unions.work).toBe(1000);
    expect(r.nodes.find((x) => x.nodeId === observed.executionNodeId)?.coverage).toBe("observed");
    expect(
      r.nodes.find((x) => x.nodeId === observed.executionNodeId)?.legacyWorkMs,
    ).toBeUndefined();
  });

  it("computes unattributed time as elapsed minus the union of closed intervals", () => {
    const w = makeWorld(20_000);
    const n = w.addNode();
    w.span(n, "work", 0, 5000);
    w.span(n, "wait", 3000, 8000);
    w.span(n, "integration", 12_000, 15_000);
    const r = w.report();
    expect(r.elapsedMs).toBe(20_000);
    expect(r.unattributedMs).toBe(9000);
    const node = r.nodes[0];
    expect(node?.byPhase).toEqual({ work: 5000, wait: 5000, integration: 3000 });
    expect(node?.activeSpan).toEqual({ from: at(0), to: at(15_000) });
    expect(node?.unattributedMs).toBe(4000);
  });

  it("takes verification time from the verification records", () => {
    const w = makeWorld(10_000);
    const n = w.addNode();
    w.span(n, "work", 0, 1000);
    const v = (from: number, to: number) => ({
      startedAt: at(from),
      endedAt: at(to),
    });
    const verifications = [v(2000, 5000), v(4000, 6000)] as never;
    expect(w.report({ verifications }).unions.verification).toBe(4000);
  });

  it("uses occurredAt when present and says receivedAt when it is absent", () => {
    const w = makeWorld(10_000);
    const a = w.addNode();
    const b = w.addNode();
    w.span(a, "work", 1000, 3000);
    w.span(b, "work", 1000, 3000, { receivedOnly: true });
    const r = w.report();
    expect(r.operations.map((o) => [o.timeSource, o.startedAt, o.durationMs])).toEqual([
      ["occurredAt", at(1000), 2000],
      ["receivedAt", at(1000), 2000],
    ]);
  });
});

describe("operationsOf: retry", () => {
  it("links a later attempt to the previous attempt's end and carries its causes", () => {
    const w = makeWorld(10_000);
    const n = w.addNode();
    w.span(n, "work", 0, 4000, { attempt: 1 });
    w.span(n, "integration", 4000, 5000, { attempt: 1, endReason: "integration_conflict" });
    w.span(n, "work", 6000, 9000, { attempt: 2 });
    w.span(n, "integration", 9000, 10_000, { attempt: 2, endReason: "integrated" });
    const causes: AttemptCause[] = [{ kind: "integration_conflict", paths: ["a.ts"] }];
    const route = {
      executionNodeId: n.executionNodeId,
      attempt: 2,
      causes,
    } as unknown as RoutingDecision;
    const r = w.report({ routes: [route] });
    expect(ids(r)).toEqual([
      stepOf("integration", 9000, 10_000, "end"),
      stepOf("work", 6000, 9000, "work"),
      stepOf("integration", 4000, 5000, "retry"),
      stepOf("work", 0, 4000, "work"),
    ]);
    expect(r.chain.steps[2]?.causes).toEqual(causes);
    expect(r.chain.steps[1]?.causes).toBeUndefined();
    expect(r.chain.coveredMs).toBe(4000 + 1000 + 3000 + 1000);
    expect(r.endings.integration_conflict).toBe(1);
  });
});
