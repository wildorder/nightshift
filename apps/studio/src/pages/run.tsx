/**
 * The run page (P11, T4; tabs in P13, D-P13-06): what happened, from the
 * control plane alone. *Status* answers the question the page is opened for;
 * the rest is one tab deeper. The tab is in the URL, so a link opens where it
 * was; the run's status and the live indicator are on every tab.
 */
import type { Artifact, Checkpoint, ExecutionNode, Run } from "@nightshift/contracts";
import type { RunReport, RunScope } from "@nightshift/core";
import { useQuery } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { Radio } from "lucide-react";
import { lazy, Suspense, useState } from "react";
import { useSearchParams } from "react-router";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DataTable } from "../components/data-table.js";
import { Json } from "../components/json.js";
import { PageHeader } from "../components/page-header.js";
import { ProgramStatusSummary } from "../components/program-status.js";
import { NodeDetail } from "../components/run/node-detail.js";
import {
  ArtifactLink,
  DecisionRow,
  firstLine,
  JobCard,
  StrandCard,
  TreeNode,
  Usage,
  useRunScope,
} from "../components/run/parts.js";
import { StatusBadge } from "../components/status-badge.js";
import { between, shortId, shortSha, when } from "../lib/format.js";
import { useLiveEvents } from "../lib/live.js";
import { narrate } from "../lib/narrate.js";
import { readAll } from "../lib/read-all.js";
import { useRunStatus } from "../lib/run-status.js";
import { DEFAULT_POLL_MS, useStudio } from "../studio.js";

export { useRunScope } from "../components/run/parts.js";

/** The graph pulls in React Flow and dagre; only its tab needs them, so it loads on demand. */
const RunGraph = lazy(() =>
  import("../components/run/run-graph.js").then((module) => ({ default: module.RunGraph })),
);

export const RUN_TABS = ["status", "graph", "work", "timeline", "decisions", "artifacts"] as const;
export type RunTab = (typeof RUN_TABS)[number];

const Panel = ({
  title,
  children,
}: {
  readonly title: string;
  readonly children: React.ReactNode;
}) => (
  <Card>
    <CardHeader>
      <CardTitle>
        <h2>{title}</h2>
      </CardTitle>
    </CardHeader>
    <CardContent>{children}</CardContent>
  </Card>
);

const StatusTab = ({
  report,
  status,
}: {
  readonly report: RunReport;
  readonly status: Parameters<typeof ProgramStatusSummary>[0]["status"];
}) => (
  <div className="grid gap-4">
    <Panel title="Program status">
      <ProgramStatusSummary status={status} />
    </Panel>
    {report.rulings.length === 0 ? null : (
      <Panel title="Rulings">
        <ul className="grid gap-2 text-sm">
          {report.rulings.map((ruling) => (
            <li key={ruling.ruling.decisionId}>
              <span className="font-medium">{ruling.ruling.choice}</span> on {ruling.finding} (job{" "}
              {shortId(ruling.nodeId)})
              {ruling.arbiterModel === undefined ? "" : ` by ${ruling.arbiterModel}`}
              {ruling.sharesModelWith === undefined
                ? ""
                : `, sharing the ${ruling.sharesModelWith}'s model`}
              {ruling.reversedBy === undefined ? "" : ` — reversed: ${ruling.reversedBy.choice}`}
              <p className="text-muted-foreground">{ruling.ruling.rationale}</p>
            </li>
          ))}
        </ul>
      </Panel>
    )}
    {report.corrections.length === 0 ? null : (
      <Panel title="What this program corrects">
        <ul className="grid gap-1 text-sm">
          {report.corrections.map((c) => (
            <li key={c.target.decisionId}>
              <code className="font-mono">{c.target.decisionId}</code> in run{" "}
              <code className="font-mono">{shortId(c.target.runId)}</code> of{" "}
              <code className="font-mono">{c.target.programId}</code>:{" "}
              {c.decision?.context ?? "(not found)"} — chose {c.decision?.choice ?? "?"}; reversed:{" "}
              {c.reversal?.choice ?? "?"}
            </li>
          ))}
        </ul>
      </Panel>
    )}
    <Panel title="Success criteria">
      <ul className="grid gap-1 text-sm">
        {report.criteria.map((c) => (
          <li key={c.id} className="flex flex-wrap items-baseline gap-2">
            <StatusBadge status={c.met ? "met" : "not met"} />
            <span className="font-medium">{c.id}</span> {c.outcome}
            <span className="text-muted-foreground">— by {c.by.join(", ") || "nobody"}</span>
          </li>
        ))}
      </ul>
      {report.pendingPrerequisites.length === 0 ? null : (
        <p className="mt-2 text-sm text-status-warning-foreground">
          Pending prerequisites: {report.pendingPrerequisites.map((p) => p.id).join(", ")}
        </p>
      )}
    </Panel>
    <Panel title="Usage and cost">
      <Usage report={report} />
    </Panel>
  </div>
);

const artifactColumns: ColumnDef<Artifact, unknown>[] = [
  { id: "kind", header: "Kind", accessorFn: (a) => a.kind },
  {
    id: "node",
    header: "Node",
    accessorFn: (a) => shortId(a.executionNodeId),
    cell: ({ getValue }) => <span className="font-mono">{String(getValue())}</span>,
  },
  { id: "type", header: "Type", accessorFn: (a) => a.contentType, enableSorting: false },
  {
    id: "size",
    header: "Size",
    accessorFn: (a) => a.sizeBytes,
    cell: ({ row }) => `${row.original.sizeBytes} B`,
  },
  {
    id: "recorded",
    header: "Recorded",
    accessorFn: (a) => a.createdAt,
    cell: ({ row }) => when(row.original.createdAt),
  },
  {
    id: "open",
    header: "",
    enableSorting: false,
    cell: ({ row }) => <ArtifactLink artifactId={row.original.artifactId} label="open" />,
  },
];

export const RunPage = () => {
  const scope: RunScope = useRunScope();
  const { stores, pollMs } = useStudio();
  const [params, setParams] = useSearchParams();
  const tab: RunTab = RUN_TABS.includes(params.get("tab") as RunTab)
    ? (params.get("tab") as RunTab)
    : "status";
  const [openNode, setOpenNode] = useState<string | undefined>(undefined);

  const run = useQuery({
    queryKey: ["run", scope.runId],
    queryFn: () => stores.runs.get(scope, scope.runId),
  });
  const runStatus = useRunStatus(run.data === undefined ? undefined : scope);
  const nodes = useQuery({
    queryKey: ["nodes", scope.runId],
    queryFn: () => readAll((page) => stores.executionNodes.listByRun(scope, page)),
  });
  const jobs = useQuery({
    queryKey: ["jobs", scope.runId],
    queryFn: () => readAll((page) => stores.jobContracts.listByRun(scope, page)),
  });
  const checkpoints = useQuery({
    queryKey: ["checkpoints", scope.runId],
    queryFn: () => readAll((page) => stores.checkpoints.listByRun(scope, page)),
  });
  const artifacts = useQuery({
    queryKey: ["artifacts", scope.runId],
    queryFn: () => readAll((page) => stores.artifacts.listByRun(scope, page)),
  });
  const live = useLiveEvents(stores, scope, run.data?.status, pollMs ?? DEFAULT_POLL_MS);

  if (run.isPending) return <p className="text-muted-foreground">Loading run…</p>;
  if (run.isError) return <p role="alert">Could not read the run: {String(run.error)}</p>;
  if (run.data === undefined) return <p role="alert">No such run.</p>;
  const r: Run = run.data;
  const report = runStatus.data?.report;

  const byParent = new Map<string | null, ExecutionNode[]>();
  for (const node of nodes.data ?? []) {
    const siblings = byParent.get(node.parentNodeId) ?? [];
    siblings.push(node);
    byParent.set(node.parentNodeId, siblings);
  }
  const root = (byParent.get(null) ?? [])[0];
  const titles = new Map(
    (jobs.data ?? []).map((job) => [job.jobContractId as string, firstLine(job.objective)]),
  );
  const jobOf = new Map((jobs.data ?? []).map((job) => [job.jobContractId as string, job]));
  const nodeOf = new Map((nodes.data ?? []).map((node) => [node.executionNodeId as string, node]));
  const opened = openNode === undefined ? undefined : nodeOf.get(openNode);
  const setTab = (next: string) => {
    const copy = new URLSearchParams(params);
    copy.set("tab", next);
    setParams(copy, { replace: true });
  };

  return (
    <div className="grid gap-4">
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            Run <span className="font-mono">{shortId(r.runId)}</span>
            <StatusBadge status={r.status} />
            {live.polling ? (
              <span
                className="inline-flex items-center gap-1 text-xs font-normal text-status-info-foreground"
                data-testid="live"
              >
                <Radio className="size-3.5 animate-pulse" /> live · following the run
              </span>
            ) : null}
          </span>
        }
        description={
          <>
            <p>{report?.program.objective ?? scope.programId}</p>
            <p>
              {r.location} · started {when(r.startedAt)} · ended {when(r.endedAt)} · took{" "}
              {between(r.startedAt, r.endedAt)}
              {r.policy === undefined ? "" : ` · org config v${r.policy.orgConfigVersion}`}
            </p>
            {r.outcomeReason === undefined ? null : (
              <p className="text-status-danger-foreground">{r.outcomeReason}</p>
            )}
          </>
        }
      />
      {runStatus.isError ? (
        <p role="alert">Could not build the report: {String(runStatus.error)}</p>
      ) : null}

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="status">Status</TabsTrigger>
          <TabsTrigger value="graph">Graph</TabsTrigger>
          <TabsTrigger value="work">Work</TabsTrigger>
          <TabsTrigger value="timeline">Timeline</TabsTrigger>
          <TabsTrigger value="decisions">Decisions</TabsTrigger>
          <TabsTrigger value="artifacts">Artifacts</TabsTrigger>
        </TabsList>

        <TabsContent value="status" className="mt-4">
          {report === undefined || runStatus.data === undefined ? (
            <p className="text-muted-foreground">Building the report…</p>
          ) : (
            <StatusTab report={report} status={runStatus.data.status} />
          )}
        </TabsContent>

        <TabsContent value="graph" className="mt-4">
          <Suspense fallback={<p className="text-sm text-muted-foreground">Loading the graph…</p>}>
            <RunGraph
              scope={scope}
              nodes={nodes.data ?? []}
              jobs={jobs.data ?? []}
              report={report}
            />
          </Suspense>
        </TabsContent>

        <TabsContent value="work" className="mt-4 grid gap-4">
          {report === undefined ? null : report.strands.length > 0 ? (
            <Panel title="Strands">
              <div className="grid gap-3">
                {report.strands.map((strand) => (
                  <StrandCard key={strand.id} strand={strand} onOpen={setOpenNode} />
                ))}
              </div>
            </Panel>
          ) : (
            <Panel title="Jobs">
              <ul className="grid gap-2">
                {(runStatus.data?.unplannedJobs ?? []).map((job) => (
                  <JobCard key={job.nodeId} job={job} onOpen={setOpenNode} />
                ))}
              </ul>
            </Panel>
          )}
          <Panel title="Execution tree">
            {root === undefined ? (
              <p className="text-sm text-muted-foreground">No nodes yet.</p>
            ) : (
              <ul>
                <TreeNode node={root} byParent={byParent} scope={scope} titles={titles} />
              </ul>
            )}
          </Panel>
        </TabsContent>

        <TabsContent value="timeline" className="mt-4">
          <Panel title="Timeline">
            <ol className="max-h-[36rem] overflow-auto text-xs" data-testid="timeline">
              {live.events.map((event) => (
                <li
                  key={event.eventId}
                  className="grid grid-cols-[10rem_7rem_6rem_1fr] gap-2 border-t py-1"
                >
                  <span className="text-muted-foreground">{when(event.occurredAt)}</span>
                  <span className="font-mono text-muted-foreground">
                    {event.sequence === null ? "…" : `#${event.sequence}`} {event.source}
                  </span>
                  <span className="font-mono text-muted-foreground">
                    {event.executionNodeId === null ? "run" : shortId(event.executionNodeId)}
                  </span>
                  <span>
                    {narrate(event)}
                    {event.payloadArtifactId === undefined ? null : (
                      <>
                        {" "}
                        <ArtifactLink artifactId={event.payloadArtifactId} label="payload" />
                      </>
                    )}
                  </span>
                </li>
              ))}
            </ol>
          </Panel>
        </TabsContent>

        <TabsContent value="decisions" className="mt-4">
          <Panel title="Decision graph">
            {report === undefined || report.graph.length === 0 ? (
              <p className="text-sm text-muted-foreground">No decisions were recorded.</p>
            ) : (
              <ul className="grid gap-2">
                {report.graph.map((entry) => (
                  <DecisionRow key={entry.decision.decisionId} entry={entry} scope={scope} />
                ))}
              </ul>
            )}
          </Panel>
        </TabsContent>

        <TabsContent value="artifacts" className="mt-4 grid gap-4">
          <Panel title="Artifacts">
            <DataTable
              label="Artifacts"
              columns={artifactColumns}
              rows={artifacts.data ?? []}
              empty="None."
            />
          </Panel>
          <Panel title="Checkpoints">
            {(checkpoints.data ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">None.</p>
            ) : (
              <ul className="grid gap-1 text-xs">
                {(checkpoints.data ?? []).map((c: Checkpoint) => (
                  <li key={c.checkpointId}>
                    <code className="font-mono">{shortSha(c.commitSha)}</code> {c.ref}{" "}
                    {c.label ?? ""}{" "}
                    <span className="text-muted-foreground">
                      {shortId(c.executionNodeId)} · {when(c.createdAt)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
          <details>
            <summary className="cursor-pointer text-sm">The run record (JSON)</summary>
            <Json value={r} />
          </details>
        </TabsContent>
      </Tabs>

      <Sheet
        open={opened !== undefined}
        onOpenChange={(open) => (open ? undefined : setOpenNode(undefined))}
      >
        <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
          <SheetHeader>
            <SheetTitle>
              {opened?.jobContractId == null ? "Node" : (titles.get(opened.jobContractId) ?? "Job")}
            </SheetTitle>
            <SheetDescription className="font-mono">
              {opened === undefined ? "" : shortId(opened.executionNodeId)}
            </SheetDescription>
          </SheetHeader>
          <div className="px-4 pb-6">
            {opened === undefined ? null : (
              <NodeDetail
                node={opened}
                job={opened.jobContractId === null ? undefined : jobOf.get(opened.jobContractId)}
                report={report}
                scope={scope}
              />
            )}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
};
