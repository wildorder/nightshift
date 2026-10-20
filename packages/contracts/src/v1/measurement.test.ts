import { describe, expect, it } from "vitest";
import { ArtifactKindSchema } from "./artifact.js";
import {
  CoverageGapSchema,
  MAX_OBSERVATION_BYTES,
  MeasurementCountersSchema,
  MeasurementLedgerChunkSchema,
  MeasurementLedgerIndexSchema,
  MeasurementObservationSchema,
  MeasurementSummarySchema,
  observationBytes,
} from "./measurement.js";
import { RouteUsageSchema } from "./routing-decision.js";

const U = "01HF7YAT00GGGGGGGGGGGGGGGG";
const T = "2026-10-20T10:00:00Z";
const scope = {
  schemaVersion: 1,
  projectId: `proj_${U}`,
  programId: `prog_${U}`,
  runId: `run_${U}`,
};
const common = {
  ...scope,
  executionNodeId: `node_${U}`,
  source: "harness",
  provenance: { adapter: "claude" },
  receivedAt: T,
  inclusion: "self",
};
const launch = { agentId: `agent_${U}`, launchId: "l1", segment: 0 };

const observations = {
  request: {
    ...common,
    observationId: "o1",
    kind: "request",
    counters: { inputTokens: 10, outputTokens: 5, inputIncludesCache: false },
    model: "m",
    durationMs: 12,
    reportedCostUsd: 0.01,
  },
  snapshot: {
    ...common,
    observationId: "o2",
    kind: "cumulative_snapshot",
    counters: { inputTokens: 100 },
    counterScope: "session",
    launch,
  },
  terminal: {
    ...common,
    observationId: "o3",
    kind: "terminal_summary",
    counters: {},
    counterScope: "launch",
    exitKind: "cancelled",
    coverage: "unknown",
  },
  lifecycle: {
    ...common,
    observationId: "o4",
    kind: "lifecycle",
    operationId: "op1",
    phase: "verify",
    transition: "start",
    blockers: [{ kind: "approval", ref: "r1" }],
    parentOperationId: "op0",
    childRef: { kind: "session", id: "s1" },
  },
};

const segment = (n: number) => ({
  launchId: `l${n}`,
  segment: n,
  resumedSession: n > 0,
  open: false,
  counters: { inputTokens: 1 },
  coverage: "partial",
  sources: { requests: {}, requestCount: 0 },
  receivedSequence: 3,
  publishedSequence: 3,
  observed: { requests: 1, snapshots: 1, terminal: true },
});
const summary = (over: Record<string, unknown> = {}) => ({
  ...scope,
  measurementVersion: 1,
  measurementSummaryId: `meas_${U}`,
  executionNodeId: `node_${U}`,
  agentId: `agent_${U}`,
  role: "worker",
  routingDecisionId: null,
  route: { harness: "claude", provider: "anthropic", model: "m" },
  observedModels: ["m"],
  segments: [segment(0), segment(1)],
  totals: { inputTokens: 2 },
  coverage: "partial",
  gaps: [{ reason: "other" }],
  ledger: { chunks: 1, artifactIds: [`art_${U}`], observationCount: 3, publishedCount: 3 },
  valuation: { source: "unknown" },
  createdAt: T,
  updatedAt: T,
  ...over,
});

describe("measurement observations", () => {
  it.each(Object.entries(observations))("parses a %s observation", (_n, o) => {
    expect(MeasurementObservationSchema.safeParse(o).success).toBe(true);
  });

  it("refuses an observation over the byte bound", () => {
    const big = {
      ...observations.request,
      provenance: { adapter: "x".repeat(MAX_OBSERVATION_BYTES) },
    };
    expect(observationBytes(big)).toBeGreaterThan(MAX_OBSERVATION_BYTES);
    expect(MeasurementObservationSchema.safeParse(big).success).toBe(false);
  });

  it("refuses an unknown kind", () => {
    expect(
      MeasurementObservationSchema.safeParse({ ...observations.request, kind: "other" }).success,
    ).toBe(false);
  });
});

describe("measurement summary", () => {
  it("parses a full summary with two segments", () => {
    expect(MeasurementSummarySchema.safeParse(summary()).success).toBe(true);
  });

  it("parses with every optional field absent", () => {
    const s = summary();
    expect(s.segments[0]).not.toHaveProperty("sessionCumulative");
    expect(s.segments[0]).not.toHaveProperty("baseline");
    expect(s.segments[0]).not.toHaveProperty("exitKind");
    expect(s).not.toHaveProperty("childCounters");
    expect(s.ledger).not.toHaveProperty("indexArtifactId");
    expect(MeasurementSummarySchema.safeParse(s).success).toBe(true);
  });

  it("refuses a complete summary that lists a gap", () => {
    expect(MeasurementSummarySchema.safeParse(summary({ coverage: "complete" })).success).toBe(
      false,
    );
  });

  it("refuses a segment published past what it received", () => {
    const bad = { ...segment(0), publishedSequence: 4 };
    expect(MeasurementSummarySchema.safeParse(summary({ segments: [bad] })).success).toBe(false);
  });

  it("refuses a ledger published past its observation count", () => {
    const ledger = { chunks: 0, artifactIds: [], observationCount: 1, publishedCount: 2 };
    expect(MeasurementSummarySchema.safeParse(summary({ ledger })).success).toBe(false);
  });

  it("defaults a gap's count to 1", () => {
    expect(CoverageGapSchema.parse({ reason: "receipt_lost" }).count).toBe(1);
  });
});

describe("ledger artifact bodies", () => {
  it("parses a chunk and an index", () => {
    expect(
      MeasurementLedgerChunkSchema.safeParse({
        schemaVersion: 1,
        chunk: 0,
        segment: launch,
        fromSequence: 1,
        toSequence: 1,
        observations: [observations.request],
      }).success,
    ).toBe(true);
    expect(
      MeasurementLedgerIndexSchema.safeParse({
        schemaVersion: 1,
        previousIndexArtifactId: `art_${U}`,
        chunks: [
          { chunk: 0, artifactId: `art_${U}`, segment: launch, fromSequence: 1, toSequence: 1 },
        ],
      }).success,
    ).toBe(true);
    // A bare id preserves the reference when its range is unknown.
    expect(
      MeasurementLedgerIndexSchema.safeParse({
        schemaVersion: 1,
        chunks: [{ artifactId: `art_${U}` }],
      }).success,
    ).toBe(true);
    expect(
      MeasurementLedgerIndexSchema.safeParse({ schemaVersion: 1, chunks: [{ chunk: 0 }] }).success,
    ).toBe(false);
  });
});

describe("additive edits", () => {
  it("accepts measurement-ledger and previous artifact kinds", () => {
    for (const k of [
      "transcript",
      "build-log",
      "bundle",
      "report",
      "other",
      "measurement-ledger",
    ]) {
      expect(ArtifactKindSchema.safeParse(k).success).toBe(true);
    }
  });

  it("accepts route usage with and without inputIncludesCache", () => {
    expect(RouteUsageSchema.safeParse({ inputTokens: 1 }).success).toBe(true);
    expect(RouteUsageSchema.safeParse({ inputTokens: 1, inputIncludesCache: true }).success).toBe(
      true,
    );
  });
});

describe("MeasurementCountersSchema reportedUsd", () => {
  it("accepts counters with and without reported dollars, never negative", () => {
    expect(MeasurementCountersSchema.safeParse({ inputTokens: 1 }).success).toBe(true);
    expect(MeasurementCountersSchema.safeParse({ inputTokens: 1, reportedUsd: 1.5 }).success).toBe(
      true,
    );
    expect(MeasurementCountersSchema.safeParse({ reportedUsd: -1 }).success).toBe(false);
  });
});
