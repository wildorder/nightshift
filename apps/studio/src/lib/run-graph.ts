/**
 * The run graph's model (P13, D-P13-10): nodes, edges, markers, and a decision's
 * recorded reach. Pure over the records, so it is tested without a canvas.
 *
 * A decision's reach is two sets, never one, and never a cone (A-47; the
 * owner's P9 direction):
 *
 * - **produced**: the nodes that landed a commit the decision records it
 *   produced. Recorded fact.
 * - **built after**: the nodes beneath the decision's node, and the nodes of
 *   strands that depend, directly or not, on its strand. Work that came after
 *   it and on top of it; it may or may not rest on the choice, and the graph
 *   does not claim to know.
 */
import type { Decision, ExecutionNode, JobContract } from "@nightshift/contracts";
import type { RunReport } from "@nightshift/core";

export type GraphNodeKind = "program" | "strand" | "job";

export interface GraphMarkers {
  readonly decisions: number;
  readonly needsYou: boolean;
  /** Attempts beyond the first. */
  readonly retried: number;
  readonly examined: boolean;
  /** A blocking finding stands. */
  readonly finding: boolean;
  /** The commit it landed, when it did. */
  readonly landed?: string;
}

export interface GraphNode {
  readonly id: string;
  readonly kind: GraphNodeKind;
  readonly label: string;
  readonly status: string;
  readonly strandId?: string;
  readonly markers: GraphMarkers;
}

export interface GraphEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  /** `tree`: parent to child. `depends`: a strand to one that depends on it. */
  readonly kind: "tree" | "depends";
}

export interface RunGraphModel {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
}

const firstLine = (text: string): string =>
  (text.split("\n").find((line) => line.trim() !== "") ?? "").replace(/^#+\s*/, "").slice(0, 80);

const NEEDS_YOU: ReadonlySet<string> = new Set([
  "deferred",
  "verification_failed",
  "examination_failed",
  "failed",
]);

export const buildRunGraph = (
  nodes: readonly ExecutionNode[],
  jobs: readonly JobContract[],
  report: RunReport | undefined,
): RunGraphModel => {
  const jobOf = new Map(jobs.map((job) => [job.jobContractId as string, job]));
  const jobReports = new Map(
    (report?.strands ?? []).flatMap((strand) =>
      strand.jobs.map((job) => [job.nodeId, job] as const),
    ),
  );
  const decisionsOn = new Map<string, number>();
  for (const entry of report?.graph ?? []) {
    const id = entry.decision.executionNodeId;
    decisionsOn.set(id, (decisionsOn.get(id) ?? 0) + 1);
  }

  const graphNodes: GraphNode[] = nodes.map((node) => {
    const job = node.jobContractId === null ? undefined : jobOf.get(node.jobContractId);
    const strandId = job?.strandId;
    const kind: GraphNodeKind =
      node.parentNodeId === null ? "program" : strandId !== undefined ? "strand" : "job";
    const jobReport = jobReports.get(node.executionNodeId);
    const examinations = jobReport?.examinations ?? [];
    const latest = examinations.at(-1);
    const strand =
      strandId === undefined ? undefined : report?.program.strands?.find((s) => s.id === strandId);
    const label =
      kind === "program"
        ? (report?.program.objective ?? "Program")
        : kind === "strand"
          ? `${strandId} ${strand?.name ?? ""}`.trim()
          : firstLine(job?.objective ?? "") || "Job";
    return {
      id: node.executionNodeId,
      kind,
      label,
      status: node.status,
      ...(strandId === undefined ? {} : { strandId }),
      markers: {
        decisions: decisionsOn.get(node.executionNodeId) ?? 0,
        needsYou: NEEDS_YOU.has(node.status),
        retried: Math.max(0, (jobReport?.attempts ?? 1) - 1),
        examined: examinations.length > 0,
        finding:
          latest !== undefined &&
          latest.blocking &&
          latest.findings.some(
            (f) =>
              f.severity === "material" &&
              (f.resolution === "unresolved" || f.resolution === "disputed"),
          ),
        ...(node.commitSha === null ? {} : { landed: node.commitSha }),
      },
    };
  });

  const edges: GraphEdge[] = nodes
    .filter((node) => node.parentNodeId !== null)
    .map((node) => ({
      id: `tree:${node.parentNodeId}->${node.executionNodeId}`,
      source: node.parentNodeId as string,
      target: node.executionNodeId,
      kind: "tree" as const,
    }));

  // A strand's latest node, for the dependency edges between strands.
  const latestOfStrand = new Map<string, string>();
  for (const node of [...nodes].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    const strandId =
      node.jobContractId === null ? undefined : jobOf.get(node.jobContractId)?.strandId;
    if (strandId !== undefined) latestOfStrand.set(strandId, node.executionNodeId);
  }
  for (const strand of report?.program.strands ?? []) {
    const target = latestOfStrand.get(strand.id);
    for (const dependency of strand.dependsOn) {
      const source = latestOfStrand.get(dependency);
      if (source !== undefined && target !== undefined) {
        edges.push({ id: `depends:${source}->${target}`, source, target, kind: "depends" });
      }
    }
  }
  return { nodes: graphNodes, edges };
};

export interface DecisionReach {
  readonly produced: ReadonlySet<string>;
  readonly builtAfter: ReadonlySet<string>;
}

/** What a decision produced, and what was built after it on top of it. Never "caused". */
export const reachOf = (
  decision: Decision,
  nodes: readonly ExecutionNode[],
  jobs: readonly JobContract[],
  report: RunReport | undefined,
): DecisionReach => {
  const commits = new Set(decision.produced?.commits ?? []);
  const produced = new Set(
    nodes
      .filter((node) => node.commitSha !== null && commits.has(node.commitSha))
      .map((n) => n.executionNodeId as string),
  );

  const children = new Map<string, string[]>();
  for (const node of nodes) {
    if (node.parentNodeId === null) continue;
    children.set(node.parentNodeId, [
      ...(children.get(node.parentNodeId) ?? []),
      node.executionNodeId,
    ]);
  }
  const descendants = (id: string): string[] => {
    const out: string[] = [];
    const stack = [...(children.get(id) ?? [])];
    while (stack.length > 0) {
      const next = stack.pop() as string;
      out.push(next);
      stack.push(...(children.get(next) ?? []));
    }
    return out;
  };

  const builtAfter = new Set(descendants(decision.executionNodeId));

  // The strands that depend, transitively, on the decision's strand.
  const jobOf = new Map(jobs.map((job) => [job.jobContractId as string, job]));
  const strandOfNode = (id: string): string | undefined => {
    let current = nodes.find((n) => n.executionNodeId === id);
    while (current !== undefined) {
      const strandId =
        current.jobContractId === null ? undefined : jobOf.get(current.jobContractId)?.strandId;
      if (strandId !== undefined) return strandId;
      current =
        current.parentNodeId === null
          ? undefined
          : nodes.find((n) => n.executionNodeId === current?.parentNodeId);
    }
    return undefined;
  };
  const origin = strandOfNode(decision.executionNodeId);
  if (origin !== undefined) {
    const strands = report?.program.strands ?? [];
    const dependents = new Set<string>();
    let frontier = [origin];
    while (frontier.length > 0) {
      const next = strands.filter(
        (s) => s.dependsOn.some((d) => frontier.includes(d)) && !dependents.has(s.id),
      );
      for (const s of next) dependents.add(s.id);
      frontier = next.map((s) => s.id);
    }
    for (const node of nodes) {
      const strandId =
        node.jobContractId === null ? undefined : jobOf.get(node.jobContractId)?.strandId;
      if (strandId !== undefined && dependents.has(strandId)) {
        builtAfter.add(node.executionNodeId);
        for (const d of descendants(node.executionNodeId)) builtAfter.add(d);
      }
    }
  }
  for (const id of produced) builtAfter.delete(id);
  builtAfter.delete(decision.executionNodeId);
  return { produced, builtAfter };
};
