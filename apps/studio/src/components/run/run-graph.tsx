/**
 * The run graph (P13, D-P13-10, D-P13-11): the run as a horizontal tree you can
 * trace. The program, then its strands in dependency order, then their jobs;
 * each node carries its status and markers. Choose a decision and two sets
 * light up, distinctly: what it produced, and what was built after it. Select a
 * node and its detail opens under the graph.
 *
 * Laid out left to right by dagre; drawn by React Flow, with nodes that are
 * ordinary components on the theme's tokens (React Flow's own colours are
 * mapped to tokens in `theme.css`).
 */
import dagre from "@dagrejs/dagre";
import type { Decision, ExecutionNode, JobContract } from "@nightshift/contracts";
import type { RunReport, RunScope } from "@nightshift/core";
import {
  Background,
  Controls,
  type Edge,
  Handle,
  MarkerType,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
} from "@xyflow/react";
import { AlertTriangle, GitCommitHorizontal, GitFork, RotateCw, ShieldCheck } from "lucide-react";
import { useMemo, useState } from "react";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { shortSha } from "../../lib/format.js";
import { buildRunGraph, type DecisionReach, type GraphNode, reachOf } from "../../lib/run-graph.js";
import { StatusBadge } from "../status-badge.js";
import { NodeDetail } from "./node-detail.js";

const WIDTH = 240;
const HEIGHT = 112;

type Highlight = "produced" | "after" | "origin" | undefined;

interface RunNodeData extends Record<string, unknown> {
  readonly node: GraphNode;
  readonly highlight: Highlight;
  readonly selected: boolean;
  readonly onDecision: (nodeId: string) => void;
}

const HIGHLIGHT_CLASS: Readonly<Record<NonNullable<Highlight>, string>> = {
  origin: "ring-2 ring-primary",
  produced: "ring-2 ring-status-success-foreground",
  after: "outline-2 outline-dashed outline-offset-2 outline-status-info-foreground",
};

/** One node of the graph: its status, what it is, and its markers. */
export const RunGraphNode = ({ data }: NodeProps<Node<RunNodeData>>) => {
  const { node, highlight, selected, onDecision } = data;
  const m = node.markers;
  return (
    <div
      data-graph-node={node.id}
      data-highlight={highlight ?? "none"}
      className={`flex h-full flex-col justify-between gap-1 rounded-lg border bg-card p-3 text-card-foreground shadow-xs ${
        selected ? "border-primary" : ""
      } ${highlight === undefined ? "" : HIGHLIGHT_CLASS[highlight]}`}
    >
      <Handle type="target" position={Position.Left} className="opacity-0" />
      <div className="flex min-w-0 items-center gap-2">
        <StatusBadge status={node.status} />
        <span className="truncate text-xs text-muted-foreground">{node.kind}</span>
      </div>
      <p className="line-clamp-2 text-sm leading-snug font-medium" title={node.label}>
        {node.label}
      </p>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        {m.decisions > 0 ? (
          <button
            type="button"
            className="nodrag inline-flex items-center gap-0.5 rounded px-1 hover:bg-accent hover:text-accent-foreground"
            aria-label={`${m.decisions} decision${m.decisions === 1 ? "" : "s"}`}
            onClick={(event) => {
              event.stopPropagation();
              onDecision(node.id);
            }}
          >
            <GitFork className="size-3.5" /> {m.decisions}
          </button>
        ) : null}
        {m.needsYou ? (
          <span
            className="inline-flex items-center text-status-warning-foreground"
            title="Needs you"
          >
            <AlertTriangle className="size-3.5" />
          </span>
        ) : null}
        {m.retried > 0 ? (
          <span className="inline-flex items-center gap-0.5" title={`Retried ${m.retried}×`}>
            <RotateCw className="size-3.5" /> {m.retried}
          </span>
        ) : null}
        {m.examined ? (
          <span
            className={`inline-flex items-center ${m.finding ? "text-status-danger-foreground" : ""}`}
            title={m.finding ? "A blocking finding stands" : "Examined by a second model"}
          >
            <ShieldCheck className="size-3.5" />
          </span>
        ) : null}
        {m.landed === undefined ? null : (
          <span className="ml-auto inline-flex items-center gap-0.5 font-mono" title="Landed">
            <GitCommitHorizontal className="size-3.5" /> {shortSha(m.landed)}
          </span>
        )}
      </div>
      <Handle type="source" position={Position.Right} className="opacity-0" />
    </div>
  );
};

const nodeTypes = { run: RunGraphNode };

/** Positions, left to right, from dagre. Pure given the model. */
export const layoutOf = (
  graph: ReturnType<typeof buildRunGraph>,
): Map<string, { x: number; y: number }> => {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "LR", nodesep: 24, ranksep: 64, marginx: 16, marginy: 16 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const node of graph.nodes) g.setNode(node.id, { width: WIDTH, height: HEIGHT });
  for (const edge of graph.edges) g.setEdge(edge.source, edge.target);
  dagre.layout(g);
  return new Map(
    graph.nodes.map((node) => {
      const at = g.node(node.id) as { x: number; y: number } | undefined;
      return [node.id, { x: (at?.x ?? 0) - WIDTH / 2, y: (at?.y ?? 0) - HEIGHT / 2 }];
    }),
  );
};

const highlightOf = (
  id: string,
  decision: Decision | undefined,
  reach: DecisionReach | undefined,
): Highlight => {
  if (decision === undefined || reach === undefined) return undefined;
  if (id === decision.executionNodeId) return "origin";
  if (reach.produced.has(id)) return "produced";
  if (reach.builtAfter.has(id)) return "after";
  return undefined;
};

export const RunGraph = ({
  scope,
  nodes,
  jobs,
  report,
}: {
  readonly scope: RunScope;
  readonly nodes: readonly ExecutionNode[];
  readonly jobs: readonly JobContract[];
  readonly report: RunReport | undefined;
}) => {
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [decisionId, setDecisionId] = useState<string | undefined>(undefined);
  const graph = useMemo(() => buildRunGraph(nodes, jobs, report), [nodes, jobs, report]);
  const positions = useMemo(() => layoutOf(graph), [graph]);
  const decisions = report?.graph ?? [];
  const decision = decisions.find((d) => d.decision.decisionId === decisionId)?.decision;
  const reach = useMemo(
    () => (decision === undefined ? undefined : reachOf(decision, nodes, jobs, report)),
    [decision, nodes, jobs, report],
  );
  const onDecision = (nodeId: string) => {
    const first = decisions.find((d) => d.decision.executionNodeId === nodeId);
    setDecisionId(first?.decision.decisionId);
  };

  const flowNodes: Node<RunNodeData>[] = graph.nodes.map((node) => ({
    id: node.id,
    type: "run",
    position: positions.get(node.id) ?? { x: 0, y: 0 },
    width: WIDTH,
    height: HEIGHT,
    data: {
      node,
      highlight: highlightOf(node.id, decision, reach),
      selected: node.id === selected,
      onDecision,
    },
  }));
  const flowEdges: Edge[] = graph.edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    ...(edge.kind === "depends"
      ? {
          style: { strokeDasharray: "6 4" },
          markerEnd: { type: MarkerType.ArrowClosed },
          label: "depends on",
        }
      : {}),
  }));
  const node =
    selected === undefined ? undefined : nodes.find((n) => n.executionNodeId === selected);
  const job =
    node?.jobContractId == null
      ? undefined
      : jobs.find((j) => j.jobContractId === node.jobContractId);

  if (graph.nodes.length === 0)
    return <p className="text-sm text-muted-foreground">No nodes yet.</p>;

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted-foreground">Trace a decision:</span>
        {decisions.length === 0 ? (
          <span className="text-muted-foreground">none were recorded</span>
        ) : (
          decisions.map(({ decision: d }) => (
            <button
              key={d.decisionId}
              type="button"
              aria-pressed={d.decisionId === decisionId}
              onClick={() => setDecisionId(d.decisionId === decisionId ? undefined : d.decisionId)}
              className="rounded-md border px-2 py-0.5 text-xs hover:bg-accent aria-pressed:border-primary aria-pressed:bg-accent"
            >
              {d.choice}
            </button>
          ))
        )}
        {decision === undefined ? null : (
          <span
            className="ml-auto flex items-center gap-3 text-xs text-muted-foreground"
            data-testid="reach-legend"
          >
            <span className="inline-flex items-center gap-1">
              <span className="size-3 rounded-sm ring-2 ring-status-success-foreground" /> produced
              ({reach?.produced.size ?? 0})
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="size-3 rounded-sm outline-2 outline-dashed outline-status-info-foreground" />{" "}
              built after ({reach?.builtAfter.size ?? 0})
            </span>
          </span>
        )}
      </div>
      <ResizablePanelGroup orientation="vertical" className="min-h-[36rem] rounded-lg border">
        <ResizablePanel defaultSize="60%" minSize="25%">
          <div className="h-full min-h-72" data-testid="run-graph">
            <ReactFlow
              nodes={flowNodes}
              edges={flowEdges}
              nodeTypes={nodeTypes}
              fitView
              nodesDraggable={false}
              nodesConnectable={false}
              onNodeClick={(_event, clicked) => setSelected(clicked.id)}
              onPaneClick={() => setSelected(undefined)}
              proOptions={{ hideAttribution: true }}
            >
              <Background />
              <Controls showInteractive={false} />
            </ReactFlow>
          </div>
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel defaultSize="40%" minSize="15%">
          <div className="h-full overflow-y-auto p-4" data-testid="graph-detail">
            {node === undefined ? (
              <p className="text-sm text-muted-foreground">
                Select a node to see what it had to do and what was checked.
              </p>
            ) : (
              <NodeDetail node={node} job={job} report={report} scope={scope} />
            )}
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
};
