/**
 * What was delivered and what it took (P20, S-05). Pure: nodes, job contracts,
 * routing decisions and measurement summaries in, a report out.
 *
 * Population: a work item is a job node; a strand is a sub-program node and is
 * counted apart; an attempt is a routing decision with no `purpose`; a helper
 * call is one with a purpose and is never a work item. Every token and dollar
 * figure comes from `resourcesOf`/`sumResources`, so coverage and
 * estimated-vs-reported dollars show in every aggregate.
 */
import type {
  AttemptCause,
  ExecutionNode,
  JobContract,
  MeasurementSummary,
  RoutingDecision,
  Verification,
} from "@nightshift/contracts";
import { type ResourceTotals, resourcesOf, sumResources } from "./resources.js";

export type FinalOutcome =
  | "landed"
  | "merged_strand_not_landed"
  | "failed"
  | "cancelled"
  | "interrupted"
  | "verification_failed"
  | "examination_failed"
  | "unfinished";

export type FailureReason =
  | "examination_failed"
  | "examination_upheld"
  | "integration_conflict"
  | "route_unavailable"
  | "other";

export interface FirstAttemptFigures {
  /** Job nodes that landed with exactly one work attempt. */
  readonly succeeded: number;
  /** Settled job nodes. */
  readonly denominator: number;
  /** Not settled: reported beside the denominator, never in it. */
  readonly unfinished: number;
  /** Undefined when the denominator is 0. */
  readonly rate?: number;
}

export interface FirstAttemptReport extends FirstAttemptFigures {
  readonly excludingRepairs: FirstAttemptFigures;
  readonly coverage: "complete" | "partial";
  readonly reasons: readonly string[];
}

export interface ReworkRow {
  /** An `AttemptCause` kind, or `gate_repair:red_base` / `gate_repair:flaky`. */
  readonly kind: string;
  readonly attempts: number;
  readonly resources: ResourceTotals;
  /** Attempts in this row that also sit in another row. */
  readonly sharedAttempts: number;
}

export interface ReworkReport {
  /** Each rework attempt once, however many rows it appears in. */
  readonly attempts: number;
  readonly byCause: readonly ReworkRow[];
  readonly unknownCause: { readonly attempts: number; readonly resources: ResourceTotals };
  readonly resources: { readonly firstAttempts: ResourceTotals; readonly rework: ResourceTotals };
}

export interface DeliveryReport {
  readonly workItems: number;
  readonly repairJobs: number;
  readonly strands: number;
  readonly attempts: number;
  readonly helperCalls: number;
  readonly firstAttempt: FirstAttemptReport;
  readonly outcomes: {
    readonly counts: Record<FinalOutcome, number>;
    readonly failedBy: Record<FailureReason, number>;
  };
  readonly rework: ReworkReport;
}

export interface DeliveryInput {
  readonly nodes: readonly ExecutionNode[];
  readonly jobs: readonly JobContract[];
  readonly routes: readonly RoutingDecision[];
  readonly verifications: readonly Verification[];
  readonly measurements: readonly MeasurementSummary[];
}

export const workItemsOf = (nodes: readonly ExecutionNode[]): ExecutionNode[] =>
  nodes.filter((node) => node.kind === "job");

/** Work attempts of one node: its routing decisions with no purpose, by attempt. */
export const attemptsOfNode = (routes: readonly RoutingDecision[]): RoutingDecision[] =>
  routes.filter((route) => route.purpose === undefined).sort((a, b) => a.attempt - b.attempt);

const STRAND_NOT_LANDED = new Set([
  "failed",
  "cancelled",
  "verification_failed",
  "examination_failed",
]);

const strandOf = (
  node: ExecutionNode,
  nodes: readonly ExecutionNode[],
): ExecutionNode | undefined => {
  const byId = new Map(nodes.map((n) => [n.executionNodeId, n]));
  const seen = new Set<string>();
  let parentId = node.parentNodeId;
  while (parentId !== null && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = byId.get(parentId);
    if (parent === undefined) return undefined;
    if (parent.kind === "sub-program") return parent;
    parentId = parent.parentNodeId;
  }
  return undefined;
};

export const finalOutcomeOf = (
  node: ExecutionNode,
  nodes: readonly ExecutionNode[],
): FinalOutcome => {
  switch (node.status) {
    case "integrated":
      return "landed";
    case "merged": {
      const strand = strandOf(node, nodes);
      if (strand === undefined) return "unfinished";
      if (strand.status === "integrated") return "landed";
      return STRAND_NOT_LANDED.has(strand.status) ? "merged_strand_not_landed" : "unfinished";
    }
    case "failed":
    case "cancelled":
    case "interrupted":
    case "verification_failed":
    case "examination_failed":
      return node.status;
    default:
      return "unfinished";
  }
};

const failureReasonOf = (reason: string | undefined): FailureReason => {
  const prefixes: readonly FailureReason[] = [
    "examination_failed",
    "examination_upheld",
    "integration_conflict",
    "route_unavailable",
  ];
  return prefixes.find((prefix) => reason?.startsWith(prefix)) ?? "other";
};

const figures = (
  succeeded: number,
  denominator: number,
  unfinished: number,
): FirstAttemptFigures => ({
  succeeded,
  denominator,
  unfinished,
  ...(denominator === 0 ? {} : { rate: succeeded / denominator }),
});

const OUTCOMES: readonly FinalOutcome[] = [
  "landed",
  "merged_strand_not_landed",
  "failed",
  "cancelled",
  "interrupted",
  "verification_failed",
  "examination_failed",
  "unfinished",
];

const causeKinds = (causes: readonly AttemptCause[] | undefined): string[] => [
  ...new Set((causes ?? []).map((cause) => cause.kind)),
];

export const deliveryOf = (input: DeliveryInput): DeliveryReport => {
  const { nodes, jobs, routes, measurements } = input;
  const jobById = new Map(jobs.map((job) => [job.jobContractId, job]));
  const items = workItemsOf(nodes);
  const routesByNode = new Map<string, RoutingDecision[]>();
  for (const route of routes) {
    const list = routesByNode.get(route.executionNodeId) ?? [];
    list.push(route);
    routesByNode.set(route.executionNodeId, list);
  }

  const counts = Object.fromEntries(OUTCOMES.map((outcome) => [outcome, 0])) as Record<
    FinalOutcome,
    number
  >;
  const failedBy: Record<FailureReason, number> = {
    examination_failed: 0,
    examination_upheld: 0,
    integration_conflict: 0,
    route_unavailable: 0,
    other: 0,
  };
  let all = { succeeded: 0, denominator: 0, unfinished: 0 };
  let nonRepair = { succeeded: 0, denominator: 0, unfinished: 0 };
  let repairJobs = 0;
  let legacySettled = 0;
  const workAttempts: RoutingDecision[] = [];
  const firstAttempts: RoutingDecision[] = [];
  const reworkAttempts: RoutingDecision[] = [];
  const rows = new Map<string, RoutingDecision[]>();
  const unknown: RoutingDecision[] = [];
  const rowsOfAttempt = new Map<string, Set<string>>();
  const addToRow = (kind: string, attempt: RoutingDecision): void => {
    rows.set(kind, [...(rows.get(kind) ?? []), attempt]);
    const kinds = rowsOfAttempt.get(attempt.routingDecisionId) ?? new Set<string>();
    kinds.add(kind);
    rowsOfAttempt.set(attempt.routingDecisionId, kinds);
  };

  for (const node of items) {
    const contract = node.jobContractId === null ? undefined : jobById.get(node.jobContractId);
    const repair = contract?.repair;
    if (repair !== undefined) repairJobs += 1;
    const nodeRoutes = routesByNode.get(node.executionNodeId) ?? [];
    const attempts = attemptsOfNode(nodeRoutes);
    workAttempts.push(...attempts);
    const outcome = finalOutcomeOf(node, nodes);
    counts[outcome] += 1;
    if (node.status === "failed") failedBy[failureReasonOf(node.outcomeReason)] += 1;

    const settled = outcome !== "unfinished";
    const succeeded = outcome === "landed" && attempts.length === 1 ? 1 : 0;
    const bump = (f: typeof all) => ({
      succeeded: f.succeeded + succeeded,
      denominator: f.denominator + (settled ? 1 : 0),
      unfinished: f.unfinished + (settled ? 0 : 1),
    });
    all = bump(all);
    if (repair === undefined) nonRepair = bump(nonRepair);
    if (settled && nodeRoutes.length === 0) legacySettled += 1;

    if (repair !== undefined) {
      for (const attempt of attempts) {
        reworkAttempts.push(attempt);
        addToRow(`gate_repair:${repair.cause}`, attempt);
      }
      continue;
    }
    const [first, ...later] = attempts;
    if (first !== undefined) firstAttempts.push(first);
    for (const attempt of later) {
      reworkAttempts.push(attempt);
      const kinds = causeKinds(attempt.causes);
      if (kinds.length === 0) unknown.push(attempt);
      for (const kind of kinds) addToRow(kind, attempt);
    }
  }

  const sum = (attempts: readonly RoutingDecision[]): ResourceTotals =>
    sumResources(attempts.map((attempt) => resourcesOf(attempt, measurements)));

  const reasons: string[] = [];
  if (legacySettled > 0) {
    reasons.push(`${legacySettled} settled job node(s) have no routing decision (legacy)`);
  }
  if (sum(workAttempts).tokenCoverage === "partial") {
    reasons.push("token coverage of the work attempts is partial");
  }

  const byCause = [...rows.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(
      ([kind, attempts]): ReworkRow => ({
        kind,
        attempts: attempts.length,
        resources: sum(attempts),
        sharedAttempts: attempts.filter(
          (attempt) => (rowsOfAttempt.get(attempt.routingDecisionId)?.size ?? 0) > 1,
        ).length,
      }),
    );

  return {
    workItems: items.length,
    repairJobs,
    strands: nodes.filter((node) => node.kind === "sub-program").length,
    attempts: workAttempts.length,
    helperCalls: routes.filter((route) => route.purpose !== undefined).length,
    firstAttempt: {
      ...figures(all.succeeded, all.denominator, all.unfinished),
      excludingRepairs: figures(nonRepair.succeeded, nonRepair.denominator, nonRepair.unfinished),
      coverage: reasons.length === 0 ? "complete" : "partial",
      reasons,
    },
    outcomes: { counts, failedBy },
    rework: {
      attempts: reworkAttempts.length,
      byCause,
      unknownCause: { attempts: unknown.length, resources: sum(unknown) },
      resources: { firstAttempts: sum(firstAttempts), rework: sum(reworkAttempts) },
    },
  };
};
