/**
 * The run page's parts (P11, T4; moved here and put on the theme in P13, T4).
 * The run page (T4, D-P11-10): what happened, from the control plane alone.
 *
 * The report's views come from `gatherReport` in `core`, the same computation
 * `nightshift report` renders; the tree, agents, timeline, verifications and
 * artifacts are the records beside it. While the run is live the page follows
 * it by polling the event cursor (D-P11-05).
 */
import type {
  Agent,
  Examination,
  ExecutionNode,
  RoutingDecision,
  Verification,
} from "@nightshift/contracts";
import { ProgramIdSchema, ProjectIdSchema, RunIdSchema } from "@nightshift/contracts";
import type {
  DecisionReport,
  JobReport,
  RunReport,
  RunScope,
  StrandReport,
} from "@nightshift/core";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useParams } from "react-router";
import { between, durationMs, shortId, shortSha, usd } from "../../lib/format.js";
import { useStudio } from "../../studio.js";
import { StatusBadge } from "../status-badge.js";

export const useRunScope = (): RunScope => {
  const { projectId, programId, runId } = useParams();
  return {
    projectId: ProjectIdSchema.parse(projectId),
    programId: ProgramIdSchema.parse(programId),
    runId: RunIdSchema.parse(runId),
  };
};

export const firstLine = (text: string): string =>
  (text.split("\n").find((line) => line.trim() !== "") ?? "").replace(/^#+\s*/, "").slice(0, 120);

export const Section = ({
  title,
  children,
}: {
  readonly title: string;
  readonly children: React.ReactNode;
}) => (
  <section className="rounded-lg border border-border bg-card p-3">
    <h2 className="mb-2 text-lg font-semibold">{title}</h2>
    {children}
  </section>
);

export const Routes_ = ({ routes }: { readonly routes: readonly RoutingDecision[] }) =>
  routes.length === 0 ? null : (
    <table className="w-full text-xs">
      <thead className="text-left text-muted-foreground">
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
          <tr key={route.routingDecisionId} className="border-t border-border">
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
              <StatusBadge status={route.outcome} />
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

export const ArtifactLink = ({
  artifactId,
  label,
}: {
  readonly artifactId: string;
  readonly label: string;
}) => {
  const { artifacts } = useStudio();
  const scope = useRunScope();
  const [problem, setProblem] = useState<string | undefined>(undefined);
  if (artifacts === undefined) return <span className="text-muted-foreground">{label}</span>;
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
      {problem === undefined ? null : <span className="text-xs text-destructive"> {problem}</span>}
    </>
  );
};

export const Verifications = ({
  verifications,
}: {
  readonly verifications: readonly Verification[];
}) =>
  verifications.length === 0 ? (
    <p className="text-xs text-muted-foreground">No verification yet.</p>
  ) : (
    <ul className="flex flex-col gap-1">
      {verifications.map((v) => (
        <li key={v.verificationId} className="rounded-lg border border-border p-1 text-xs">
          <div>
            <StatusBadge status={v.outcome} /> {v.phase ?? "queue"} on{" "}
            <code>{shortSha(v.commitSha)}</code> {between(v.startedAt, v.endedAt)}
            {v.criterionId === undefined ? "" : ` · criterion ${v.criterionId}`}
          </div>
          <table className="mt-1 w-full">
            <tbody>
              {v.commands.map((command) => (
                <tr key={command.stepId} className="border-t border-border">
                  <td className="p-0.5 font-mono">{command.stepId}</td>
                  <td className="p-0.5 font-mono text-muted-foreground">{command.command}</td>
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

export const Examinations = ({
  examinations,
}: {
  readonly examinations: readonly Examination[];
}) =>
  examinations.length === 0 ? null : (
    <ul className="flex flex-col gap-1">
      {examinations.map((x) => (
        <li key={x.examinationId} className="rounded-lg border border-border p-1 text-xs">
          <div>
            <StatusBadge status={x.outcome} /> examined by{" "}
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
                  <ul className="ml-4 list-[circle] text-muted-foreground">
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
            <ul className="ml-4 list-disc text-muted-foreground">
              {x.questions.map((q) => (
                <li key={q.question}>
                  Q: {q.question} — A ({q.answeredBy}): {q.answer}
                </li>
              ))}
            </ul>
          )}
          {x.followsRulings === undefined ? null : (
            <p className="text-muted-foreground">
              After rulings:{" "}
              {x.followsRulings.map((r) => `${r.findingId}: ${r.summary}`).join("; ")}
            </p>
          )}
        </li>
      ))}
    </ul>
  );

export const AgentsList = ({ agents }: { readonly agents: readonly Agent[] }) =>
  agents.length === 0 ? null : (
    <ul className="text-xs">
      {agents.map((agent) => (
        <li key={agent.agentId}>
          <StatusBadge status={agent.status} /> {agent.role} on{" "}
          <code>
            {agent.harness}/{agent.provider}/{agent.model}
          </code>
          {agent.exitCode === undefined ? "" : ` exit ${agent.exitCode}`}
          {agent.outcomeReason === undefined ? "" : ` — ${agent.outcomeReason}`}{" "}
          <span className="text-muted-foreground">{between(agent.startedAt, agent.endedAt)}</span>
        </li>
      ))}
    </ul>
  );

/** A job's own records, fetched beside the report's view of it. */
/** A job as a row: what it is and how it ended. Selecting it opens its detail (D-P13-11). */
export const JobCard = ({
  job,
  onOpen,
}: {
  readonly job: JobReport;
  readonly onOpen: (nodeId: string) => void;
}) => (
  <li data-node={job.nodeId}>
    <button
      type="button"
      onClick={() => onOpen(job.nodeId)}
      className="flex w-full flex-wrap items-baseline gap-2 rounded-md border px-3 py-2 text-left text-sm transition-colors hover:bg-accent"
    >
      <StatusBadge status={job.status} />
      <span className="font-medium">{job.objective}</span>
      <span className="ml-auto font-mono text-xs text-muted-foreground">
        {shortId(job.nodeId)} · {job.attempts} attempt{job.attempts === 1 ? "" : "s"} ·{" "}
        {shortSha(job.commitSha)}
      </span>
      {job.reason === undefined ? null : (
        <span className="w-full text-xs text-status-danger-foreground">{job.reason}</span>
      )}
    </button>
  </li>
);

export const StrandCard = ({
  strand,
  onOpen,
}: {
  readonly strand: StrandReport;
  readonly onOpen: (nodeId: string) => void;
}) => (
  <div className="grid gap-2 rounded-lg border bg-card p-4 text-card-foreground">
    <div className="flex items-baseline gap-2">
      <StatusBadge status={strand.outcome} />
      <span className="font-medium">
        {strand.id} {strand.name}
      </span>
      <span className="ml-auto text-xs text-muted-foreground">
        {strand.attempts} attempt{strand.attempts === 1 ? "" : "s"}
      </span>
    </div>
    {strand.reason === undefined ? null : (
      <p className="text-sm text-status-danger-foreground">{strand.reason}</p>
    )}
    {strand.blockedBy.length === 0 ? null : (
      <p className="text-sm text-status-warning-foreground">
        Blocked by {strand.blockedBy.join(", ")}
      </p>
    )}
    {strand.waitingOn.length === 0 ? null : (
      <p className="text-sm text-status-warning-foreground">
        Waiting on {strand.waitingOn.join(", ")}
      </p>
    )}
    <ul className="ml-4 list-disc text-sm text-muted-foreground">
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
        <JobCard key={job.nodeId} job={job} onOpen={onOpen} />
      ))}
    </ul>
  </div>
);

export const TreeNode = ({
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
        <StatusBadge status={node.status} /> <b>{node.kind}</b>{" "}
        <span className="font-mono text-xs text-muted-foreground">
          {shortId(node.executionNodeId)}
        </span>{" "}
        <span className="text-muted-foreground">
          {node.jobContractId === null ? "" : (titles.get(node.jobContractId) ?? "")}
        </span>{" "}
        <code>{shortSha(node.commitSha)}</code>
        {node.outcomeReason === undefined ? (
          ""
        ) : (
          <span className="text-status-danger-foreground"> — {node.outcomeReason}</span>
        )}
      </div>
      <AgentsList agents={agents.data ?? []} />
      {(byParent.get(node.executionNodeId) ?? []).length === 0 ? null : (
        <ul className="ml-4 border-l border-border pl-3">
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

export const Usage = ({ report }: { readonly report: RunReport }) => {
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
        <thead className="text-left text-muted-foreground">
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
              className="border-t border-border"
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

export const DecisionRow = ({
  entry,
  scope,
}: {
  readonly entry: DecisionReport;
  readonly scope: RunScope;
}) => {
  const d = entry.decision;
  return (
    <li className="rounded-lg border border-border p-2 text-sm">
      <div className="flex items-baseline gap-2">
        <StatusBadge status={entry.place} />
        <Link
          to={`/projects/${scope.projectId}/programs/${scope.programId}/runs/${scope.runId}/decisions/${d.decisionId}`}
          className="font-medium underline"
        >
          {d.choice}
        </Link>
        <span className="text-xs text-muted-foreground">
          {d.authority} · {d.reversibility}
          {entry.where === undefined ? "" : ` · ${entry.where}`}
        </span>
      </div>
      <p className="text-muted-foreground">{d.context}</p>
      <p className="text-xs text-muted-foreground">
        Weighed:{" "}
        {d.alternatives
          .map(
            (a) =>
              `${a.summary}${a.rejectedBecause === undefined ? "" : ` (${a.rejectedBecause})`}`,
          )
          .join("; ")}
      </p>
      <p className="text-xs text-muted-foreground">
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
