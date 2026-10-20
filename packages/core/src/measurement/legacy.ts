import {
  type Agent,
  type MeasurementSummary,
  MeasurementSummaryIdSchema,
  type RoutingDecision,
} from "@nightshift/contracts";
import { countersFromRouteUsage } from "./normalize.js";

/**
 * The summary of an agent that ran before request-level capture: one closed
 * segment from its routing decision's usage, coverage `legacy`. The summary id
 * is the agent id's own ULID, so building it twice names the same record.
 */
export const legacySummaryOf = (
  agent: Agent,
  decision: RoutingDecision | undefined,
  at: string,
): MeasurementSummary => {
  const counters = decision === undefined ? {} : countersFromRouteUsage(decision.usage);
  const ulid = agent.agentId.slice(agent.agentId.indexOf("_") + 1);
  return {
    measurementVersion: 1,
    schemaVersion: agent.schemaVersion,
    projectId: agent.projectId,
    programId: agent.programId,
    runId: agent.runId,
    measurementSummaryId: MeasurementSummaryIdSchema.parse(`meas_${ulid}`),
    executionNodeId: agent.executionNodeId,
    agentId: agent.agentId,
    role: agent.role,
    routingDecisionId: decision?.routingDecisionId ?? null,
    route: decision?.chosen ?? {
      harness: agent.harness,
      provider: agent.provider,
      model: agent.model,
    },
    observedModels: [],
    segments: [
      {
        launchId: "legacy",
        segment: 0,
        ...(agent.sessionId === undefined ? {} : { sessionId: agent.sessionId }),
        resumedSession: false,
        open: false,
        counters,
        coverage: "legacy",
        sources: { requests: counters, requestCount: 0 },
        receivedSequence: 0,
        publishedSequence: 0,
        observed: { requests: 0, snapshots: 0, terminal: false },
      },
    ],
    totals: counters,
    coverage: "legacy",
    gaps: [
      {
        reason: "adapter_unsupported",
        detail: "recorded before request-level capture",
        count: 1,
      },
    ],
    ledger: { chunks: 0, artifactIds: [], observationCount: 0, publishedCount: 0 },
    valuation: {
      source: counters.reportedUsd === undefined ? "unknown" : "reported",
      ...(counters.reportedUsd === undefined
        ? {}
        : { usd: counters.reportedUsd, reportedUsd: counters.reportedUsd }),
    },
    createdAt: at,
    updatedAt: at,
  };
};
