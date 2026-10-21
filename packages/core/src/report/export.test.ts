import {
  AGGREGATE_EXAMPLES,
  type Agent,
  type ExecutionNode,
  type MeasurementSummary,
  type ProgramContract,
  ProgramContractSchema,
  ReportExportSchema,
  type RoutingDecision,
  type Run,
  RunSchema,
  reportExportVersion,
} from "@nightshift/contracts";
import { describe, expect, it } from "vitest";
import { createFixtures, FIXTURE_TIMESTAMP } from "../testing/factories.js";
import { emptyMeasuredReport } from "../testing/report-defaults.js";
import { attemptRowsOf } from "./attempts.js";
import { METRIC_DEFINITIONS } from "./definitions.js";
import { exportReport } from "./export.js";
import type { RunReport } from "./report.js";

const fixtures = createFixtures();
const nodeId = fixtures.ids.next("node");
const program = ProgramContractSchema.parse(
  structuredClone(AGGREGATE_EXAMPLES.ProgramContract) as Record<string, unknown>,
) as ProgramContract;
const run = RunSchema.parse({
  ...(structuredClone(AGGREGATE_EXAMPLES.Run) as Record<string, unknown>),
  status: "succeeded",
}) as Run;

const route = (over: Partial<RoutingDecision>): RoutingDecision =>
  ({
    schemaVersion: 1,
    ...fixtures.scope,
    routingDecisionId: fixtures.ids.next("route"),
    executionNodeId: nodeId,
    attempt: 1,
    eligibleOptions: [],
    chosen: { harness: "claude", provider: "anthropic", model: "m1" },
    ruleId: "r",
    wasOverride: false,
    usage: {},
    outcome: "verified",
    previousRouteId: null,
    createdAt: FIXTURE_TIMESTAMP,
    ...over,
  }) as RoutingDecision;

const work = route({ role: "implementer", usage: { wallClockMs: 9000 } });
const exam = route({
  purpose: "examine",
  role: "examiner",
  chosen: { harness: "codex", provider: "openai", model: "m2" },
});
const summaries: MeasurementSummary[] = [
  {
    measurementVersion: 1,
    ...fixtures.scope,
    measurementSummaryId: fixtures.ids.next("meas"),
    executionNodeId: nodeId,
    agentId: fixtures.ids.next("agent"),
    role: "worker",
    routingDecisionId: work.routingDecisionId,
    route: { harness: "claude", provider: "anthropic", model: "m1" },
    observedModels: ["m1"],
    segments: [],
    totals: { inputTokens: 100, outputTokens: 20, inputIncludesCache: true },
    coverage: "complete",
    gaps: [],
    ledger: { chunks: 1, artifactIds: ["art_1", "art_2"], observationCount: 1, publishedCount: 1 },
    valuation: { source: "unknown" },
    createdAt: FIXTURE_TIMESTAMP,
    updatedAt: FIXTURE_TIMESTAMP,
  } as unknown as MeasurementSummary,
];
const agents: Agent[] = [
  {
    ...fixtures.scope,
    agentId: summaries[0]?.agentId,
    executionNodeId: nodeId,
    role: "worker",
    harness: "claude",
    provider: "anthropic",
    model: "m1",
    status: "completed",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:00:05.000Z",
    createdAt: FIXTURE_TIMESTAMP,
  } as unknown as Agent,
];
const nodes = [
  {
    ...fixtures.scope,
    executionNodeId: nodeId,
    kind: "job",
    parentNodeId: "node_parent",
    depth: 1,
    status: "integrated",
    jobContractId: null,
    commitSha: null,
    createdAt: FIXTURE_TIMESTAMP,
    updatedAt: FIXTURE_TIMESTAMP,
  } as unknown as ExecutionNode,
];

const report = (): RunReport => ({
  program: { ...program, strands: [] },
  run,
  strands: [],
  criteria: [],
  pendingPrerequisites: [],
  graph: [],
  corrections: [],
  usage: [],
  rulings: [],
  attempts: attemptRowsOf({ routes: [work, exam], measurements: summaries, agents, nodes }),
  gateHealth: {
    audit: undefined,
    red: undefined,
    repairs: [],
    flakes: [],
    verificationTime: { steps: [], landings: 0, verifications: 0, totalMs: 0, recommendations: [] },
  },
  stepAdjustments: { skipped: [], raised: [] },
  ...emptyMeasuredReport(run),
});

describe("exportReport", () => {
  it("parses with the versioned schema and names its scope", () => {
    const out = exportReport(report());
    expect(ReportExportSchema.parse(out)).toEqual(out);
    expect(out.reportExportVersion).toBe(reportExportVersion);
    expect(out.reportExportVersion).toBe(1);
    expect(out.scope).toEqual({
      projectId: run.projectId,
      programId: run.programId,
      runId: run.runId,
    });
    expect(out.run.status).toBe("succeeded");
    expect(out.sampleSize).toEqual({ matched: 2, total: 2 });
    expect(out.filters).toEqual({});
  });

  it("filters attempts by role and model and reports the sample size", () => {
    const byRole = exportReport(report(), { role: "examiner" });
    expect(byRole.attempts.map((a) => a.model)).toEqual(["m2"]);
    expect(byRole.sampleSize).toEqual({ matched: 1, total: 2 });
    expect(byRole.filters).toEqual({ role: "examiner" });
    const byModel = exportReport(report(), { model: "m1" });
    expect(byModel.attempts).toHaveLength(1);
    expect(byModel.attempts[0]?.role).toBe("implementer");
    expect(exportReport(report(), { model: "nope" }).sampleSize).toEqual({ matched: 0, total: 2 });
  });

  it("filters by time window on the agent's start", () => {
    const inside = exportReport(report(), {
      from: "2025-12-31T00:00:00.000Z",
      to: "2026-01-02T00:00:00.000Z",
    });
    expect(inside.attempts.map((a) => a.role)).toEqual(["implementer"]);
    expect(exportReport(report(), { from: "2026-02-01T00:00:00.000Z" }).sampleSize.matched).toBe(0);
    expect(exportReport(report(), { to: "2025-01-01T00:00:00.000Z" }).sampleSize.matched).toBe(0);
  });

  it("carries ledger artifact ids per attempt with a summary, none otherwise", () => {
    const out = exportReport(report());
    const measured = out.attempts.find((a) => a.role === "implementer");
    const unmeasured = out.attempts.find((a) => a.role === "examiner");
    expect(measured?.ledgerArtifactIds).toEqual(["art_1", "art_2"]);
    expect(unmeasured?.ledgerArtifactIds).toEqual([]);
    expect(unmeasured?.coverage).toBe("missing");
  });

  it("embeds a definition for every metric a section uses", () => {
    const out = exportReport(report());
    const ids = new Set(out.definitions.map((d) => d.id));
    for (const used of Object.values(out.metricsBySection).flat()) {
      expect(ids.has(used)).toBe(true);
      expect(METRIC_DEFINITIONS[used as keyof typeof METRIC_DEFINITIONS]).toBeDefined();
    }
    expect(ids.has("sample_size")).toBe(true);
    expect(ids.has("combined_estimate")).toBe(true);
  });

  it("rejects an export that uses a metric it does not define", () => {
    const out = exportReport(report());
    const bad = { ...out, metricsBySection: { attempts: ["invented_metric"] } };
    expect(ReportExportSchema.safeParse(bad).success).toBe(false);
  });

  it("states the usage row's label, valuation count and absent figures", () => {
    const out = exportReport({
      ...report(),
      usage: [
        {
          harness: "claude",
          model: "m1",
          purpose: "work",
          attempts: 2,
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
          estimated: false,
          unpriced: 2,
          tokensObserved: 0,
          reportedAttempts: 0,
          estimatedAttempts: 0,
        },
      ],
    });
    const row = out.usage[0];
    expect(row?.label).toBe("unknown");
    expect(row?.costUsd).toBeUndefined();
    expect(row?.inputTokens).toBeUndefined();
    expect(row?.attemptsValued).toBe(0);
  });
});
