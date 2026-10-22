import {
  type Agent,
  type ArtifactId,
  type MeasurementCounters,
  type MeasurementObservation,
  type ModelPrice,
  parseId,
  type RoutingDecision,
} from "@nightshift/contracts";
import { describe, expect, it } from "vitest";
import { createCountingIdGenerator } from "../ids.js";
import { spendOfRun } from "../rules/policy.js";
import {
  baselineFor,
  closeSegment,
  coalesceGaps,
  countersFromRouteUsage,
  emptySummary,
  foldExit,
  foldObservation,
  foldObservationPriced,
  hasCounters,
  legacySummaryOf,
  markGap,
  markPublished,
  reconcileSegment,
  reconcileSegments,
  rollLedgerIndex,
  routeUsageFromCounters,
  startSegment,
  valuationOf,
  valueCounters,
} from "./index.js";

const ids = createCountingIdGenerator();
const agentId = ids.next("agent");
const launch = { agentId, launchId: "l1", segment: 0 };
const T = (n: number) => `2026-10-20T00:00:${String(n).padStart(2, "0")}.000Z`;

let seq = 0;
const base = (kind: MeasurementObservation["kind"]) => ({
  observationId: `o${++seq}`,
  schemaVersion: 1 as const,
  projectId: ids.next("proj"),
  programId: ids.next("prog"),
  runId: ids.next("run"),
  executionNodeId: ids.next("node"),
  launch,
  source: "harness" as const,
  provenance: { adapter: "test" },
  receivedAt: T(seq % 60),
  inclusion: "self" as const,
  kind,
});

const request = (
  counters: MeasurementCounters,
  extra: Record<string, unknown> = {},
): MeasurementObservation => ({ ...base("request"), counters, ...extra }) as MeasurementObservation;
const snapshot = (
  counters: MeasurementCounters,
  counterScope: "launch" | "session",
  extra: Record<string, unknown> = {},
): MeasurementObservation =>
  ({
    ...base("cumulative_snapshot"),
    counters,
    counterScope,
    ...extra,
  }) as MeasurementObservation;
const terminal = (
  counters: MeasurementCounters,
  extra: Record<string, unknown> = {},
): Extract<MeasurementObservation, { kind: "terminal_summary" }> =>
  ({
    ...base("terminal_summary"),
    counters,
    counterScope: "launch",
    exitKind: "completed",
    coverage: "complete",
    ...extra,
  }) as Extract<MeasurementObservation, { kind: "terminal_summary" }>;

const fresh = () => ({ resumedSession: false });
const out = (n: number): MeasurementCounters => ({ outputTokens: n });

describe("reconcileSegment", () => {
  it("reconciles repeated launch snapshots to the latest, never summing", () => {
    const r = reconcileSegment(
      [
        snapshot(out(50), "launch", { occurredAt: T(2) }),
        snapshot(out(80), "launch", { occurredAt: T(3) }),
        snapshot(out(60), "launch", { occurredAt: T(1) }),
      ],
      fresh(),
    );
    expect(r.counters.outputTokens).toBe(80);
    expect(r.coverage).toBe("partial");
  });

  it("measures a resumed session's segment from its baseline, not 250", () => {
    const first = reconcileSegment([snapshot(out(100), "session")], fresh());
    const second = reconcileSegment([snapshot(out(150), "session")], {
      resumedSession: true,
      baseline: first.sessionCumulative?.counters,
    });
    expect(second.counters.outputTokens).toBe(50);
    expect(reconcileSegments([first, second]).outputTokens).toBe(150);
  });

  it("excludes session sources and says so when a resume has no baseline", () => {
    const r = reconcileSegment([snapshot(out(150), "session")], {
      resumedSession: true,
    });
    expect(r.counters).toEqual({});
    expect(r.coverage).toBe("unknown");
    expect(r.gaps.map((g) => g.reason)).toContain("baseline_unknown");
    expect(r.sessionCumulative?.counters.outputTokens).toBe(150);
  });

  it("keeps requests when the terminal is empty", () => {
    const r = reconcileSegment([request(out(60)), request(out(40)), terminal({})], fresh());
    expect(r.counters.outputTokens).toBe(100);
    expect(r.gaps).toEqual([]);
    expect(r.observed).toEqual({ requests: 2, snapshots: 0, terminal: true });
  });

  it("keeps requests over a smaller terminal and records a discrepancy", () => {
    const r = reconcileSegment([request(out(100)), terminal(out(40))], fresh());
    expect(r.counters.outputTokens).toBe(100);
    expect(r.coverage).toBe("complete");
    const gap = r.gaps.find((g) => g.reason === "discrepancy");
    expect(gap?.detail).toContain("requests 100 vs terminal 40");
  });

  const childRequest = request(out(30), {
    childRef: { kind: "agent", id: "c1" },
  });
  it("excludes children under an includes_children aggregate and reports them", () => {
    const r = reconcileSegment(
      [childRequest, terminal(out(100), { inclusion: "includes_children" })],
      fresh(),
    );
    expect(r.counters.outputTokens).toBe(100);
    expect(r.childCounters).toEqual(out(30));
    expect(r.gaps).toEqual([]);
  });
  describe("whole-tree comparison under includes_children", () => {
    const inp = (n: number): MeasurementCounters => ({ inputTokens: n });
    const child = request(inp(50), { childRef: { kind: "agent", id: "c1" } });
    const session = (n: number, inclusion: string) =>
      terminal(inp(n), { inclusion, counterScope: "session" });
    it("records no gap when the aggregate equals parent plus children", () => {
      const r = reconcileSegment(
        [request(inp(100)), child, session(150, "includes_children")],
        fresh(),
      );
      expect(r.counters.inputTokens).toBe(150);
      expect(r.childCounters).toEqual(inp(50));
      expect(r.gaps).toEqual([]);
    });
    it("records one discrepancy naming the larger source when the aggregate is larger", () => {
      const r = reconcileSegment(
        [request(inp(100)), child, session(160, "includes_children")],
        fresh(),
      );
      expect(r.counters.inputTokens).toBe(160);
      const gaps = r.gaps.filter((g) => g.reason === "discrepancy");
      expect(gaps).toHaveLength(1);
      expect(gaps[0]?.detail).toContain("session_terminal 160 vs requests+children 150");
    });
    it("adds children under self", () => {
      const r = reconcileSegment([request(inp(100)), child, session(100, "self")], fresh());
      expect(r.counters.inputTokens).toBe(150);
      expect(r.gaps).toEqual([]);
    });
    it("excludes children with a gap under unknown", () => {
      const r = reconcileSegment([request(inp(100)), child, session(100, "unknown")], fresh());
      expect(r.counters.inputTokens).toBe(100);
      expect(r.childCounters).toBeUndefined();
      expect(r.gaps.map((g) => g.reason)).toContain("native_child_unscoped");
    });
  });
  it("adds disjoint children to a self-only terminal and reports them", () => {
    const r = reconcileSegment([terminal(out(100), { inclusion: "self" }), childRequest], fresh());
    expect(r.counters.outputTokens).toBe(130);
    expect(r.childCounters).toEqual(out(30));
  });
  it("adds children to the parent's reconciled maximum without a discrepancy", () => {
    const r = reconcileSegment(
      [request(out(100)), terminal(out(100), { inclusion: "self" }), childRequest],
      fresh(),
    );
    expect(r.counters.outputTokens).toBe(130);
    expect(r.childCounters).toEqual(out(30));
    expect(r.gaps).toEqual([]);
    const r2 = reconcileSegment(
      [request(out(70)), childRequest, terminal({ outputTokens: 5 })],
      fresh(),
    );
    expect(r2.counters.outputTokens).toBe(100);
  });
  it("adds children when there is no aggregate source", () => {
    const r = reconcileSegment([request(out(70)), childRequest], fresh());
    expect(r.counters.outputTokens).toBe(100);
    expect(r.childCounters).toEqual(out(30));
  });
  it("excludes children and records a gap under an unknown aggregate", () => {
    const r = reconcileSegment(
      [childRequest, terminal(out(100), { inclusion: "unknown" })],
      fresh(),
    );
    expect(r.counters.outputTokens).toBe(100);
    expect(r.childCounters).toBeUndefined();
    expect(r.gaps.map((g) => g.reason)).toContain("native_child_unscoped");
  });

  it("drops duplicate observation ids", () => {
    const one = request(out(10));
    expect(reconcileSegment([one, one, one], fresh()).counters.outputTokens).toBe(10);
  });

  it("merges the input convention and flags a mismatch", () => {
    const agree = reconcileSegment(
      [
        request({ inputTokens: 5, inputIncludesCache: true }),
        terminal({ inputTokens: 5, inputIncludesCache: true }),
      ],
      fresh(),
    );
    expect(agree.counters.inputIncludesCache).toBe(true);
    const differ = reconcileSegment(
      [
        request({
          inputTokens: 1000,
          outputTokens: 5,
          inputIncludesCache: true,
        }),
        terminal({
          inputTokens: 300,
          outputTokens: 5,
          inputIncludesCache: false,
        }),
      ],
      fresh(),
    );
    expect(differ.counters.inputIncludesCache).toBeUndefined();
    expect(differ.gaps.some((g) => g.detail?.includes("convention"))).toBe(true);
  });
});

describe("fold", () => {
  const summary0 = () => {
    const g = createCountingIdGenerator();
    return emptySummary({
      measurementSummaryId: g.next("meas"),
      scope: {
        schemaVersion: 1,
        projectId: g.next("proj"),
        programId: g.next("prog"),
        runId: g.next("run"),
      },
      executionNodeId: g.next("node"),
      agent: { agentId, role: "worker" },
      route: { harness: "claude", provider: "anthropic", model: "m1" },
      routingDecisionId: null,
      at: T(0),
    });
  };
  const started = (opts: { resumedSession?: boolean; baseline?: MeasurementCounters } = {}) =>
    startSegment(summary0(), launch, {
      sessionId: "s1",
      resumedSession: false,
      at: T(0),
      ...opts,
    });

  it("is idempotent per sequence", () => {
    const o = request(out(10), { model: "m1" });
    const once = foldObservation(started(), o, 1, T(1));
    expect(foldObservation(once, o, 1, T(2))).toBe(once);
    const twice = foldObservation(foldObservation(started(), o, 1, T(1)), o, 1, T(1));
    expect(twice).toEqual(once);
    expect(once.observedModels).toEqual(["m1"]);
    expect(once.ledger.observationCount).toBe(1);
  });

  it("agrees with reconcileSegment on a self-inclusion child-bearing set", () => {
    const obs = [
      request(out(60)),
      request(out(30), { childRef: { kind: "agent", id: "c" } }),
      terminal(out(100), { inclusion: "self" }),
    ];
    let s = started();
    obs.forEach((o, i) => {
      s = foldObservation(s, o, i + 1, T(i));
    });
    const r = reconcileSegment(obs, fresh());
    expect(r.counters.outputTokens).toBe(130);
    expect(s.segments[0]?.counters).toEqual(r.counters);
    expect(s.totals).toEqual(r.counters);
    expect(s.gaps).toEqual(r.gaps);
  });

  it("agrees with reconcileSegment", () => {
    const obs = [
      request(out(60), { sessionId: "s1" }),
      request(out(40)),
      snapshot(out(90), "launch"),
      snapshot({ outputTokens: 120, inputTokens: 7 }, "session"),
      request(out(5), { childRef: { kind: "agent", id: "c" } }),
      terminal(out(40), { inclusion: "unknown" }),
    ];
    let s = started();
    obs.forEach((o, i) => {
      s = foldObservation(s, o, i + 1, T(i));
    });
    const r = reconcileSegment(obs, fresh());
    const seg = s.segments[0];
    expect(seg?.counters).toEqual(r.counters);
    expect(seg?.coverage).toBe(r.coverage);
    expect(seg?.sources).toEqual(r.sources);
    expect(seg?.sessionCumulative).toEqual(r.sessionCumulative);
    expect(seg?.observed).toEqual(r.observed);
    expect(s.gaps).toEqual(r.gaps);
    expect(s.totals).toEqual(r.counters);
  });

  it("recomputes gaps instead of piling them up", () => {
    let s = started();
    s = foldObservation(s, request(out(100)), 1, T(1));
    s = foldObservation(s, terminal(out(40)), 2, T(2));
    s = foldObservation(s, request(out(1)), 3, T(3));
    expect(s.gaps.filter((g) => g.reason === "discrepancy")).toHaveLength(1);
    expect(s.gaps[0]?.detail).toContain("101");
  });

  it("records exits, closes segments and notes gaps", () => {
    let s = started();
    s = foldExit(s, launch, terminal(out(7), { exitKind: "cancelled" }), 1, T(1));
    expect(s.segments[0]?.exitKind).toBe("cancelled");
    expect(closeSegment(s, launch, T(2)).segments[0]?.open).toBe(false);
    const gap = { reason: "receipt_lost" as const };
    expect(markGap(markGap(s, gap, T(3)), gap, T(4)).gaps).toEqual([
      { reason: "receipt_lost", count: 2 },
    ]);
  });

  it("baselineFor returns the latest raw session cumulative of a session", () => {
    let s = started();
    s = foldObservation(s, snapshot(out(100), "session", { occurredAt: T(1) }), 1, T(1));
    s = closeSegment(s, launch, T(2));
    const second = { ...launch, launchId: "l2", segment: 1 };
    s = startSegment(s, second, {
      sessionId: "s1",
      resumedSession: true,
      baseline: out(100),
      at: T(3),
    });
    s = foldObservation(
      s,
      {
        ...snapshot(out(150), "session", { occurredAt: T(4) }),
        launch: second,
      },
      1,
      T(4),
    );
    expect(baselineFor(s, "s1")).toEqual(out(150));
    expect(baselineFor(s, "other")).toBeUndefined();
    expect(s.segments[1]?.counters).toEqual(out(50));
    expect(s.totals).toEqual(out(150));
  });

  it("reconciles reportedUsd by max, baseline and baselineFor like tokens", () => {
    // Max across sources: requests' dollars sum, a larger terminal wins.
    const r = reconcileSegment(
      [
        request({ outputTokens: 1 }, { reportedCostUsd: 0.25 }),
        request({ outputTokens: 1 }, { reportedCostUsd: 0.25 }),
        terminal({ outputTokens: 2 }, { reportedCostUsd: 0.75 }),
      ],
      fresh(),
    );
    expect(r.counters.reportedUsd).toBe(0.75);
    expect(r.gaps.some((g) => g.reason === "discrepancy")).toBe(true);

    // Session scope: second segment is measured above the baseline, floor 0.
    let s = started();
    s = foldExit(
      s,
      launch,
      terminal({ inputTokens: 100, reportedUsd: 1 }, { counterScope: "session" }),
      1,
      T(1),
    );
    s = closeSegment(s, launch, T(2));
    const baseline = baselineFor(s, "s1");
    expect(baseline).toEqual({ inputTokens: 100, reportedUsd: 1 });
    const second = { ...launch, launchId: "l2", segment: 1 };
    s = startSegment(s, second, {
      sessionId: "s1",
      resumedSession: true,
      baseline,
      at: T(3),
    });
    s = foldExit(
      s,
      second,
      terminal(
        { inputTokens: 150 },
        { counterScope: "session", launch: second, reportedCostUsd: 1.5 },
      ),
      1,
      T(4),
    );
    expect(s.segments[1]?.counters).toEqual({
      inputTokens: 50,
      reportedUsd: 0.5,
    });
    expect(s.totals).toEqual({ inputTokens: 150, reportedUsd: 1.5 });
    expect(baselineFor(s, "s1")?.reportedUsd).toBe(1.5);
    expect(s.gaps).toEqual([]);
  });

  it("does not let dollars alone make coverage partial or an estimate possible", () => {
    const r = reconcileSegment([request({ reportedUsd: 1 })], fresh());
    expect(r.counters.reportedUsd).toBe(1);
    expect(r.coverage).toBe("unknown");
    const price: ModelPrice = { inputPerMTok: 3, outputPerMTok: 15 };
    expect(valueCounters({ reportedUsd: 1 }, price).source).toBe("reported");
    expect(valueCounters({}, price).source).toBe("unknown");
    expect(hasCounters({ reportedUsd: 1 })).toBe(false);
  });

  it("maps dollars between route usage and counters", () => {
    expect(countersFromRouteUsage({ inputTokens: 1, actualCostUsd: 0.5 })).toEqual({
      inputTokens: 1,
      reportedUsd: 0.5,
    });
    expect(routeUsageFromCounters({ reportedUsd: 0.5 }, { reportedUsd: 9 }).actualCostUsd).toBe(
      0.5,
    );
    expect(routeUsageFromCounters({}, { reportedUsd: 9 }).actualCostUsd).toBe(9);
  });

  it("compacts the oldest closed segments past 64", () => {
    let s = summary0();
    for (let i = 0; i < 70; i++) {
      const l = { ...launch, launchId: `l${i}`, segment: i };
      s = startSegment(s, l, { resumedSession: false, at: T(1) });
      s = foldObservation(s, { ...request(out(1)), launch: l }, 1, T(1));
      s = closeSegment(s, l, T(1));
    }
    expect(s.segments.length).toBeLessThanOrEqual(64);
    expect(s.totals.outputTokens).toBe(70);
    expect(s.gaps.some((g) => g.reason === "other")).toBe(true);
  });

  it("reports ledger overflow at 512 ids and rolls them into an index", () => {
    let s = started();
    for (let i = 0; i < 513; i++) s = foldObservation(s, request(out(i + 1)), i + 1, T(1));
    let overflow = false;
    for (let i = 0; i < 513; i++) {
      const artifactId = parseId("art", `art_${String(i).padStart(26, "0")}`);
      const r = markPublished(
        s,
        { segment: launch, artifactId, toSequence: i + 1, observations: 1 },
        T(2),
      );
      s = r.summary;
      overflow = r.overflow;
      if (i < 512) expect(overflow).toBe(false);
    }
    expect(overflow).toBe(true);
    expect(s.ledger.publishedCount).toBe(513);
    expect(s.segments[0]?.publishedSequence).toBe(513);
    const again = markPublished(
      s,
      {
        segment: launch,
        artifactId: s.ledger.artifactIds[0] as ArtifactId,
        toSequence: 1,
        observations: 1,
      },
      T(3),
    );
    expect(again.summary).toBe(s);
    const index0 = parseId("art", `art_${"Z".repeat(26)}`);
    const emptied = rollLedgerIndex(s, index0, T(3));
    const replay = markPublished(
      emptied,
      {
        segment: launch,
        artifactId: parseId("art", `art_${"0".repeat(26)}`),
        toSequence: 513,
        observations: 1,
      },
      T(3),
    );
    expect(replay).toEqual({ summary: emptied, overflow: false });
    expect(replay.summary.ledger.artifactIds).toEqual([]);
    const index = parseId("art", `art_${"Z".repeat(26)}`);
    const rolled = rollLedgerIndex(s, index, T(4));
    expect(rolled.ledger.artifactIds).toEqual([]);
    expect(rolled.ledger.indexArtifactId).toBe(index);
  });

  it("markPublished is a no-op once the segment cursor covers the range, and records a new one", () => {
    let s = started();
    for (let i = 1; i <= 3; i++) s = foldObservation(s, request(out(i)), i, T(1));
    const first = markPublished(
      s,
      {
        segment: launch,
        artifactId: parseId("art", `art_${"1".repeat(26)}`),
        toSequence: 2,
        observations: 2,
      },
      T(2),
    );
    expect(first.summary.ledger.chunks).toBe(1);
    const covered = markPublished(
      {
        ...first.summary,
        ledger: { ...first.summary.ledger, artifactIds: [] },
      },
      {
        segment: launch,
        artifactId: parseId("art", `art_${"2".repeat(26)}`),
        toSequence: 2,
        observations: 2,
      },
      T(3),
    );
    expect(covered.summary.ledger.chunks).toBe(1);
    expect(covered.summary.ledger.artifactIds).toEqual([]);
    const fresh = markPublished(
      first.summary,
      {
        segment: launch,
        artifactId: parseId("art", `art_${"3".repeat(26)}`),
        toSequence: 3,
        observations: 1,
      },
      T(4),
    );
    expect(fresh.summary.ledger.chunks).toBe(2);
    expect(fresh.summary.segments[0]?.publishedSequence).toBe(3);
  });
});

describe("coalesceGaps", () => {
  it("merges repeats and never exceeds the limit", () => {
    expect(
      coalesceGaps([
        { reason: "receipt_lost", count: 1 },
        { reason: "receipt_lost", count: 2 },
      ]),
    ).toEqual([{ reason: "receipt_lost", count: 3 }]);
    const many = Array.from({ length: 200 }, (_, i) => ({
      reason: "other" as const,
      detail: `gap ${i}`,
      count: 1,
    }));
    const merged = coalesceGaps(many);
    expect(merged).toHaveLength(64);
    expect(merged.reduce((n, g) => n + g.count, 0)).toBe(200);
    expect(coalesceGaps(merged)).toHaveLength(64);
  });
});

describe("legacySummaryOf", () => {
  it("keeps the decision's reported dollars with coverage legacy", () => {
    const g = createCountingIdGenerator();
    const agent = {
      schemaVersion: 1,
      projectId: g.next("proj"),
      programId: g.next("prog"),
      runId: g.next("run"),
      agentId: g.next("agent"),
      executionNodeId: g.next("node"),
      role: "builder",
      harness: "claude",
      provider: "anthropic",
      model: "m1",
    } as unknown as Agent;
    const decision = {
      routingDecisionId: g.next("route"),
      chosen: { harness: "claude", provider: "anthropic", model: "m1" },
      usage: { inputTokens: 10, outputTokens: 5, actualCostUsd: 0.25 },
    } as unknown as RoutingDecision;
    const s = legacySummaryOf(agent, decision, T(1));
    expect(s.coverage).toBe("legacy");
    expect(s.valuation).toMatchObject({
      source: "reported",
      reportedUsd: 0.25,
    });
    expect(s.totals).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      reportedUsd: 0.25,
    });
    expect(s.gaps[0]?.reason).toBe("adapter_unsupported");
    expect(s.segments).toHaveLength(1);
    expect(legacySummaryOf(agent, undefined, T(1)).routingDecisionId).toBeNull();
  });
});

describe("normalize and value", () => {
  const price: ModelPrice = {
    inputPerMTok: 3,
    outputPerMTok: 15,
    cacheReadPerMTok: 0.3,
    cacheWritePerMTok: 3.75,
  };
  it("maps route usage 1:1 and never asserts a convention", () => {
    expect(countersFromRouteUsage({ inputTokens: 1, outputTokens: 2 })).toEqual({
      inputTokens: 1,
      outputTokens: 2,
    });
    expect(countersFromRouteUsage({ inputTokens: 1, inputIncludesCache: true })).toEqual({
      inputTokens: 1,
      inputIncludesCache: true,
    });
  });

  it("produces exclusive input", () => {
    const usage = routeUsageFromCounters(
      {
        inputTokens: 1000,
        cacheReadTokens: 600,
        cacheWriteTokens: 100,
        inputIncludesCache: true,
      },
      { reportedUsd: 1 },
    );
    expect(usage).toEqual({
      inputTokens: 300,
      cacheReadTokens: 600,
      cacheWriteTokens: 100,
      inputIncludesCache: false,
      actualCostUsd: 1,
    });
    expect(routeUsageFromCounters({ outputTokens: 3 })).toEqual({
      outputTokens: 3,
    });
  });

  it("values inclusive and exclusive input to the same dollars", () => {
    const inclusive = valueCounters(
      {
        inputTokens: 1_000_000,
        cacheReadTokens: 600_000,
        cacheWriteTokens: 100_000,
        outputTokens: 10,
        inputIncludesCache: true,
      },
      price,
    );
    const exclusive = valueCounters(
      {
        inputTokens: 300_000,
        cacheReadTokens: 600_000,
        cacheWriteTokens: 100_000,
        outputTokens: 10,
        inputIncludesCache: false,
      },
      price,
    );
    expect(inclusive.source).toBe("estimated");
    expect(inclusive.usd).toBeCloseTo(exclusive.usd ?? NaN);
  });

  it("prefers reported dollars and is unknown without counters or price", () => {
    expect(valueCounters({ reportedUsd: 2 }, price)).toMatchObject({
      source: "reported",
      usd: 2,
      reportedUsd: 2,
    });
    expect(valueCounters({}, price).source).toBe("unknown");
    expect(valueCounters({ inputTokens: 5 }, undefined).source).toBe("unknown");
  });
});

describe("per-request valuation", () => {
  const tiered: ModelPrice = {
    inputPerMTok: 3,
    outputPerMTok: 15,
    source: "anthropic-list",
    version: "2026-10-01",
    tiers: [{ aboveInputTokens: 200_000, inputPerMTok: 6, outputPerMTok: 22.5 }],
  };
  const prices = { m1: tiered };
  const begin = () => {
    const g = createCountingIdGenerator();
    return startSegment(
      emptySummary({
        measurementSummaryId: g.next("meas"),
        scope: {
          schemaVersion: 1,
          projectId: g.next("proj"),
          programId: g.next("prog"),
          runId: g.next("run"),
        },
        executionNodeId: g.next("node"),
        agent: { agentId, role: "worker" },
        route: { harness: "claude", provider: "anthropic", model: "m1" },
        routingDecisionId: null,
        at: T(0),
      }),
      launch,
      { sessionId: "s1", resumedSession: false, at: T(0) },
    );
  };
  const excl = (inputTokens: number, outputTokens: number): MeasurementCounters => ({
    inputTokens,
    outputTokens,
    inputIncludesCache: false,
  });
  const twoRequests = () => {
    let s = begin();
    s = foldObservationPriced(s, request(excl(100_000, 1000), { model: "m1" }), 1, T(1), prices);
    return foldObservationPriced(s, request(excl(300_000, 2000), { model: "m1" }), 2, T(2), prices);
  };

  it("values each request at its own tier, unlike the single block of the totals", () => {
    const s = twoRequests();
    const v = valuationOf(s, prices);
    // 100k in at 3 + 1k out at 15 = 0.315; 300k in at 6 + 2k out at 22.5 = 1.845.
    expect(v.source).toBe("estimated");
    expect(v.estimatedUsd).toBeCloseTo(2.16, 9);
    expect(v.usd).toBeCloseTo(2.16, 9);
    expect(v.priceSource).toBe("anthropic-list");
    expect(v.priceVersion).toBe("2026-10-01");
    expect(v.components?.map((c) => [c.tier, c.category, c.tokens])).toEqual([
      [0, "input", 100_000],
      [0, "output", 1000],
      [1, "input", 300_000],
      [1, "output", 2000],
    ]);
    expect(v.completeness).toEqual({
      valuedRequests: 2,
      unvaluedRequests: 0,
      remainderTokens: 0,
      remainderValued: true,
      reasons: [],
    });
    // The block valuation of 400k in / 3k out at the base tier: 1.2 + 0.045.
    const block = valueCounters(s.totals, tiered);
    expect(block.usd).toBeCloseTo(1.245, 9);
    expect(block.usd).not.toBeCloseTo(v.usd ?? NaN, 3);
  });

  it("selects the tier on input including cache for inclusive and exclusive counters", () => {
    const tierOf = (counters: MeasurementCounters) =>
      valuationOf(
        foldObservationPriced(begin(), request(counters, { model: "m1" }), 1, T(1), prices),
        prices,
      ).components?.map((c) => c.tier);
    // 250k including 100k cache is above 200k; 190k including 100k cache is not.
    expect(
      tierOf({
        inputTokens: 250_000,
        cacheReadTokens: 100_000,
        outputTokens: 0,
        inputIncludesCache: true,
      }),
    ).toEqual([1, 1]);
    expect(
      tierOf({
        inputTokens: 190_000,
        cacheReadTokens: 100_000,
        outputTokens: 0,
        inputIncludesCache: true,
      }),
    ).toEqual([0, 0]);
    // Exclusive: 100k input + 150k cache is 250k.
    expect(
      tierOf({
        inputTokens: 100_000,
        cacheReadTokens: 150_000,
        outputTokens: 0,
        inputIncludesCache: false,
      }),
    ).toEqual([1, 1]);
  });

  it("counts an unpriced or model-less request as unvalued, never as zero", () => {
    let s = begin();
    s = foldObservationPriced(s, request(excl(10, 10), { model: "unpriced" }), 1, T(1), prices);
    const none = valuationOf(s, prices);
    expect(none.source).toBe("unknown");
    expect(none.usd).toBeUndefined();
    expect(none.estimatedUsd).toBeUndefined();
    expect(none.completeness).toMatchObject({
      valuedRequests: 0,
      unvaluedRequests: 1,
    });
    expect(none.completeness?.reasons).toEqual(["no price for unpriced"]);

    s = foldObservationPriced(s, request(excl(100_000, 1000), { model: "m1" }), 2, T(2), prices);
    const partial = valuationOf(s, prices);
    expect(partial.source).toBe("estimated");
    expect(partial.estimatedUsd).toBeCloseTo(0.315, 9);
    expect(partial.completeness).toMatchObject({
      valuedRequests: 1,
      unvaluedRequests: 1,
    });
  });

  it("values a model-less request when exactly one model was observed, else leaves it unvalued", () => {
    let s = begin();
    s = foldObservationPriced(s, request(excl(10, 10)), 1, T(1), prices);
    expect(valuationOf(s, prices).completeness).toMatchObject({
      unvaluedRequests: 1,
      reasons: ["request without a model"],
    });
  });

  it("values totals beyond the request sums as a base-tier remainder", () => {
    let s = twoRequests();
    s = foldExit(s, launch, terminal(excl(400_000, 5000)), 3, T(3));
    const v = valuationOf(s, prices);
    expect(v.completeness).toMatchObject({
      remainderTokens: 2000,
      remainderValued: true,
    });
    expect(v.components?.find((c) => c.tier === 0 && c.category === "output")).toMatchObject({
      tokens: 3000,
    });
    expect(v.estimatedUsd).toBeCloseTo(2.16 + 0.03, 9);
  });

  it("leaves a remainder unvalued when the route model has no price", () => {
    let s = begin();
    s = foldExit(s, launch, terminal(excl(10, 20)), 1, T(1));
    const v = valuationOf(s, {});
    expect(v.source).toBe("unknown");
    expect(v.completeness).toMatchObject({
      remainderTokens: 30,
      remainderValued: false,
    });
  });

  it("never adds reported dollars to the estimate", () => {
    let s = twoRequests();
    s = foldExit(s, launch, terminal({ ...excl(400_000, 3000), reportedUsd: 9 }), 3, T(3));
    const v = valuationOf(s, prices);
    expect(v.source).toBe("reported");
    expect(v.usd).toBe(9);
    expect(v.reportedUsd).toBe(9);
    expect(v.estimatedUsd).toBeCloseTo(2.16, 9);
  });

  it("never values a request missing a required counter, and never certifies the budget complete", () => {
    const cheap: ModelPrice = {
      inputPerMTok: 1,
      outputPerMTok: 10,
      source: "A",
      version: "v1",
    };
    const cheapPrices = { m1: cheap };
    const inputOnly: MeasurementCounters = {
      inputTokens: 1000,
      inputIncludesCache: true,
    };
    let s = foldObservationPriced(
      begin(),
      request(inputOnly, { model: "m1" }),
      1,
      T(1),
      cheapPrices,
    );
    s = foldExit(s, launch, terminal(inputOnly), 2, T(2));
    const v = valuationOf(s, cheapPrices);
    expect(v.estimatedUsd).toBeUndefined();
    expect(v.completeness).toMatchObject({
      valuedRequests: 0,
      unvaluedRequests: 1,
      remainderValued: false,
      missing: ["output"],
    });
    expect(v.completeness?.reasons).toContain("request without output counter");
    expect(v.requests?.counters.inputTokens).toBe(1000);
    const spend = spendOfRun({
      routes: [],
      measurements: [{ ...s, valuation: v }],
    });
    expect(spend.evaluation.complete).toBe(false);
    expect(spend.evaluation.tokensIncomplete).toBe(1);
  });

  it("leaves an output-only or dollars-only request unvalued with its reason", () => {
    const outputOnly = foldObservationPriced(
      begin(),
      request({ outputTokens: 50 }, { model: "m1" }),
      1,
      T(1),
      prices,
    );
    const a = valuationOf(outputOnly, prices);
    expect(a.estimatedUsd).toBeUndefined();
    expect(a.completeness?.reasons).toContain("request without input counter");
    expect(a.requests?.counters.outputTokens).toBe(50);

    const dollarsOnly = foldObservationPriced(
      begin(),
      request({ reportedUsd: 0.5 }, { model: "m1" }),
      1,
      T(1),
      prices,
    );
    const b = valuationOf(dollarsOnly, prices);
    expect(b.completeness).toMatchObject({
      valuedRequests: 0,
      unvaluedRequests: 1,
    });
    expect(b.completeness?.reasons).toContain("request without token counters");
    expect(b.estimatedUsd).toBeUndefined();
  });

  describe("absent cache counters", () => {
    const cachePriced: ModelPrice = {
      inputPerMTok: 1,
      outputPerMTok: 10,
      cacheReadPerMTok: 0.1,
      cacheWritePerMTok: 2,
    };
    const cached = { m1: cachePriced };
    const valued = (counters: MeasurementCounters, table: Record<string, ModelPrice>) =>
      valuationOf(
        foldObservationPriced(begin(), request(counters, { model: "m1" }), 1, T(1), table),
        table,
      );

    it("makes a request without priced cache counters an incomplete lower bound", () => {
      const v = valued(excl(1000, 100), cached);
      expect(v.estimatedUsd).toBeCloseTo(0.002, 9);
      expect(v.completeness).toMatchObject({
        valuedRequests: 1,
        unvaluedRequests: 0,
        // The totals lack the counters too, so their remainder is unknown.
        remainderValued: false,
        missing: ["cacheRead", "cacheWrite"],
      });
      expect(v.completeness?.reasons).toContain("cache counters absent: estimate is a lower bound");
      expect(v.requests?.missing).toEqual(["cacheRead", "cacheWrite"]);
      const s = foldObservationPriced(
        begin(),
        request(excl(1000, 100), { model: "m1" }),
        1,
        T(1),
        cached,
      );
      const spend = spendOfRun({ routes: [], measurements: [{ ...s, valuation: v }] });
      expect(spend.evaluation.complete).toBe(false);
      expect(spend.evaluation.estimateIncomplete).toBe(1);
    });

    it("leaves the same request complete when the price has no cache rates", () => {
      const v = valued(excl(1000, 100), prices);
      expect(v.completeness?.missing).toBeUndefined();
      expect(v.completeness?.reasons).toEqual([]);
    });

    it("is incomplete for inclusive input with absent priced cache counters", () => {
      const v = valued({ inputTokens: 1000, outputTokens: 100, inputIncludesCache: true }, cached);
      expect(v.completeness?.missing).toEqual(["cacheRead", "cacheWrite"]);
    });

    it("names only the absent category", () => {
      const v = valued({ ...excl(1000, 100), cacheReadTokens: 5 }, cached);
      expect(v.completeness?.missing).toEqual(["cacheWrite"]);
    });

    it("treats explicit zero cache counters as reported", () => {
      const v = valued({ ...excl(1000, 100), cacheReadTokens: 0, cacheWriteTokens: 0 }, cached);
      expect(v.completeness?.missing).toBeUndefined();
      expect(v.completeness?.reasons).toEqual([]);
    });

    it("selects the tier from present counters only", () => {
      const tieredCache: ModelPrice = {
        ...tiered,
        cacheReadPerMTok: 0.3,
        tiers: [{ aboveInputTokens: 200_000, inputPerMTok: 6, outputPerMTok: 22.5 }],
      };
      const v = valued(excl(150_000, 10), { m1: tieredCache });
      expect(v.components?.every((c) => c.tier === 0)).toBe(true);
      expect(v.completeness?.missing).toEqual(["cacheRead"]);
    });
  });

  it("keeps the price source and version of each model apart", () => {
    const mixed = {
      a: { inputPerMTok: 1, outputPerMTok: 2, source: "A", version: "v1" },
      b: { inputPerMTok: 3, outputPerMTok: 4, source: "B", version: "v2" },
    };
    let s = begin();
    s = foldObservationPriced(s, request(excl(10, 10), { model: "a" }), 1, T(1), mixed);
    s = foldObservationPriced(s, request(excl(10, 10), { model: "b" }), 2, T(2), mixed);
    const v = valuationOf(s, mixed);
    expect(v.priceBases).toEqual([
      { model: "a", source: "A", version: "v1" },
      { model: "b", source: "B", version: "v2" },
    ]);
    // The legacy pair is set only when every basis agrees.
    expect(v.priceSource).toBeUndefined();
    expect(v.priceVersion).toBeUndefined();
    expect(valuationOf(twoRequests(), prices).priceSource).toBe("anthropic-list");
  });

  it("is idempotent per sequence", () => {
    const s = twoRequests();
    const again = foldObservationPriced(s, request(excl(1, 1), { model: "m1" }), 2, T(3), prices);
    expect(again).toBe(s);
  });
});
