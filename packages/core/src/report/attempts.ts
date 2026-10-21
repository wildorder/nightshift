/**
 * One row per attempt (P20): every routing decision, work and helper, with the
 * resources its measurement summary recorded, and the root launch when a
 * summary exists for it. Pure over records already read.
 *
 * A route without a summary keeps `legacy` or `missing` coverage and absent
 * tokens; nothing is turned into zero.
 */
import type {
  Agent,
  ExecutionNode,
  MeasurementSummary,
  RoutingDecision,
} from "@nightshift/contracts";
import {
  type AttemptResources,
  type ResourceCoverage,
  type ResourceTotals,
  resourcesOf,
  resourcesOfSummary,
  sumResources,
} from "./resources.js";

export interface AttemptRow {
  readonly nodeId: string;
  readonly strandId: string | null;
  /** `work`, a helper purpose (`examine`, `answer`, `arbitrate`), or `root`. */
  readonly purpose: string;
  readonly role: string | null;
  readonly attempt: number;
  readonly harness: string;
  readonly model: string;
  readonly observedModels: string[];
  readonly routingDecisionId: string | null;
  readonly measurementSummaryId?: string;
  readonly agentId?: string;
  readonly startedAt?: string;
  readonly endedAt?: string;
  /** Harness execution time, from the agent record's start and end. */
  readonly agentMs?: number;
  /** From attempt start until the node settled, including verification, queue and integration. */
  readonly settlementMs?: number;
  readonly resources: ResourceTotals;
  readonly coverage: "complete" | "partial" | "unknown" | "legacy" | "missing";
  readonly outcome: string | null;
  readonly ledgerArtifactIds: string[];
  readonly root: boolean;
}

export interface AttemptInputs {
  readonly routes: readonly RoutingDecision[];
  readonly measurements: readonly MeasurementSummary[];
  readonly agents: readonly Agent[];
  readonly nodes: readonly ExecutionNode[];
  readonly strandOfNode?: (nodeId: string) => string | null | undefined;
}

const newest = (summaries: readonly MeasurementSummary[]): MeasurementSummary | undefined =>
  [...summaries].sort((a, b) =>
    a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0,
  )[0];

const spanMs = (startedAt: string | undefined, endedAt: string | undefined): number | undefined => {
  if (startedAt === undefined || endedAt === undefined) return undefined;
  const ms = Date.parse(endedAt) - Date.parse(startedAt);
  return Number.isFinite(ms) && ms >= 0 ? ms : undefined;
};

const optional = <K extends string, V>(key: K, value: V | undefined) =>
  value === undefined ? {} : ({ [key]: value } as { [P in K]: V });

export const attemptRowsOf = (input: AttemptInputs): AttemptRow[] => {
  const agentById = new Map(input.agents.map((agent) => [agent.agentId, agent]));
  const strandOf = (nodeId: string): string | null => input.strandOfNode?.(nodeId) ?? null;
  const build = (
    base: Pick<
      AttemptRow,
      | "nodeId"
      | "purpose"
      | "role"
      | "attempt"
      | "harness"
      | "model"
      | "routingDecisionId"
      | "outcome"
      | "root"
    >,
    summary: MeasurementSummary | undefined,
    resources: AttemptResources,
    settlementMs: number | undefined,
  ): AttemptRow => {
    const agent = summary === undefined ? undefined : agentById.get(summary.agentId);
    const agentMs = spanMs(agent?.startedAt, agent?.endedAt);
    return {
      ...base,
      strandId: strandOf(base.nodeId),
      observedModels: summary === undefined ? [] : [...summary.observedModels],
      ...optional("measurementSummaryId", summary?.measurementSummaryId),
      ...optional("agentId", summary?.agentId),
      ...optional("startedAt", agent?.startedAt),
      ...optional("endedAt", agent?.endedAt),
      ...optional("agentMs", agentMs),
      ...optional("settlementMs", settlementMs),
      resources: sumResources([resources]),
      coverage: resources.coverage satisfies ResourceCoverage,
      ledgerArtifactIds: summary === undefined ? [] : [...summary.ledger.artifactIds],
    };
  };

  const rows: AttemptRow[] = input.routes.map((route) =>
    build(
      {
        nodeId: route.executionNodeId,
        purpose: route.purpose ?? "work",
        role: route.role ?? null,
        attempt: route.attempt,
        harness: route.chosen.harness,
        model: route.chosen.model,
        routingDecisionId: route.routingDecisionId,
        outcome: route.outcome ?? null,
        root: false,
      },
      newest(
        input.measurements.filter(
          (summary) => summary.routingDecisionId === route.routingDecisionId,
        ),
      ),
      resourcesOf(route, input.measurements),
      route.usage.wallClockMs,
    ),
  );

  const rootIds = new Set(
    input.nodes.filter((node) => node.parentNodeId === null).map((node) => node.executionNodeId),
  );
  for (const nodeId of rootIds) {
    const summary = newest(
      input.measurements.filter(
        (candidate) => candidate.routingDecisionId === null && candidate.executionNodeId === nodeId,
      ),
    );
    if (summary === undefined) continue;
    const node = input.nodes.find((candidate) => candidate.executionNodeId === nodeId);
    rows.push(
      build(
        {
          nodeId,
          purpose: "root",
          role: summary.role,
          attempt: 1,
          harness: summary.route.harness,
          model: summary.route.model,
          routingDecisionId: null,
          outcome: node?.status ?? null,
          root: true,
        },
        summary,
        resourcesOfSummary(summary),
        undefined,
      ),
    );
  }
  return rows;
};

export interface AttemptFilter {
  readonly role?: string;
  readonly model?: string;
  readonly from?: string;
  readonly to?: string;
}

export interface AttemptFilterResult {
  readonly rows: AttemptRow[];
  readonly sampleSize: { readonly matched: number; readonly total: number };
}

/** Filters rows; a time window uses `startedAt`, else `endedAt`, and excludes rows with neither. */
export const filterAttempts = (
  rows: readonly AttemptRow[],
  filter: AttemptFilter,
): AttemptFilterResult => {
  const timed = filter.from !== undefined || filter.to !== undefined;
  const matched = rows.filter((row) => {
    if (filter.role !== undefined && row.role !== filter.role) return false;
    if (filter.model !== undefined && row.model !== filter.model) return false;
    if (timed) {
      const at = row.startedAt ?? row.endedAt;
      if (at === undefined) return false;
      const time = Date.parse(at);
      if (filter.from !== undefined && time < Date.parse(filter.from)) return false;
      if (filter.to !== undefined && time > Date.parse(filter.to)) return false;
    }
    return true;
  });
  return { rows: matched, sampleSize: { matched: matched.length, total: rows.length } };
};
