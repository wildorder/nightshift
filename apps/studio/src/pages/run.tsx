/**
 * The run page (T4, D-P11-10): what happened, from the control plane alone.
 *
 * The report's views come from `gatherReport` in `core`, the same computation
 * `nightshift report` renders; the tree, agents, timeline, verifications and
 * artifacts are the records beside it. While the run is live the page follows
 * it by polling the event cursor (D-P11-05).
 */
import type {
  Agent,
  Artifact,
  Checkpoint,
  Examination,
  ExecutionNode,
  RoutingDecision,
  Run,
  Verification,
} from "@nightshift/contracts";
import { ProgramIdSchema, ProjectIdSchema, RunIdSchema } from "@nightshift/contracts";
import {
  type DecisionReport,
  gatherReport,
  type JobReport,
  type RunReport,
  type RunScope,
  type StrandReport,
} from "@nightshift/core";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useParams } from "react-router";
import { Json } from "../components/json.js";
import { Status } from "../components/status.js";
import { between, durationMs, shortId, shortSha, usd, when } from "../lib/format.js";
import { useLiveEvents } from "../lib/live.js";
import { narrate } from "../lib/narrate.js";
import { readAll } from "../lib/read-all.js";
import { DEFAULT_POLL_MS, useStudio } from "../studio.js";

export const useRunScope = (): RunScope => {
  const { projectId, programId, runId } = useParams();
  return {
    projectId: ProjectIdSchema.parse(projectId),
    programId: ProgramIdSchema.parse(programId),
    runId: RunIdSchema.parse(runId),
  };
};

const firstLine = (text: string): string =>
  (text.split("\n").find((line) => line.trim() !== "") ?? "").replace(/^#+\s*/, "").slice(0, 120);

const Section = ({
  title,
  children,
}: {
  readonly title: string;
  readonly children: React.ReactNode;
}) => (
  <section className="rounded border border-slate-200 bg-white p-3">
    <h2 className="mb-2 text-lg font-semibold">{title}</h2>
    {children}
  </section>
);

const Routes_ = ({ routes }: { readonly routes: readonly RoutingDecision[] }) =>
  routes.length === 0 ? null : (
    <table className="w-full text-xs">
      <thead className="text-left text-slate-500">
        <tr>
          <th className="p-1">#</th>
          <th className="p-1">Purpose</th>
          <th className="p-1">Route</th>
          <th className="p-1">Ladder</th>
          <th className="p-1">Rule</th>
          <th className="p-1">Outcome</th>
          <th className="p-1">Tokens in/out</th>
          <th className="p-1">Cost</th>
          <th className="p-1">Wall</th>
        </tr>
      </thead>
      <tbody>
        {routes.map((route) => (
          <tr key={route.routingDecisionId} className="border-t border-slate-100">
            <td className="p-1">{route.attempt}</td>
            <td className="p-1">{route.purpose ?? "work"}</td>
            <td className="p-1 font-mono">
              {route.chosen.harness}/{route.chosen.model}
              {route.chosen.effort === undefined ? "" : ` (${route.chosen.effort})`}
              {route.wasOverride ? " override" : ""}
            </td>
            <td className="p-1">
              {route.ladder ?? "—"}
              {route.rung === undefined ? "" : ` ${route.rung.tier}[${route.rung.index}]`}
            </td>
            <td className="p-1">{route.ruleId}</td>
            <td className="p-1">
              <Status value={route.outcome} />
            </td>
            <td className="p-1">
              {route.usage.inputTokens ?? "?"}/{route.usage.outputTokens ?? "?"}
            </td>
            <td className="p-1">
              {route.usage.actualCostUsd !== undefined
                ? usd(route.usage.actualCostUsd)
                : route.usage.estimatedCostUsd !== undefined
                  ? `~${usd(route.usage.estimatedCostUsd)}`
                  : "unpriced"}
            </td>
            <td className="p-1">
              {route.usage.wallClockMs === undefined ? "—" : durationMs(route.usage.wallClockMs)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );

const ArtifactLink = ({
  artifactId,
  label,
}: {
  readonly artifactId: string;
  readonly label: string;
}) => {
  const { artifacts } = useStudio();
  const scope = useRunScope();
  const [problem, setProblem] = useState<string | undefined>(undefined);
  if (artifacts === undefined) return <span className="text-slate-500">{label}</span>;
  return (
    <>
      <button
        type="button"
        className="text-xs underline"
        onClick={() => {
          artifacts
            .downloadUrl(scope, artifactId as never)
            .then((url) => window.open(url, "_blank", "noopener"))
            .catch((error: unknown) => setProblem(String(error)));
        }}
      >
        {label}
      </button>
      {problem === undefined ? null : <span className="text-xs text-red-700"> {problem}</span>}
    </>
  );
};

const Verifications = ({ verifications }: { readonly verifications: readonly Verification[] }) =>
  verifications.length === 0 ? (
    <p className="text-xs text-slate-500">No verification yet.</p>
  ) : (
    <ul className="flex flex-col gap-1">
      {verifications.map((v) => (
        <li key={v.verificationId} className="rounded border border-slate-100 p-1 text-xs">
          <div>
            <Status value={v.outcome} /> {v.phase ?? "queue"} on{" "}
            <code>{shortSha(v.commitSha)}</code> {between(v.startedAt, v.endedAt)}
            {v.criterionId === undefined ? "" : ` · criterion ${v.criterionId}`}
          </div>
          <table className="mt-1 w-full">
            <tbody>
              {v.commands.map((command) => (
                <tr key={command.stepId} className="border-t border-slate-100">
                  <td className="p-0.5 font-mono">{command.stepId}</td>
                  <td className="p-0.5 font-mono text-slate-600">{command.command}</td>
                  <td className="p-0.5">
                    {command.deferred !== undefined
                      ? `deferred: ${command.deferred.prerequisiteId}`
                      : `exit ${command.exitCode}`}
                  </td>
                  <td className="p-0.5">{durationMs(command.durationMs)}</td>
                  <td className="p-0.5">
                    {command.logArtifactId === undefined ? null : (
                      <ArtifactLink artifactId={command.logArtifactId} label="log" />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </li>
      ))}
    </ul>
  );

const Examinations = ({ examinations }: { readonly examinations: readonly Examination[] }) =>
  examinations.length === 0 ? null : (
    <ul className="flex flex-col gap-1">
      {examinations.map((x) => (
        <li key={x.examinationId} className="rounded border border-slate-100 p-1 text-xs">
          <div>
            <Status value={x.outcome} /> examined by{" "}
            <code>
              {x.examinerRoute.harness}/{x.examinerRoute.model}
            </code>{" "}
            for {x.requiredByRisk} risk{x.blocking ? ", blocking" : ""}
            {x.fixAttempt > 0 ? `, fix attempt ${x.fixAttempt}` : ""}
            {x.reportArtifactId === undefined ? null : (
              <>
                {" "}
                · <ArtifactLink artifactId={x.reportArtifactId} label="report" />
              </>
            )}
          </div>
          {x.findings.length === 0 ? null : (
            <ul className="ml-4 list-disc">
              {x.findings.map((finding) => (
                <li key={finding.id}>
                  <b>{finding.severity}</b> {finding.summary} — {finding.resolution}
                  {finding.resolvedBy === undefined ? "" : ` (${finding.resolvedBy.authority})`}
                  <ul className="ml-4 list-[circle] text-slate-600">
                    {finding.evidence.map((e, i) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: evidence has no id
                      <li key={i}>
                        {e.kind === "location"
                          ? `${e.path}:${e.startLine}-${e.endLine}${e.note === undefined ? "" : ` ${e.note}`}`
                          : e.kind === "command"
                            ? `\`${e.command}\` exit ${e.exitCode}`
                            : `contract: ${e.clause}`}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
          {x.questions.length === 0 ? null : (
            <ul className="ml-4 list-disc text-slate-700">
              {x.questions.map((q) => (
                <li key={q.question}>
                  Q: {q.question} — A ({q.answeredBy}): {q.answer}
                </li>
              ))}
            </ul>
          )}
          {x.followsRulings === undefined ? null : (
            <p className="text-slate-600">
              After rulings:{" "}
              {x.followsRulings.map((r) => `${r.findingId}: ${r.summary}`).join("; ")}
            </p>
          )}
        </li>
      ))}
    </ul>
  );

const AgentsList = ({ agents }: { readonly agents: readonly Agent[] }) =>
  agents.length === 0 ? null : (
    <ul className="text-xs">
      {agents.map((agent) => (
        <li key={agent.agentId}>
          <Status value={agent.status} /> {agent.role} on{" "}
          <code>
            {agent.harness}/{agent.provider}/{agent.model}
          </code>
          {agent.exitCode === undefined ? "" : ` exit ${agent.exitCode}`}
          {agent.outcomeReason === undefined ? "" : ` — ${agent.outcomeReason}`}{" "}
          <span className="text-slate-500">{between(agent.startedAt, agent.endedAt)}</span>
        </li>
      ))}
    </ul>
  );

/** A job's own records, fetched beside the report's view of it. */
const JobCard = ({ job, scope }: { readonly job: JobReport; readonly scope: RunScope }) => {
  const { stores } = useStudio();
  const [agents, verifications] = useQueries({
    queries: [
      {
        queryKey: ["agents", scope.runId, job.nodeId],
        queryFn: () => stores.agents.listByNode(scope, job.nodeId as never),
      },
      {
        queryKey: ["verifications", scope.runId, job.nodeId],
        queryFn: () => stores.verifications.listByNode(scope, job.nodeId as never),
      },
    ],
  });
  return (
    <li className="rounded border border-slate-200 p-2" data-node={job.nodeId}>
      <div className="flex items-baseline gap-2 text-sm">
        <Status value={job.status} />
        <span className="font-medium">{job.objective}</span>
        <span className="ml-auto font-mono text-xs text-slate-500">
          {shortId(job.nodeId)} · {job.attempts} attempt{job.attempts === 1 ? "" : "s"} ·{" "}
          {shortSha(job.commitSha)}
        </span>
      </div>
      {job.reason === undefined ? null : <p className="text-xs text-red-800">{job.reason}</p>}
      <AgentsList agents={agents.data ?? []} />
      <Routes_ routes={job.routes} />
      <Verifications verifications={verifications.data ?? []} />
      <Examinations examinations={job.examinations} />
    </li>
  );
};

const StrandCard = ({
  strand,
  scope,
}: {
  readonly strand: StrandReport;
  readonly scope: RunScope;
}) => (
  <div className="rounded border border-slate-200 p-2">
    <div className="flex items-baseline gap-2">
      <Status value={strand.outcome} />
      <span className="font-medium">
        {strand.id} {strand.name}
      </span>
      <span className="ml-auto text-xs text-slate-500">
        {strand.attempts} attempt{strand.attempts === 1 ? "" : "s"}
      </span>
    </div>
    {strand.reason === undefined ? null : <p className="text-sm text-red-800">{strand.reason}</p>}
    {strand.blockedBy.length === 0 ? null : (
      <p className="text-sm text-amber-800">Blocked by {strand.blockedBy.join(", ")}</p>
    )}
    {strand.waitingOn.length === 0 ? null : (
      <p className="text-sm text-amber-800">Waiting on {strand.waitingOn.join(", ")}</p>
    )}
    <ul className="ml-4 list-disc text-sm text-slate-700">
      {strand.acceptance.map((a) => (
        <li key={a}>{a}</li>
      ))}
    </ul>
    {strand.departures.length === 0 ? null : (
      <div className="mt-1 text-sm">
        <b>Departures from the plan</b>
        <ul className="ml-4 list-disc">
          {strand.departures.map((d) => (
            <li key={d.decisionId}>
              {d.context} → {d.choice}
            </li>
          ))}
        </ul>
      </div>
    )}
    <ul className="mt-2 flex flex-col gap-2">
      {strand.jobs.map((job) => (
        <JobCard key={job.nodeId} job={job} scope={scope} />
      ))}
    </ul>
  </div>
);

const TreeNode = ({
  node,
  byParent,
  scope,
  titles,
}: {
  readonly node: ExecutionNode;
  readonly byParent: ReadonlyMap<string | null, readonly ExecutionNode[]>;
  readonly scope: RunScope;
  /** Job contract id → its objective's first line. */
  readonly titles: ReadonlyMap<string, string>;
}) => {
  const { stores } = useStudio();
  const agents = useQuery({
    queryKey: ["agents", scope.runId, node.executionNodeId],
    queryFn: () => stores.agents.listByNode(scope, node.executionNodeId),
  });
  return (
    <li data-tree-node={node.executionNodeId}>
      <div className="text-sm">
        <Status value={node.status} /> <b>{node.kind}</b>{" "}
        <span className="font-mono text-xs text-slate-500">{shortId(node.executionNodeId)}</span>{" "}
        <span className="text-slate-600">
          {node.jobContractId === null ? "" : (titles.get(node.jobContractId) ?? "")}
        </span>{" "}
        <code>{shortSha(node.commitSha)}</code>
        {node.outcomeReason === undefined ? (
          ""
        ) : (
          <span className="text-red-800"> — {node.outcomeReason}</span>
        )}
      </div>
      <AgentsList agents={agents.data ?? []} />
      {(byParent.get(node.executionNodeId) ?? []).length === 0 ? null : (
        <ul className="ml-4 border-l border-slate-200 pl-3">
          {(byParent.get(node.executionNodeId) ?? []).map((child) => (
            <TreeNode
              key={child.executionNodeId}
              node={child}
              byParent={byParent}
              scope={scope}
              titles={titles}
            />
          ))}
        </ul>
      )}
    </li>
  );
};

const Usage = ({ report }: { readonly report: RunReport }) => {
  const total = report.usage.reduce((sum, row) => sum + row.costUsd, 0);
  const unpriced = report.usage.reduce((sum, row) => sum + row.unpriced, 0);
  const estimated = report.usage.some((row) => row.estimated);
  return (
    <>
      <p className="mb-1 text-sm">
        Total {estimated ? "about " : ""}
        {usd(total)}
        {unpriced > 0
          ? ` (${unpriced} route${unpriced === 1 ? "" : "s"} unpriced: not free, unknown)`
          : ""}
      </p>
      <table className="w-full text-xs">
        <thead className="text-left text-slate-500">
          <tr>
            <th className="p-1">Harness</th>
            <th className="p-1">Model</th>
            <th className="p-1">Purpose</th>
            <th className="p-1">Attempts</th>
            <th className="p-1">Tokens in</th>
            <th className="p-1">Tokens out</th>
            <th className="p-1">Cost</th>
          </tr>
        </thead>
        <tbody>
          {report.usage.map((row) => (
            <tr
              key={`${row.harness}/${row.model}/${row.purpose}`}
              className="border-t border-slate-100"
            >
              <td className="p-1">{row.harness}</td>
              <td className="p-1 font-mono">{row.model}</td>
              <td className="p-1">{row.purpose}</td>
              <td className="p-1">{row.attempts}</td>
              <td className="p-1">{row.inputTokens}</td>
              <td className="p-1">{row.outputTokens}</td>
              <td className="p-1">
                {row.estimated ? "~" : ""}
                {usd(row.costUsd)}
                {row.unpriced > 0 ? ` +${row.unpriced} unpriced` : ""}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
};

const DecisionRow = ({
  entry,
  scope,
}: {
  readonly entry: DecisionReport;
  readonly scope: RunScope;
}) => {
  const d = entry.decision;
  return (
    <li className="rounded border border-slate-200 p-2 text-sm">
      <div className="flex items-baseline gap-2">
        <Status value={entry.place} />
        <Link
          to={`/projects/${scope.projectId}/programs/${scope.programId}/runs/${scope.runId}/decisions/${d.decisionId}`}
          className="font-medium underline"
        >
          {d.choice}
        </Link>
        <span className="text-xs text-slate-500">
          {d.authority} · {d.reversibility}
          {entry.where === undefined ? "" : ` · ${entry.where}`}
        </span>
      </div>
      <p className="text-slate-700">{d.context}</p>
      <p className="text-xs text-slate-600">
        Weighed:{" "}
        {d.alternatives
          .map(
            (a) =>
              `${a.summary}${a.rejectedBecause === undefined ? "" : ` (${a.rejectedBecause})`}`,
          )
          .join("; ")}
      </p>
      <p className="text-xs text-slate-600">
        Produced:{" "}
        {d.produced === undefined
          ? "nothing that landed"
          : d.produced.commits.length === 0
            ? "no commits"
            : d.produced.commits.map((c) => c.slice(0, 8)).join(", ")}
        {entry.reversedBy === undefined
          ? ""
          : ` · reversed by ${shortId(entry.reversedBy.decisionId)}: ${entry.reversedBy.choice}`}
        {entry.correctedBy.length === 0 ? "" : ` · corrected by ${entry.correctedBy.join(", ")}`}
      </p>
    </li>
  );
};

export const RunPage = () => {
  const scope = useRunScope();
  const { stores, pollMs } = useStudio();
  const run = useQuery({
    queryKey: ["run", scope.runId],
    queryFn: () => stores.runs.get(scope, scope.runId),
  });
  const report = useQuery({
    queryKey: ["report", scope.runId],
    queryFn: () => gatherReport(stores, scope),
    enabled: run.data !== undefined,
  });
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

  if (run.isPending) return <p>Loading run…</p>;
  if (run.isError) return <p role="alert">Could not read the run: {String(run.error)}</p>;
  if (run.data === undefined) return <p role="alert">No such run.</p>;
  const r: Run = run.data;

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
  const isPlanned = (report.data?.strands.length ?? 0) > 0;
  const unplannedJobs: JobReport[] =
    report.data === undefined || isPlanned
      ? []
      : (nodes.data ?? [])
          .filter((n) => n.kind === "job")
          .map((n) => ({
            nodeId: n.executionNodeId,
            objective: n.jobContractId === null ? "" : (titles.get(n.jobContractId) ?? ""),
            status: n.status,
            commitSha: n.commitSha,
            attempts: 1,
            reason: n.outcomeReason,
            routes: [],
            examinations: [],
          }));

  return (
    <div className="flex flex-col gap-4">
      <header>
        <p className="text-sm text-slate-600">
          <Link to={`/projects/${scope.projectId}`} className="underline">
            project
          </Link>{" "}
          · {report.data?.program.objective ?? scope.programId}
        </p>
        <h1 className="flex items-center gap-2 text-xl font-semibold">
          Run <span className="font-mono">{shortId(r.runId)}</span> <Status value={r.status} />
          {live.polling ? (
            <span className="text-xs font-normal text-blue-700" data-testid="live">
              live · following the run
            </span>
          ) : null}
        </h1>
        <p className="text-sm text-slate-600">
          {r.location} · started {when(r.startedAt)} · ended {when(r.endedAt)} · took{" "}
          {between(r.startedAt, r.endedAt)}
          {r.policy === undefined ? "" : ` · org config v${r.policy.orgConfigVersion}`}
        </p>
        {r.outcomeReason === undefined ? null : (
          <p className="text-sm text-red-800">{r.outcomeReason}</p>
        )}
      </header>

      {report.isError ? (
        <p role="alert">Could not build the report: {String(report.error)}</p>
      ) : null}

      {report.data !== undefined && report.data.rulings.length > 0 ? (
        <Section title="Rulings">
          <ul className="flex flex-col gap-1 text-sm">
            {report.data.rulings.map((ruling) => (
              <li key={ruling.ruling.decisionId}>
                <b>{ruling.ruling.choice}</b> on {ruling.finding} (job {shortId(ruling.nodeId)})
                {ruling.arbiterModel === undefined ? "" : ` by ${ruling.arbiterModel}`}
                {ruling.sharesModelWith === undefined
                  ? ""
                  : `, sharing the ${ruling.sharesModelWith}'s model`}
                {ruling.reversedBy === undefined ? "" : ` — reversed: ${ruling.reversedBy.choice}`}
                <p className="text-slate-600">{ruling.ruling.rationale}</p>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {report.data !== undefined && report.data.corrections.length > 0 ? (
        <Section title="What this program corrects">
          <ul className="text-sm">
            {report.data.corrections.map((c) => (
              <li key={c.target.decisionId}>
                <code>{c.target.decisionId}</code> in run <code>{shortId(c.target.runId)}</code> of{" "}
                <code>{c.target.programId}</code>: {c.decision?.context ?? "(not found)"} — chose{" "}
                {c.decision?.choice ?? "?"}; reversed: {c.reversal?.choice ?? "?"}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {report.data === undefined ? null : isPlanned ? (
        <Section title="Strands">
          <div className="flex flex-col gap-2">
            {report.data.strands.map((strand) => (
              <StrandCard key={strand.id} strand={strand} scope={scope} />
            ))}
          </div>
        </Section>
      ) : (
        <Section title="Jobs">
          <ul className="flex flex-col gap-2">
            {unplannedJobs.map((job) => (
              <JobCard key={job.nodeId} job={job} scope={scope} />
            ))}
          </ul>
        </Section>
      )}

      {report.data === undefined ? null : (
        <Section title="Success criteria">
          <ul className="text-sm">
            {report.data.criteria.map((c) => (
              <li key={c.id}>
                <Status value={c.met ? "succeeded" : "pending"} /> <b>{c.id}</b> {c.outcome}
                <span className="text-slate-500"> — by {c.by.join(", ") || "nobody"}</span>
              </li>
            ))}
          </ul>
          {report.data.pendingPrerequisites.length === 0 ? null : (
            <p className="mt-2 text-sm text-amber-800">
              Pending prerequisites: {report.data.pendingPrerequisites.map((p) => p.id).join(", ")}
            </p>
          )}
        </Section>
      )}

      {report.data === undefined ? null : (
        <Section title="Usage and cost">
          <Usage report={report.data} />
        </Section>
      )}

      <Section title="Execution tree">
        {root === undefined ? (
          <p className="text-sm text-slate-500">No nodes yet.</p>
        ) : (
          <ul>
            <TreeNode node={root} byParent={byParent} scope={scope} titles={titles} />
          </ul>
        )}
      </Section>

      <Section title="Timeline">
        <ol className="max-h-[32rem] overflow-auto text-xs" data-testid="timeline">
          {live.events.map((event) => (
            <li
              key={event.eventId}
              className="grid grid-cols-[10rem_7rem_6rem_1fr] gap-2 border-t border-slate-100 py-0.5"
            >
              <span className="text-slate-500">{when(event.occurredAt)}</span>
              <span className="font-mono text-slate-500">
                {event.sequence === null ? "…" : `#${event.sequence}`} {event.source}
              </span>
              <span className="font-mono text-slate-500">
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
      </Section>

      <Section title="Checkpoints">
        {(checkpoints.data ?? []).length === 0 ? (
          <p className="text-sm text-slate-500">None.</p>
        ) : (
          <ul className="text-xs">
            {(checkpoints.data ?? []).map((c: Checkpoint) => (
              <li key={c.checkpointId}>
                <code>{shortSha(c.commitSha)}</code> {c.ref} {c.label ?? ""}{" "}
                <span className="text-slate-500">
                  {shortId(c.executionNodeId)} · {when(c.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Artifacts">
        {(artifacts.data ?? []).length === 0 ? (
          <p className="text-sm text-slate-500">None.</p>
        ) : (
          <table className="w-full text-xs">
            <thead className="text-left text-slate-500">
              <tr>
                <th className="p-1">Kind</th>
                <th className="p-1">Node</th>
                <th className="p-1">Type</th>
                <th className="p-1">Size</th>
                <th className="p-1">Recorded</th>
                <th className="p-1" />
              </tr>
            </thead>
            <tbody>
              {(artifacts.data ?? []).map((a: Artifact) => (
                <tr key={a.artifactId} className="border-t border-slate-100">
                  <td className="p-1">{a.kind}</td>
                  <td className="p-1 font-mono">{shortId(a.executionNodeId)}</td>
                  <td className="p-1">{a.contentType}</td>
                  <td className="p-1">{a.sizeBytes} B</td>
                  <td className="p-1">{when(a.createdAt)}</td>
                  <td className="p-1">
                    <ArtifactLink artifactId={a.artifactId} label="open" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      {report.data === undefined ? null : (
        <Section title="Decision graph">
          {report.data.graph.length === 0 ? (
            <p className="text-sm text-slate-500">No decisions were recorded.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {report.data.graph.map((entry) => (
                <DecisionRow key={entry.decision.decisionId} entry={entry} scope={scope} />
              ))}
            </ul>
          )}
        </Section>
      )}

      <details>
        <summary className="cursor-pointer text-sm">The run record (JSON)</summary>
        <Json value={r} />
      </details>
    </div>
  );
};
