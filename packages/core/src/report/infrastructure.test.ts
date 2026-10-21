import type { Dispatch, IsoTimestamp } from "@nightshift/contracts";
import { describe, expect, it } from "vitest";
import { meterUsd } from "../rules/compute.js";
import {
  createFixtures,
  makeAgent,
  makeComputeUtilization,
  makeDispatch,
  makeNode,
  makeRun,
} from "../testing/factories.js";
import { infrastructureOf, infrastructureUnavailable, occupancyOf } from "./infrastructure.js";
import type { OperationInterval, OperationsReport } from "./operations.js";

const BASE = Date.parse("2026-01-01T00:00:00.000Z");
/** A timestamp `s` seconds after the base. */
const at = (s: number): IsoTimestamp => new Date(BASE + s * 1000).toISOString() as IsoTimestamp;

const PRICE = {
  usdPerHour: 3.6,
  volumeUsdPerHour: 0.36,
  source: "aws-price-list",
  asOf: "2026-01-01",
  region: "us-west-2",
};

const world = (overrides: Partial<Dispatch> = {}) => {
  const f = createFixtures();
  const run = makeRun(f);
  const dispatch = makeDispatch(f, { requestedAt: at(0), usdPerHour: 3.6, ...overrides });
  return { f, run, dispatch };
};

describe("infrastructureOf", () => {
  it("returns undefined without a dispatch", () => {
    const { f, run } = world();
    expect(infrastructureOf({ run, agents: [], asOf: at(0) })).toBeUndefined();
    expect(makeRun(f)).toBeDefined();
  });

  it("reports one metered attempt, with a volume deleted later", () => {
    const { run, dispatch } = world({
      priceBasis: PRICE,
      attempts: [
        {
          generation: 1,
          reason: "dispatch",
          startedAt: at(0),
          readyAt: at(120),
          runningAt: at(150),
          endedAt: at(1000),
          endReason: "stopped",
          terminatedAt: at(1000),
          meteredSeconds: 1000,
        },
      ],
      cleanup: { volumeDeleted: true, volumeDeletedAt: at(1600), failures: [] },
      spend: { estimatedUsd: 2, meteredUsd: 1.1, meteredSeconds: 1000 },
      stages: [
        { generation: 1, stage: "up", startedAt: at(120) },
        { generation: 1, stage: "setup", startedAt: at(150) },
        { generation: 1, stage: "orchestrating", startedAt: at(300) },
      ],
    });
    const r = infrastructureOf({ run, dispatch, agents: [], asOf: at(5000) });
    expect(r?.attempts[0]).toMatchObject({
      lifetimeMs: 1_000_000,
      provisioningMs: 120_000,
      incomplete: false,
      endReason: "stopped",
    });
    expect(r?.lifetime).toMatchObject({
      requestedAt: at(0),
      firstReadyAt: at(120),
      lastEndedAt: at(1000),
      lastRunnerEndedAt: at(1000),
      instanceLifetimeMs: 1_000_000,
      gapsBetweenAttemptsMs: 0,
      openAttempts: 0,
      coverage: "complete",
    });
    expect(r?.stages).toEqual([
      {
        generation: 1,
        stages: [
          { stage: "up", startedAt: at(120), durationMs: 30_000 },
          { stage: "setup", startedAt: at(150), durationMs: 150_000 },
          { stage: "orchestrating", startedAt: at(300) },
        ],
      },
    ]);
    const { instance, volume, total } = r?.components ?? {};
    expect(instance).toMatchObject({
      seconds: 1000,
      runnerMeteredSeconds: 1000,
      basis: "observed machine lifetimes (terminatedAt - startedAt)",
      usd: 1,
    });
    expect(volume).toMatchObject({ seconds: 1600, open: false, usd: 0.16, coverage: "complete" });
    expect(total?.usd).toBe(1.16);
    expect(total?.basis).toContain("1000 s from observed machine lifetimes");
    expect(total?.basis).toContain("1600 s from request to deletion");
    expect(r?.recorded).toEqual(dispatch.spend);
    expect(r?.reconciliation.computedUsd).toBe(1.1);
    expect(r?.reconciliation.discrepancy).toBeUndefined();
    expect(r?.occupancy.provisioningMs).toBe(120_000);
  });

  it("reports a replacement with an idle gap and an open second attempt", () => {
    const { run, dispatch } = world({
      attempts: [
        {
          generation: 1,
          reason: "dispatch",
          startedAt: at(0),
          endedAt: at(500),
          endReason: "lease_lost",
          terminatedAt: at(505),
        },
        { generation: 2, reason: "lease_lost", startedAt: at(800) },
      ],
    });
    const r = infrastructureOf({ run, dispatch, agents: [], asOf: at(2000) });
    expect(r?.lifetime).toMatchObject({
      gapsBetweenAttemptsMs: 300_000,
      openAttempts: 1,
      coverage: "partial",
      instanceLifetimeMs: 505_000,
      lastEndedAt: at(505),
      lastRunnerEndedAt: at(500),
    });
    expect(r?.attempts.map((a) => a.incomplete)).toEqual([false, true]);
    expect(r?.attempts[1]?.lifetimeMs).toBeUndefined();
    expect(r?.components.instance).toMatchObject({
      seconds: 505,
      basis: "observed machine lifetimes (terminatedAt - startedAt)",
      coverage: "partial",
    });
  });

  it("prices a volume that outlives the machine without flagging a discrepancy", () => {
    const { run, dispatch } = world({
      usdPerHour: 0.44352,
      attempts: [
        {
          generation: 1,
          reason: "dispatch",
          startedAt: at(0),
          endedAt: at(1000),
          endReason: "stopped",
          terminatedAt: at(1000),
          meteredSeconds: 1000,
        },
      ],
      cleanup: { volumeDeleted: true, volumeDeletedAt: at(10_000), failures: [] },
      spend: { estimatedUsd: 1, meteredUsd: meterUsd("good", 1000), meteredSeconds: 1000 },
    });
    const r = infrastructureOf({ run, dispatch, agents: [], asOf: at(20_000) });
    expect(r?.components.volume.seconds).toBe(10_000);
    expect(r?.components.instance.seconds).toBe(1000);
    expect(r?.components.volume.provenance).toBe(
      "COMPUTE_TIERS/GP3 table constant, not a recorded basis",
    );
    expect(r?.reconciliation.discrepancy).toBeUndefined();
  });

  it("flags a metered figure that differs, keeping both", () => {
    const { run, dispatch } = world({
      priceBasis: PRICE,
      attempts: [
        {
          generation: 1,
          reason: "dispatch",
          startedAt: at(0),
          endedAt: at(1000),
          endReason: "stopped",
          terminatedAt: at(1000),
          meteredSeconds: 1000,
        },
      ],
      spend: { estimatedUsd: 1, meteredUsd: 5, meteredSeconds: 1000 },
    });
    const r = infrastructureOf({ run, dispatch, agents: [], asOf: at(2000) });
    expect(r?.reconciliation.discrepancy).toEqual({ computedUsd: 1.1, meteredUsd: 5 });
    expect(r?.reconciliation.meteredUsd).toBe(5);
  });

  it("differs in provenance with and without a price basis", () => {
    const attempts: Dispatch["attempts"] = [
      {
        generation: 1,
        reason: "dispatch",
        startedAt: at(0),
        endedAt: at(100),
        endReason: "stopped",
        terminatedAt: at(100),
      },
    ];
    const withBasis = world({ priceBasis: PRICE, attempts });
    const without = world({ attempts });
    const a = infrastructureOf({
      run: withBasis.run,
      dispatch: withBasis.dispatch,
      agents: [],
      asOf: at(200),
    });
    const b = infrastructureOf({
      run: without.run,
      dispatch: without.dispatch,
      agents: [],
      asOf: at(200),
    });
    expect(a?.components.instance.provenance).toBe(
      "priceBasis aws-price-list, as of 2026-01-01, region us-west-2",
    );
    expect(b?.components.instance.provenance).toBe(
      "dispatch.usdPerHour snapshot at creation; no recorded price source",
    );
    expect(a?.components.volume.usdPerHour).toBe(0.36);
    expect(b?.components.volume.provenance).toContain("not a recorded basis");
  });

  it("has unknown coverage and no apportionment when no attempt ended", () => {
    const { f, run, dispatch } = world({
      attempts: [{ generation: 1, reason: "dispatch", startedAt: at(0) }],
    });
    const node = makeNode(f, f.rootNodeId);
    const agent = makeAgent(f, node.executionNodeId, { startedAt: at(10), endedAt: at(50) });
    const r = infrastructureOf({ run, dispatch, agents: [agent], asOf: at(3600) });
    expect(r?.lifetime.coverage).toBe("unknown");
    expect(r?.lifetime.instanceLifetimeMs).toBeUndefined();
    expect(r?.apportionment.perNode).toBeUndefined();
    expect(r?.apportionment.note).toContain("cannot be apportioned");
    expect(r?.components.volume).toMatchObject({ open: true, seconds: 3600, coverage: "open" });
  });

  it("splits concurrent occupancy so shares sum to the instance cost", () => {
    const { f, run, dispatch } = world({
      priceBasis: PRICE,
      attempts: [
        {
          generation: 1,
          reason: "dispatch",
          startedAt: at(0),
          endedAt: at(1000),
          endReason: "stopped",
          terminatedAt: at(1000),
        },
      ],
    });
    const a = makeNode(f, f.rootNodeId);
    const b = makeNode(f, f.rootNodeId);
    const agents = [
      makeAgent(f, a.executionNodeId, { startedAt: at(100), endedAt: at(600) }),
      makeAgent(f, b.executionNodeId, { startedAt: at(400), endedAt: at(800) }),
    ];
    const utilization = makeComputeUtilization(f, { setupSeconds: 42, oomKills: 1 });
    const r = infrastructureOf({ run, dispatch, utilization, agents, asOf: at(2000) });
    expect(r?.occupancy).toMatchObject({
      setupSeconds: 42,
      busyMs: 700_000,
      idleMs: 300_000,
      peakConcurrentOccupants: 2,
      utilization: {
        peakCpuPct: 40,
        peakMemoryPct: 30,
        cpuAbove90Pct: 0,
        peakDiskPct: 20,
        oomKills: 1,
      },
    });
    expect(r?.components.instance.usd).toBe(1);
    expect(r?.apportionment.perNode).toEqual([
      { nodeId: a.executionNodeId, occupiedMs: 500_000, shareUsd: 0.4 },
      { nodeId: b.executionNodeId, occupiedMs: 400_000, shareUsd: 0.3 },
    ]);
    // 0.3 idle instance time + 0.2 volume (2000 s at 0.36 USD/h)
    expect(r?.apportionment.unapportionedUsd).toBe(0.5);
  });
});

const iv = (
  nodeId: string,
  phase: string,
  from: number,
  to: number | undefined,
  state: OperationInterval["state"] = "closed",
  extra: Partial<OperationInterval> = {},
): OperationInterval => ({
  operationId: `${phase}:${nodeId}`,
  occurrence: 1,
  nodeId,
  phase,
  startedAt: at(from),
  ...(to === undefined ? {} : { endedAt: at(to) }),
  state,
  notes: [],
  refs: [],
  blockerSpans: [],
  timeSource: "occurredAt",
  ...extra,
});
const opsOf = (operations: OperationInterval[]): OperationsReport =>
  ({ operations }) as unknown as OperationsReport;

describe("per-attempt apportionment", () => {
  it("never apportions an open replacement's cost to the previous occupant", () => {
    const { f, run, dispatch } = world({
      priceBasis: PRICE,
      attempts: [
        {
          generation: 1,
          reason: "dispatch",
          startedAt: at(0),
          endedAt: at(100),
          endReason: "stopped",
          terminatedAt: at(100),
          meteredSeconds: 100,
        },
        { generation: 2, reason: "lease_lost", startedAt: at(200), meteredSeconds: 900 },
      ],
      cleanup: { volumeDeleted: true, volumeDeletedAt: at(1000), failures: [] },
    });
    const oldNode = makeNode(f, f.rootNodeId);
    const newNode = makeNode(f, f.rootNodeId);
    const occupancy = {
      coverage: "observed" as const,
      intervals: [
        { nodeId: oldNode.executionNodeId, from: at(0), to: at(100) },
        { nodeId: newNode.executionNodeId, from: at(200), to: at(1000) },
      ],
    };
    const r = infrastructureOf({ run, dispatch, agents: [], occupancy, asOf: at(1000) });
    expect(r?.components.instance.usd).toBe(1);
    expect(r?.apportionment.perNode).toEqual([
      { nodeId: oldNode.executionNodeId, occupiedMs: 100_000, shareUsd: 0.1 },
    ]);
    expect(r?.apportionment.unapportioned).toEqual([{ generation: 2, usd: 0.9, why: "open" }]);
    // 0.9 open attempt + 0.1 volume (1000 s at 0.36 USD/h)
    expect(r?.apportionment.unapportionedUsd).toBe(1);
  });

  it("sums per-attempt shares with unapportioned to the total", () => {
    const { f, run, dispatch } = world({
      priceBasis: PRICE,
      attempts: [
        {
          generation: 1,
          reason: "dispatch",
          startedAt: at(0),
          endedAt: at(100),
          endReason: "stopped",
          terminatedAt: at(100),
        },
        {
          generation: 2,
          reason: "lease_lost",
          startedAt: at(100),
          endedAt: at(400),
          endReason: "stopped",
          terminatedAt: at(400),
        },
        {
          generation: 3,
          reason: "lease_lost",
          startedAt: at(400),
          endedAt: at(500),
          endReason: "lease_lost",
          meteredSeconds: 100,
        },
      ],
      cleanup: { volumeDeleted: true, volumeDeletedAt: at(500), failures: [] },
    });
    const a = makeNode(f, f.rootNodeId);
    const b = makeNode(f, f.rootNodeId);
    const occupancy = {
      coverage: "observed" as const,
      intervals: [
        { nodeId: a.executionNodeId, from: at(0), to: at(100) },
        { nodeId: a.executionNodeId, from: at(100), to: at(200) },
        { nodeId: b.executionNodeId, from: at(150), to: at(250) },
        { nodeId: b.executionNodeId, from: at(400), to: at(500) },
      ],
    };
    const r = infrastructureOf({ run, dispatch, agents: [], occupancy, asOf: at(600) });
    const nodes = r?.apportionment.perNode ?? [];
    // attempt 1: $0.10, all a. attempt 2 ($0.30 over 100-400 s): a alone 100-150, shared
    // 150-200 (25 s each), b alone 200-250. b's 400-500 sits in an attempt with no observed machine end: not counted.
    expect(nodes.find((n) => n.nodeId === a.executionNodeId)?.shareUsd).toBe(0.175);
    expect(nodes.find((n) => n.nodeId === b.executionNodeId)?.shareUsd).toBe(0.075);
    expect(r?.apportionment.unapportioned).toEqual([
      { generation: 3, usd: 0.1, why: "machine end unobserved" },
    ]);
    const shares = nodes.reduce((sum, n) => sum + n.shareUsd, 0);
    const total = (r?.components.total.usd ?? 0) + 0;
    expect(Math.abs(shares + (r?.apportionment.unapportionedUsd ?? 0) - total)).toBeLessThan(1e-5);
  });
});

describe("observed machine endings", () => {
  it("treats a runner ending alone as incomplete, with no lifetime and partial coverage", () => {
    const { run, dispatch } = world({
      attempts: [
        {
          generation: 1,
          reason: "dispatch",
          startedAt: at(0),
          endedAt: at(100),
          endReason: "stopped",
          terminatedAt: at(100),
        },
        {
          generation: 2,
          reason: "lease_lost",
          startedAt: at(100),
          endedAt: at(300),
          endReason: "lease_lost",
          terminationFailed: true,
        },
      ],
    });
    const r = infrastructureOf({ run, dispatch, agents: [], asOf: at(400) });
    expect(r?.attempts[0]).toMatchObject({ observedEnd: true, incomplete: false });
    expect(r?.attempts[1]).toMatchObject({
      observedEnd: false,
      incomplete: true,
      endedAt: at(300),
      endReason: "lease_lost",
      runnerLifetimeMs: 200_000,
      terminationFailed: true,
    });
    expect(r?.attempts[1]?.lifetimeMs).toBeUndefined();
    expect(r?.lifetime).toMatchObject({
      coverage: "partial",
      observedEndings: 1,
      runnerOnlyEndings: 1,
      instanceLifetimeMs: 100_000,
    });
    expect(r?.apportionment.unapportioned).toEqual([
      { generation: 2, usd: 0, why: "machine end unobserved" },
    ]);
  });

  it("closes an attempt on terminatedAt", () => {
    const { run, dispatch } = world({
      attempts: [
        {
          generation: 1,
          reason: "dispatch",
          startedAt: at(0),
          endedAt: at(100),
          endReason: "failed",
          terminatedAt: at(101),
        },
      ],
    });
    const r = infrastructureOf({ run, dispatch, agents: [], asOf: at(400) });
    expect(r?.attempts[0]).toMatchObject({
      observedEnd: true,
      incomplete: false,
      lifetimeMs: 101_000,
      afterRunnerMs: 1000,
    });
    expect(r?.lifetime.coverage).toBe("complete");
  });

  const stoppedAt100 = {
    generation: 1,
    reason: "dispatch" as const,
    startedAt: at(0),
    endedAt: at(100),
    endReason: "stopped" as const,
    meteredSeconds: 100,
  };

  it("does not close a stopped runner whose termination failed", () => {
    const { run, dispatch } = world({
      priceBasis: PRICE,
      attempts: [{ ...stoppedAt100, terminationFailed: true }],
    });
    const r = infrastructureOf({ run, dispatch, agents: [], asOf: at(2000) });
    expect(r?.attempts[0]).toMatchObject({
      observedEnd: false,
      incomplete: true,
      runnerLifetimeMs: 100_000,
      terminationFailed: true,
    });
    expect(r?.attempts[0]?.lifetimeMs).toBeUndefined();
    expect(r?.attempts[0]?.afterRunnerMs).toBeUndefined();
    expect(r?.lifetime.coverage).toBe("unknown");
    expect(r?.lifetime.instanceLifetimeMs).toBeUndefined();
    expect(r?.lifetime.lastEndedAt).toBeUndefined();
    expect(r?.lifetime.lastRunnerEndedAt).toBe(at(100));
    expect(r?.components.instance).toMatchObject({
      seconds: 100,
      basis: "runner-metered seconds; machine end unobserved (lower bound)",
    });
    expect(r?.apportionment.unapportioned).toEqual([
      { generation: 1, usd: 0.1, why: "machine end unobserved" },
    ]);
    expect(r?.apportionment.perNode).toBeUndefined();
  });

  it("closes the same attempt at terminatedAt and apportions over the machine window", () => {
    const { f, run, dispatch } = world({
      priceBasis: PRICE,
      attempts: [{ ...stoppedAt100, terminationRequestedAt: at(110), terminatedAt: at(1000) }],
    });
    const node = makeNode(f, f.rootNodeId);
    const occupancy = {
      coverage: "observed" as const,
      intervals: [{ nodeId: node.executionNodeId, from: at(0), to: at(100) }],
    };
    const r = infrastructureOf({ run, dispatch, agents: [], occupancy, asOf: at(2000) });
    expect(r?.attempts[0]).toMatchObject({
      observedEnd: true,
      incomplete: false,
      lifetimeMs: 1_000_000,
      afterRunnerMs: 900_000,
      terminationRequestedAt: at(110),
    });
    expect(r?.lifetime).toMatchObject({
      coverage: "complete",
      lastEndedAt: at(1000),
      lastRunnerEndedAt: at(100),
    });
    expect(r?.components.instance).toMatchObject({
      seconds: 1000,
      runnerMeteredSeconds: 100,
      usd: 1,
    });
    expect(r?.apportionment.perNode).toEqual([
      { nodeId: node.executionNodeId, occupiedMs: 100_000, shareUsd: 0.1 },
    ]);
    expect(r?.apportionment.unapportioned).toEqual([]);
    // 0.9 unoccupied instance time + 0.2 volume (2000 s to asOf at 0.36 USD/h)
    expect(r?.apportionment.unapportionedUsd).toBe(1.1);
    expect(r?.occupancy).toMatchObject({ busyMs: 100_000, idleMs: 900_000 });
  });

  it("does not close on a termination request alone", () => {
    const { run, dispatch } = world({
      attempts: [{ ...stoppedAt100, terminationRequestedAt: at(101) }],
    });
    const r = infrastructureOf({ run, dispatch, agents: [], asOf: at(2000) });
    expect(r?.attempts[0]).toMatchObject({
      incomplete: true,
      observedEnd: false,
      terminationRequestedAt: at(101),
    });
    expect(r?.lifetime.coverage).toBe("unknown");
  });

  it("counts a replaced attempt with terminatedAt as closed and one without as incomplete", () => {
    const { run, dispatch } = world({
      attempts: [
        { ...stoppedAt100, endReason: "replaced" as const, terminatedAt: at(130) },
        {
          generation: 2,
          reason: "lease_lost",
          startedAt: at(200),
          endedAt: at(300),
          endReason: "replaced" as const,
        },
      ],
    });
    const r = infrastructureOf({ run, dispatch, agents: [], asOf: at(2000) });
    expect(r?.attempts.map((a) => a.incomplete)).toEqual([false, true]);
    expect(r?.lifetime).toMatchObject({
      coverage: "partial",
      observedEndings: 1,
      runnerOnlyEndings: 1,
      instanceLifetimeMs: 130_000,
    });
  });

  it("has unknown coverage when only runner endings exist", () => {
    const { run, dispatch } = world({
      attempts: [
        {
          generation: 1,
          reason: "dispatch",
          startedAt: at(0),
          endedAt: at(100),
          endReason: "failed",
        },
      ],
    });
    const r = infrastructureOf({ run, dispatch, agents: [], asOf: at(400) });
    expect(r?.lifetime.coverage).toBe("unknown");
    expect(r?.apportionment.perNode).toBeUndefined();
  });
});

describe("occupancyOf", () => {
  const f = createFixtures();
  const node = makeNode(f, f.rootNodeId);
  const id = node.executionNodeId;

  it("counts examination and setup, and not wait or queue", () => {
    const o = occupancyOf({
      operations: opsOf([
        iv(id, "setup", 0, 10),
        iv(id, "work", 10, 50),
        iv(id, "wait", 50, 60),
        iv(id, "queue", 60, 70),
        iv(id, "provisioning", 70, 80),
        iv(id, "examination", 80, 90),
        iv(id, "integration", 90, 95),
      ]),
      agents: [],
      asOf: at(100),
    });
    expect(o.coverage).toBe("observed");
    expect(o.intervals.map((i) => [i.from, i.to])).toEqual([
      [at(0), at(10)],
      [at(10), at(50)],
      [at(80), at(90)],
      [at(90), at(95)],
    ]);
  });

  it("runs open intervals to asOf and incomplete to observedUntil, as partial", () => {
    const o = occupancyOf({
      operations: opsOf([
        iv(id, "work", 0, undefined, "open"),
        iv(id, "examination", 10, undefined, "incomplete", { observedUntil: at(20) }),
      ]),
      agents: [],
      asOf: at(100),
    });
    expect(o.coverage).toBe("partial");
    expect(o.intervals.map((i) => i.to)).toEqual([at(100), at(20)]);
  });

  it("falls back to agent timestamps for an agent without an observed interval", () => {
    const seen = makeAgent(f, id, { startedAt: at(0), endedAt: at(50) });
    const legacy = makeAgent(f, id, { startedAt: at(60), endedAt: at(90) });
    const o = occupancyOf({
      operations: opsOf([iv(id, "work", 0, 50, "closed", { agentId: seen.agentId })]),
      agents: [seen, legacy],
      asOf: at(100),
    });
    expect(o.coverage).toBe("partial");
    expect(o.intervals).toHaveLength(2);
    expect(o.intervals[1]).toMatchObject({ from: at(60), to: at(90) });
  });

  it("is legacy with only agents and unknown with nothing", () => {
    const legacy = makeAgent(f, id, { startedAt: at(60), endedAt: at(90) });
    expect(occupancyOf({ operations: opsOf([]), agents: [legacy], asOf: at(100) }).coverage).toBe(
      "legacy",
    );
    expect(occupancyOf({ operations: opsOf([]), agents: [], asOf: at(100) })).toEqual({
      intervals: [],
      coverage: "unknown",
    });
  });

  it("reports idle only for observed or legacy coverage", () => {
    const { run, dispatch } = world({
      attempts: [
        {
          generation: 1,
          reason: "dispatch",
          startedAt: at(0),
          endedAt: at(100),
          endReason: "stopped",
          terminatedAt: at(100),
        },
      ],
    });
    const intervals = [{ nodeId: id, from: at(0), to: at(40) }];
    const observed = infrastructureOf({
      run,
      dispatch,
      agents: [],
      occupancy: { intervals, coverage: "observed" },
      asOf: at(200),
    });
    const partial = infrastructureOf({
      run,
      dispatch,
      agents: [],
      occupancy: { intervals, coverage: "partial" },
      asOf: at(200),
    });
    expect(observed?.occupancy.idleMs).toBe(60_000);
    expect(partial?.occupancy.idleMs).toBeUndefined();
    expect(partial?.occupancy.idleNote).toContain("partial");
    expect(partial?.occupancy.busyMs).toBe(40_000);
  });
});

describe("infrastructureUnavailable", () => {
  it("states that local machine expense has no configured basis", () => {
    expect(infrastructureUnavailable("no rate configured")).toBe(
      "Local machine expense is not reported: no configured basis (no rate configured).",
    );
  });
});
