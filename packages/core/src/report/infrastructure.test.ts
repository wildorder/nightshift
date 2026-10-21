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
import { infrastructureOf, infrastructureUnavailable } from "./infrastructure.js";

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
    expect(instance).toMatchObject({ seconds: 1000, basis: "metered seconds", usd: 1 });
    expect(volume).toMatchObject({ seconds: 1600, open: false, usd: 0.16, coverage: "complete" });
    expect(total?.usd).toBe(1.16);
    expect(total?.basis).toContain("1000 s from metered seconds");
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
        },
        { generation: 2, reason: "lease_lost", startedAt: at(800) },
      ],
    });
    const r = infrastructureOf({ run, dispatch, agents: [], asOf: at(2000) });
    expect(r?.lifetime).toMatchObject({
      gapsBetweenAttemptsMs: 300_000,
      openAttempts: 1,
      coverage: "partial",
      instanceLifetimeMs: 500_000,
      lastEndedAt: at(500),
    });
    expect(r?.attempts.map((a) => a.incomplete)).toEqual([false, true]);
    expect(r?.attempts[1]?.lifetimeMs).toBeUndefined();
    expect(r?.components.instance).toMatchObject({
      seconds: 500,
      basis: "closed attempt lifetimes",
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
      { generation: 1, reason: "dispatch", startedAt: at(0), endedAt: at(100) },
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
      attempts: [{ generation: 1, reason: "dispatch", startedAt: at(0), endedAt: at(1000) }],
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

describe("infrastructureUnavailable", () => {
  it("states that local machine expense has no configured basis", () => {
    expect(infrastructureUnavailable("no rate configured")).toBe(
      "Local machine expense is not reported: no configured basis (no rate configured).",
    );
  });
});
