import type {
  Agent,
  ExecutionNode,
  MeasurementSummary,
  RoutingDecision,
} from "@nightshift/contracts";
import { describe, expect, it } from "vitest";
import { createFixtures, FIXTURE_TIMESTAMP } from "../testing/factories.js";
import { attemptRowsOf, filterAttempts } from "./attempts.js";

const fixtures = createFixtures();
const helperNodeId = fixtures.ids.next("node");

const route = (over: Partial<RoutingDecision> = {}): RoutingDecision =>
  ({
    schemaVersion: 1,
    ...fixtures.scope,
    routingDecisionId: fixtures.ids.next("route"),
    executionNodeId: helperNodeId,
    attempt: 1,
    eligibleOptions: [
      { target: { harness: "claude", provider: "anthropic", model: "m1" }, eligible: true },
    ],
    chosen: { harness: "claude", provider: "anthropic", model: "m1" },
    ruleId: "r",
    wasOverride: false,
    usage: {},
    outcome: "verified",
    previousRouteId: null,
    createdAt: FIXTURE_TIMESTAMP,
    ...over,
  }) as RoutingDecision;

const summary = (over: Partial<MeasurementSummary>): MeasurementSummary =>
  ({
    measurementVersion: 1,
    ...fixtures.scope,
    measurementSummaryId: fixtures.ids.next("meas"),
    executionNodeId: helperNodeId,
    agentId: fixtures.ids.next("agent"),
    role: "worker",
    routingDecisionId: null,
    route: { harness: "claude", provider: "anthropic", model: "m1" },
    observedModels: ["m1-actual"],
    segments: [],
    totals: {},
    coverage: "complete",
    gaps: [],
    ledger: { chunks: 1, artifactIds: ["art_1"], observationCount: 1, publishedCount: 1 },
    valuation: { source: "unknown" },
    createdAt: FIXTURE_TIMESTAMP,
    updatedAt: FIXTURE_TIMESTAMP,
    ...over,
  }) as MeasurementSummary;

const agentFor = (s: MeasurementSummary, startedAt?: string, endedAt?: string): Agent =>
  ({
    ...fixtures.scope,
    agentId: s.agentId,
    executionNodeId: s.executionNodeId,
    role: s.role,
    harness: "claude",
    provider: "anthropic",
    model: "m1",
    status: "completed",
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(endedAt === undefined ? {} : { endedAt }),
    createdAt: FIXTURE_TIMESTAMP,
  }) as Agent;

const node = (id: string, parentNodeId: string | null): ExecutionNode =>
  ({
    ...fixtures.scope,
    executionNodeId: id,
    kind: parentNodeId === null ? "program" : "job",
    parentNodeId,
    depth: parentNodeId === null ? 0 : 1,
    status: parentNodeId === null ? "succeeded" : "integrated",
    jobContractId: null,
    commitSha: null,
    createdAt: FIXTURE_TIMESTAMP,
    updatedAt: FIXTURE_TIMESTAMP,
  }) as unknown as ExecutionNode;

const work = route({
  role: "implementer",
  usage: { wallClockMs: 9000, actualCostUsd: 1, costSource: "reported" },
});
const helper = route({
  purpose: "examine",
  role: "examiner",
  attempt: 1,
  chosen: { harness: "codex", provider: "openai", model: "m2" },
});
const legacy = route({
  attempt: 2,
  previousRouteId: work.routingDecisionId,
  usage: {},
  chosen: { harness: "claude", provider: "anthropic", model: "m3" },
});
const workSummary = summary({
  routingDecisionId: work.routingDecisionId,
  totals: { inputTokens: 100, outputTokens: 20, inputIncludesCache: true },
});
const helperSummary = summary({
  routingDecisionId: helper.routingDecisionId,
  role: "examiner",
  totals: { inputTokens: 10, outputTokens: 2, inputIncludesCache: true },
});
const rootSummary = summary({
  executionNodeId: fixtures.rootNodeId,
  totals: { inputTokens: 5, inputIncludesCache: true },
});

const rows = attemptRowsOf({
  routes: [work, helper, legacy],
  measurements: [workSummary, helperSummary, rootSummary],
  agents: [
    agentFor(workSummary, "2026-10-01T10:00:00.000Z", "2026-10-01T10:00:05.000Z"),
    agentFor(helperSummary, "2026-10-02T10:00:00.000Z"),
    agentFor(rootSummary),
  ],
  nodes: [node(fixtures.rootNodeId, null), node(helperNodeId, fixtures.rootNodeId)],
  strandOfNode: (id) => (id === helperNodeId ? "S-01" : null),
});

describe("attemptRowsOf", () => {
  it("makes a work row from a decision and its summary", () => {
    const row = rows[0];
    expect(row).toMatchObject({
      purpose: "work",
      role: "implementer",
      attempt: 1,
      harness: "claude",
      model: "m1",
      observedModels: ["m1-actual"],
      strandId: "S-01",
      measurementSummaryId: workSummary.measurementSummaryId,
      agentId: workSummary.agentId,
      agentMs: 5000,
      settlementMs: 9000,
      coverage: "complete",
      outcome: "verified",
      ledgerArtifactIds: ["art_1"],
      root: false,
    });
    expect(row?.resources.tokens.input).toBe(100);
  });

  it("makes a helper row with its purpose", () => {
    expect(rows[1]).toMatchObject({
      purpose: "examine",
      role: "examiner",
      model: "m2",
      root: false,
    });
    expect(rows[1]?.agentMs).toBeUndefined();
  });

  it("keeps a legacy route without a summary legacy-or-missing, with tokens absent", () => {
    const row = rows[2];
    expect(row?.coverage).toBe("missing");
    expect(row?.measurementSummaryId).toBeUndefined();
    expect(row?.resources.tokens.input).toBeUndefined();
    const withTokens = attemptRowsOf({
      routes: [route({ usage: { inputTokens: 7 } })],
      measurements: [],
      agents: [],
      nodes: [],
    });
    expect(withTokens[0]?.coverage).toBe("legacy");
    expect(withTokens[0]?.resources.tokens.input).toBe(7);
    expect(withTokens[0]?.resources.tokens.output).toBeUndefined();
  });

  it("adds a root row only when a null-route summary exists for the root node", () => {
    expect(rows).toHaveLength(4);
    expect(rows[3]).toMatchObject({
      root: true,
      purpose: "root",
      attempt: 1,
      routingDecisionId: null,
      nodeId: fixtures.rootNodeId,
    });
    expect(rows[3]?.resources.tokens.input).toBe(5);
    const none = attemptRowsOf({
      routes: [work],
      measurements: [workSummary],
      agents: [],
      nodes: [node(fixtures.rootNodeId, null)],
    });
    expect(none.some((row) => row.root)).toBe(false);
  });
});

describe("filterAttempts", () => {
  it("filters by role", () => {
    const result = filterAttempts(rows, { role: "examiner" });
    expect(result.rows).toHaveLength(1);
    expect(result.sampleSize).toEqual({ matched: 1, total: 4 });
  });

  it("filters by model", () => {
    const result = filterAttempts(rows, { model: "m1" });
    expect(result.sampleSize).toEqual({ matched: 2, total: 4 });
  });

  it("filters by time on startedAt, excluding rows with neither time", () => {
    const result = filterAttempts(rows, {
      from: "2026-10-01T00:00:00.000Z",
      to: "2026-10-01T23:59:59.000Z",
    });
    expect(result.rows.map((row) => row.agentId)).toEqual([workSummary.agentId]);
    expect(result.sampleSize).toEqual({ matched: 1, total: 4 });
    expect(filterAttempts(rows, { from: "2026-10-02T00:00:00.000Z" }).sampleSize).toEqual({
      matched: 1,
      total: 4,
    });
  });

  it("uses endedAt when startedAt is absent", () => {
    const only = attemptRowsOf({
      routes: [work],
      measurements: [workSummary],
      agents: [agentFor(workSummary, undefined, "2026-10-03T00:00:00.000Z")],
      nodes: [],
    });
    expect(filterAttempts(only, { from: "2026-10-03T00:00:00.000Z" }).sampleSize).toEqual({
      matched: 1,
      total: 1,
    });
  });
});
