/**
 * What review contributed and what it cost (P20, S-05). Pure: nodes, job
 * contracts, routing decisions, examinations, decisions and measurement
 * summaries in, a report out.
 *
 * A unique finding is one defect as the examiners raised it, across the
 * examinations of one node: a finding that `repeats` an earlier one is a later
 * occurrence of it, and a ruling-check finding that `concerns` a ruled finding
 * joins that finding's chain. Dispositions describe what happened to a finding,
 * not whether it was right: `fixed` means it was not raised again and `upheld`
 * means the arbiter agreed. Nothing here is an accuracy, precision or
 * defect-free figure. Examiner, answerer, arbiter and plan-review calls are
 * overhead; repairs are implementation attempts and are reported apart from it.
 * Every token and dollar figure comes from `resourcesOf`/`sumResources`.
 */
import type {
  Agent,
  Decision,
  Event,
  Examination,
  ExaminationFinding,
  ExaminationOutcome,
  ExecutionNode,
  FindingResolution,
  FindingSeverity,
  JobContract,
  MeasurementSummary,
  RoutingDecision,
} from "@nightshift/contracts";
import { workItemsOf } from "./delivery.js";
import { type ResourceTotals, resourcesOf, sumResources } from "./resources.js";

export type RulingDisposition = "upheld" | "overturned" | "risk_accepted";

export interface FindingOccurrence {
  readonly examinationId: string;
  readonly findingId: string;
  readonly resolution: FindingResolution;
  readonly resolvedBy?: ExaminationFinding["resolvedBy"];
}

export interface FindingRuling {
  readonly disposition: RulingDisposition;
  readonly examinationId: string;
  readonly findingId: string;
  readonly decisionId?: string;
  /** The arbiter's (or human's) agent, from the Decision; absent when none was recorded. */
  readonly agentId?: string;
}

export type FindingLinkage = "linked" | "unresolved" | "unknown";

export interface UniqueFinding {
  readonly nodeId: string;
  /** Oldest first. */
  readonly occurrences: readonly FindingOccurrence[];
  readonly severity: FindingSeverity;
  readonly latest: FindingResolution;
  readonly open: boolean;
  readonly rulings: readonly FindingRuling[];
  /** A ruling exists and a later occurrence is open. */
  readonly repeatedAfterRuling: boolean;
  readonly fixedBy?: string;
  /** Work attempts (routing decision ids) whose causes name this finding. */
  readonly repairAttempts: readonly string[];
  readonly linkage: FindingLinkage;
}

export interface OverheadRow {
  readonly calls: number;
  readonly resources: ResourceTotals;
}

export interface ReviewReport {
  readonly coverage: {
    readonly examinedNodes: number;
    readonly examinedByStrand: number;
    readonly landedUnexamined: number;
    readonly skipped: number;
    readonly examinations: {
      readonly total: number;
      readonly byOutcome: Record<ExaminationOutcome, number>;
    };
  };
  readonly findings: readonly UniqueFinding[];
  readonly dispositions: {
    readonly unique: number;
    readonly byLatest: Record<FindingResolution, number>;
    readonly rulings: Record<RulingDisposition, number>;
    readonly note: string;
  };
  readonly overhead: {
    readonly examiner: OverheadRow;
    readonly answerer: OverheadRow;
    readonly arbiter: OverheadRow;
    readonly planReview: OverheadRow;
  };
  /** Implementation attempts caused by review. Never added to `overhead`. */
  readonly repairs: { readonly attempts: number; readonly resources: ResourceTotals };
  readonly linkage: {
    readonly findings: Record<FindingLinkage, number>;
    readonly helpersUnlinked: number;
    readonly repairsWithoutFindings: number;
  };
}

export interface ReviewInput {
  readonly nodes: readonly ExecutionNode[];
  readonly jobs: readonly JobContract[];
  readonly routes: readonly RoutingDecision[];
  readonly examinations: readonly Examination[];
  readonly decisions: readonly Decision[];
  readonly agents: readonly Agent[];
  readonly measurements: readonly MeasurementSummary[];
  readonly events: readonly Event[];
}

export const DISPOSITION_NOTE =
  "fixed means the finding was not raised again; upheld means the arbiter agreed. " +
  "Neither is independently established truth.";

const keyOf = (examinationId: string, findingId: string): string =>
  `${examinationId}\u0000${findingId}`;

const RULINGS: readonly RulingDisposition[] = ["upheld", "overturned", "risk_accepted"];
const RESOLUTIONS: readonly FindingResolution[] = [
  "unresolved",
  "fixed",
  "disputed",
  "overturned",
  "upheld",
  "risk_accepted",
];

const isRuling = (resolution: FindingResolution): resolution is RulingDisposition =>
  (RULINGS as readonly string[]).includes(resolution);

const emptyCounts = <K extends string>(keys: readonly K[]): Record<K, number> =>
  Object.fromEntries(keys.map((key) => [key, 0])) as Record<K, number>;

interface Entry {
  readonly examination: Examination;
  readonly finding: ExaminationFinding;
  readonly order: number;
}

const strandOf = (
  node: ExecutionNode,
  byId: ReadonlyMap<string, ExecutionNode>,
): ExecutionNode | undefined => {
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

const buildChains = (examinations: readonly Examination[]): Map<string, Entry[]> => {
  const entries = new Map<string, Entry>();
  const parent = new Map<string, string>();
  const find = (key: string): string => {
    let root = key;
    while (parent.get(root) !== root) root = parent.get(root) as string;
    return root;
  };
  const union = (a: string, b: string): void => {
    if (!entries.has(a) || !entries.has(b)) return;
    parent.set(find(a), find(b));
  };
  examinations.forEach((examination, index) => {
    for (const finding of examination.findings) {
      const key = keyOf(examination.examinationId, finding.id);
      entries.set(key, { examination, finding, order: index });
      parent.set(key, key);
    }
  });
  const sameNode = (a: Examination, b: Examination) => a.executionNodeId === b.executionNodeId;
  for (const [key, entry] of entries) {
    const { examination, finding } = entry;
    if (finding.repeats !== undefined) {
      const target = keyOf(finding.repeats.examinationId, finding.repeats.findingId);
      const found = entries.get(target);
      if (found !== undefined && sameNode(found.examination, examination)) union(key, target);
    }
    const ruled = examination.followsRulings?.find((r) => r.findingId === finding.concerns);
    if (ruled !== undefined) {
      const candidates = [...entries.values()].filter(
        (other) =>
          other.finding.id === ruled.findingId &&
          sameNode(other.examination, examination) &&
          other.examination.examinationId !== examination.examinationId,
      );
      const exact = candidates.find(
        (other) => other.finding.resolvedBy?.decisionId === ruled.decisionId,
      );
      const target =
        exact ??
        candidates
          .filter((other) => other.examination.createdAt <= examination.createdAt)
          .sort((a, b) => b.order - a.order)[0];
      if (target !== undefined) {
        union(key, keyOf(target.examination.examinationId, target.finding.id));
      }
    }
  }
  const chains = new Map<string, Entry[]>();
  for (const [key, entry] of entries) {
    const root = find(key);
    chains.set(root, [...(chains.get(root) ?? []), entry]);
  }
  for (const chain of chains.values()) {
    chain.sort((a, b) =>
      a.examination.createdAt < b.examination.createdAt
        ? -1
        : a.examination.createdAt > b.examination.createdAt
          ? 1
          : a.order - b.order,
    );
  }
  return chains;
};

const namesFinding = (route: RoutingDecision, occurrences: readonly FindingOccurrence[]): boolean =>
  (route.causes ?? []).some(
    (cause) =>
      cause.examinationId !== undefined &&
      occurrences.some(
        (occurrence) =>
          occurrence.examinationId === cause.examinationId &&
          (cause.findingIds === undefined ||
            cause.findingIds.length === 0 ||
            cause.findingIds.includes(occurrence.findingId)),
      ),
  );

const uniqueFindingsOf = (
  examinations: readonly Examination[],
  routes: readonly RoutingDecision[],
  decisions: readonly Decision[],
): UniqueFinding[] => {
  const decisionById = new Map(decisions.map((d) => [d.decisionId as string, d]));
  const workByNode = new Map<string, RoutingDecision[]>();
  for (const route of routes.filter((r) => r.purpose === undefined)) {
    const list = workByNode.get(route.executionNodeId) ?? [];
    list.push(route);
    workByNode.set(route.executionNodeId, list);
  }
  const result: UniqueFinding[] = [];
  for (const chain of buildChains(examinations).values()) {
    const first = chain[0] as Entry;
    const nodeId = first.examination.executionNodeId as string;
    const occurrences: FindingOccurrence[] = chain.map(({ examination, finding }) => ({
      examinationId: examination.examinationId,
      findingId: finding.id,
      resolution: finding.resolution,
      ...(finding.resolvedBy === undefined ? {} : { resolvedBy: finding.resolvedBy }),
    }));
    const last = occurrences[occurrences.length - 1] as FindingOccurrence;
    const open = last.resolution === "unresolved" || last.resolution === "disputed";
    const rulings: FindingRuling[] = [];
    let lastRulingIndex = -1;
    occurrences.forEach((occurrence, index) => {
      if (!isRuling(occurrence.resolution)) return;
      const decisionId = occurrence.resolvedBy?.decisionId;
      const agentId = decisionId === undefined ? null : decisionById.get(decisionId)?.agentId;
      rulings.push({
        disposition: occurrence.resolution,
        examinationId: occurrence.examinationId,
        findingId: occurrence.findingId,
        ...(decisionId === undefined ? {} : { decisionId }),
        ...(agentId === null || agentId === undefined ? {} : { agentId }),
      });
      lastRulingIndex = index;
    });
    const fixedBy = [...occurrences]
      .reverse()
      .find((o) => o.resolution === "fixed" && o.resolvedBy?.examinationId !== undefined)
      ?.resolvedBy?.examinationId;
    const repairAttempts = (workByNode.get(nodeId) ?? [])
      .filter((route) => namesFinding(route, occurrences))
      .sort((a, b) => a.attempt - b.attempt)
      .map((route) => route.routingDecisionId as string);
    const severity: FindingSeverity = chain.some((e) => e.finding.severity === "material")
      ? "material"
      : "minor";
    const linkage: FindingLinkage =
      repairAttempts.length > 0 || rulings.length > 0 ? "linked" : open ? "unresolved" : "unknown";
    result.push({
      nodeId,
      occurrences,
      severity,
      latest: last.resolution,
      open,
      rulings,
      repeatedAfterRuling: open && lastRulingIndex >= 0 && lastRulingIndex < occurrences.length - 1,
      ...(fixedBy === undefined ? {} : { fixedBy }),
      repairAttempts,
      linkage,
    });
  }
  return result;
};

export const reviewOf = (input: ReviewInput): ReviewReport => {
  const { nodes, routes, examinations, decisions, measurements, events } = input;
  const byId = new Map(nodes.map((n) => [n.executionNodeId as string, n]));
  const examinedNodeIds = new Set(examinations.map((e) => e.executionNodeId as string));

  let examinedByStrand = 0;
  let landedUnexamined = 0;
  for (const node of workItemsOf(nodes)) {
    const examined = examinedNodeIds.has(node.executionNodeId);
    if (node.status === "integrated" && !examined) landedUnexamined += 1;
    if (node.status === "merged") {
      const strand = strandOf(node, byId);
      if (strand === undefined) continue;
      if (examinedNodeIds.has(strand.executionNodeId)) examinedByStrand += 1;
      else if (strand.status === "integrated") landedUnexamined += 1;
    }
  }

  const skipped = new Set<string>();
  for (const event of events) {
    if (event.type === "examination.skipped" && event.executionNodeId !== null) {
      skipped.add(event.executionNodeId);
    }
  }

  const byOutcome = emptyCounts<ExaminationOutcome>(["passed", "findings_raised", "failed"]);
  for (const examination of examinations) byOutcome[examination.outcome] += 1;

  const findings = uniqueFindingsOf(examinations, routes, decisions);
  const byLatest = emptyCounts(RESOLUTIONS);
  const rulingCounts = emptyCounts(RULINGS);
  const linkageCounts = emptyCounts<FindingLinkage>(["linked", "unresolved", "unknown"]);
  for (const finding of findings) {
    byLatest[finding.latest] += 1;
    linkageCounts[finding.linkage] += 1;
    for (const ruling of finding.rulings) rulingCounts[ruling.disposition] += 1;
  }

  const sum = (rs: readonly RoutingDecision[]): ResourceTotals =>
    sumResources(rs.map((route) => resourcesOf(route, measurements)));
  const row = (rs: readonly RoutingDecision[]): OverheadRow => ({
    calls: rs.length,
    resources: sum(rs),
  });
  const helpers = routes.filter((route) => route.purpose !== undefined);
  const isPlanReview = (route: RoutingDecision) => route.concerning?.kind === "plan_review";
  const attempts = routes.filter((route) => route.purpose === undefined);
  const repairs = attempts.filter((route) =>
    (route.causes ?? []).some((c) => c.kind === "examination_findings" || c.kind === "ruling"),
  );

  return {
    coverage: {
      examinedNodes: examinedNodeIds.size,
      examinedByStrand,
      landedUnexamined,
      skipped: skipped.size,
      examinations: { total: examinations.length, byOutcome },
    },
    findings,
    dispositions: {
      unique: findings.length,
      byLatest,
      rulings: rulingCounts,
      note: DISPOSITION_NOTE,
    },
    overhead: {
      examiner: row(helpers.filter((r) => r.purpose === "examine" && !isPlanReview(r))),
      answerer: row(helpers.filter((r) => r.purpose === "answer")),
      arbiter: row(helpers.filter((r) => r.purpose === "arbitrate")),
      planReview: row(helpers.filter((r) => r.purpose === "examine" && isPlanReview(r))),
    },
    repairs: { attempts: repairs.length, resources: sum(repairs) },
    linkage: {
      findings: linkageCounts,
      helpersUnlinked: helpers.filter((r) => r.concerning === undefined).length,
      repairsWithoutFindings: repairs.filter((route) =>
        (route.causes ?? []).some(
          (c) =>
            c.kind === "examination_findings" &&
            (c.findingIds === undefined || c.findingIds.length === 0),
        ),
      ).length,
    },
  };
};
