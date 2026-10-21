/**
 * The routing dataset (P8, SC-P8-15, SC-11): every routing decision of a run,
 * each with its job, its classification, its attempt chain, its usage and how
 * the work it ran came out, self-contained so a learned router can train on the
 * lines without joining anything. Gathered from the control plane alone.
 */
import {
  type Examination,
  type ExecutionNode,
  type JobContract,
  type MeasurementSummary,
  type RouteOutcome,
  type RoutingDatasetLine,
  RoutingDatasetLineSchema,
  type RoutingDecision,
  type Run,
  type Verification,
} from "@nightshift/contracts";
import { type ProjectStores, type RunScope, routeUsageFromCounters } from "@nightshift/core";

const readAll = async <T>(
  read: (page: {
    cursor?: string;
  }) => Promise<{ readonly items: readonly T[]; readonly cursor?: string | undefined }>,
): Promise<T[]> => {
  const items: T[] = [];
  let cursor: string | undefined;
  do {
    const page = await read(cursor === undefined ? {} : { cursor });
    items.push(...page.items);
    cursor = page.cursor;
  } while (cursor !== undefined);
  return items;
};

type Judgement = RoutingDatasetLine["judgement"];

const examinationOf = (examination: Examination) => ({
  outcome: examination.outcome,
  blocking: examination.blocking,
  fixAttempt: examination.fixAttempt,
});

/**
 * What judged a decision's work. Only explicit links make it the decision's own
 * (`attempt`); a node whose records carry none gives its final records, marked
 * historical so they are never read as this attempt's judgement.
 */
const judgementOf = (
  decision: RoutingDecision,
  node: {
    readonly verifications: readonly Verification[];
    readonly examinations: readonly Examination[];
  },
): Judgement => {
  const none: Judgement = {
    verification: null,
    examination: null,
    link: "none",
    historical: false,
  };
  if (node.verifications.length === 0 && node.examinations.length === 0) return none;
  const purpose = decision.purpose ?? "work";
  const newest = <T extends { readonly createdAt?: string; readonly endedAt?: string }>(
    items: readonly T[],
  ): T | undefined =>
    [...items]
      .sort((a, b) =>
        (a.endedAt ?? a.createdAt ?? "").localeCompare(b.endedAt ?? b.createdAt ?? ""),
      )
      .at(-1);
  if (purpose === "work") {
    const own = node.verifications.filter(
      (candidate) => candidate.routingDecisionId === decision.routingDecisionId,
    );
    // The queue's verdict is the attempt's; a candidate check stands only when the queue never ran.
    const verification =
      newest(own.filter((candidate) => candidate.phase !== "candidate")) ?? newest(own);
    const examination = newest(
      node.examinations.filter(
        (candidate) => candidate.implementerRoutingDecisionId === decision.routingDecisionId,
      ),
    );
    if (verification !== undefined || examination !== undefined) {
      return {
        verification: verification?.outcome ?? null,
        examination: examination === undefined ? null : examinationOf(examination),
        link: "attempt",
        historical: false,
      };
    }
  } else if (decision.concerning?.kind === "examination") {
    const named = decision.concerning.examinationId;
    const examination = node.examinations.find((candidate) => candidate.examinationId === named);
    if (examination !== undefined) {
      return {
        verification: null,
        examination: examinationOf(examination),
        link: "attempt",
        historical: false,
      };
    }
  }
  // A helper is never judged by the implementer's verification, linked or not.
  if (purpose !== "work") return none;
  const linked =
    node.verifications.some((candidate) => candidate.routingDecisionId !== undefined) ||
    node.examinations.some((candidate) => candidate.implementerRoutingDecisionId !== undefined);
  // Records are linked, and none names this attempt: it was not judged on its own.
  if (linked) return none;
  const verification = newest(
    node.verifications.filter((candidate) => candidate.phase !== "candidate"),
  );
  const examination = newest(node.examinations);
  return {
    verification: verification?.outcome ?? null,
    examination: examination === undefined ? null : examinationOf(examination),
    link: "node_final",
    historical: true,
  };
};

const newestSummary = (summaries: readonly MeasurementSummary[]): MeasurementSummary | undefined =>
  [...summaries].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)).at(-1);

/** The fields every line shares, whatever its decision. */
const baseOf = (scope: RunScope, node: ExecutionNode, job: JobContract | undefined) => ({
  schemaVersion: 3,
  projectId: scope.projectId,
  programId: scope.programId,
  runId: scope.runId,
  executionNodeId: node.executionNodeId,
  jobContractId: node.jobContractId,
  strandId: job?.strandId ?? null,
});

const timingOf = (usage: RoutingDecision["usage"], summary: MeasurementSummary | undefined) => ({
  agentMs: usage.agentMs ?? null,
  settlementMs: usage.wallClockMs ?? null,
  measurementSummaryId: summary?.measurementSummaryId ?? null,
  measurementCoverage: summary?.coverage ?? "missing",
});

/** One decision as a line: the decision, its job, and how the work came out. */
const lineOf = (
  scope: RunScope,
  node: ExecutionNode,
  job: JobContract | undefined,
  decision: RoutingDecision,
  judgement: Judgement,
  summary: MeasurementSummary | undefined,
): RoutingDatasetLine =>
  RoutingDatasetLineSchema.parse({
    ...baseOf(scope, node, job),
    routingDecisionId: decision.routingDecisionId,
    purpose: decision.purpose ?? "work",
    attempt: decision.attempt,
    previousRouteId: decision.previousRouteId,
    ruleId: decision.ruleId,
    wasOverride: decision.wasOverride,
    ladder: decision.ladder ?? null,
    rung: decision.rung ?? null,
    role: decision.role ?? null,
    position: decision.position ?? null,
    classification: decision.classification ?? null,
    policyVersion: decision.policyVersion ?? null,
    chosen: decision.chosen,
    eligibleOptions: decision.eligibleOptions,
    usage: decision.usage,
    outcome: decision.outcome,
    nodeOutcome: node.status,
    judgement,
    ...timingOf(decision.usage, summary),
    createdAt: decision.createdAt,
  });

/** The root launch's route outcome: the run's observed result, pending until it has one. */
const rootOutcomeOf = (run: Pick<Run, "status"> | undefined): RouteOutcome => {
  switch (run?.status) {
    case "succeeded":
      return "succeeded";
    case "failed":
      return "failed";
    case "cancelled":
    case "interrupted":
      return "cancelled";
    default:
      return "pending";
  }
};

/**
 * A root's line, from the summary of its launch (no routing decision exists).
 * Its usage is the summary's totals; it was not judged as an attempt.
 */
const rootLineOf = (
  scope: RunScope,
  node: ExecutionNode,
  summary: MeasurementSummary,
  run: Pick<Run, "status"> | undefined,
): RoutingDatasetLine => {
  const usage = routeUsageFromCounters(summary.totals, {
    ...(summary.valuation.reportedUsd === undefined
      ? {}
      : { reportedUsd: summary.valuation.reportedUsd }),
  });
  return RoutingDatasetLineSchema.parse({
    ...baseOf(scope, node, undefined),
    routingDecisionId: null,
    purpose: "root",
    attempt: 1,
    previousRouteId: null,
    ruleId: "root",
    wasOverride: false,
    ladder: null,
    rung: null,
    role: null,
    position: null,
    classification: null,
    policyVersion: null,
    chosen: summary.route,
    eligibleOptions: [],
    usage,
    outcome: rootOutcomeOf(run),
    nodeOutcome: node.status,
    judgement: { verification: null, examination: null, link: "none", historical: false },
    ...timingOf(usage, summary),
    createdAt: summary.createdAt,
  });
};

/** One run's lines, in the order the decisions were made. */
export const routingDataset = async (
  stores: ProjectStores,
  scope: RunScope,
): Promise<readonly RoutingDatasetLine[]> => {
  const nodes = await readAll<ExecutionNode>((page) =>
    stores.executionNodes.listByRun(scope, page),
  );
  const jobs = await readAll<JobContract>((page) => stores.jobContracts.listByRun(scope, page));
  const summaries = await readAll<MeasurementSummary>((page) =>
    stores.measurements.listByRun(scope, page),
  );
  const run = await stores.runs.get(scope, scope.runId);
  const jobOf = new Map(jobs.map((job) => [job.jobContractId as string, job]));
  const lines: RoutingDatasetLine[] = [];
  for (const node of nodes) {
    const job = node.jobContractId === null ? undefined : jobOf.get(node.jobContractId);
    if (node.parentNodeId === null) {
      const rootSummary = newestSummary(
        summaries.filter(
          (summary) =>
            summary.routingDecisionId === null && summary.executionNodeId === node.executionNodeId,
        ),
      );
      if (rootSummary !== undefined) lines.push(rootLineOf(scope, node, rootSummary, run));
      continue;
    }
    const decisions = await stores.routingDecisions.listByNode(scope, node.executionNodeId);
    if (decisions.length === 0) continue;
    const records = {
      verifications: await stores.verifications.listByNode(scope, node.executionNodeId),
      examinations: await stores.examinations.listByNode(scope, node.executionNodeId),
    };
    for (const decision of decisions) {
      const summary = newestSummary(
        summaries.filter((candidate) => candidate.routingDecisionId === decision.routingDecisionId),
      );
      lines.push(lineOf(scope, node, job, decision, judgementOf(decision, records), summary));
    }
  }
  return lines.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
};
