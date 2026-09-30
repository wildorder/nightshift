/**
 * One node, in full (P13, D-P13-11): what it had to do, what was checked, and
 * then how it went. The same content under the run graph and in the Work tab's
 * side sheet.
 *
 * "What it had to do" is prose written at delegation (the objective and
 * acceptance) and is not scored item by item; "what was checked" is the
 * verification, which is what "passed" means in Nightshift. They are shown as
 * what they are. A strand's claimed success criteria are recorded met or not.
 */
import type { ExecutionNode, JobContract } from "@nightshift/contracts";
import type { RunReport, RunScope } from "@nightshift/core";
import { useQueries } from "@tanstack/react-query";
import { Link } from "react-router";
import { Separator } from "@/components/ui/separator";
import { shortId, shortSha } from "../../lib/format.js";
import { useStudio } from "../../studio.js";
import { StatusBadge } from "../status-badge.js";
import { AgentsList, Examinations, Routes_, Verifications } from "./parts.js";

const Block = ({
  title,
  children,
}: {
  readonly title: string;
  readonly children: React.ReactNode;
}) => (
  <section className="grid gap-2">
    <h3 className="text-sm font-semibold">{title}</h3>
    {children}
  </section>
);

export const NodeDetail = ({
  node,
  job,
  report,
  scope,
}: {
  readonly node: ExecutionNode;
  readonly job: JobContract | undefined;
  readonly report: RunReport | undefined;
  readonly scope: RunScope;
}) => {
  const { stores } = useStudio();
  const id = node.executionNodeId;
  const [agents, verifications, examinations, routes] = useQueries({
    queries: [
      { queryKey: ["agents", scope.runId, id], queryFn: () => stores.agents.listByNode(scope, id) },
      {
        queryKey: ["verifications", scope.runId, id],
        queryFn: () => stores.verifications.listByNode(scope, id),
      },
      {
        queryKey: ["examinations", scope.runId, id],
        queryFn: () => stores.examinations.listByNode(scope, id),
      },
      {
        queryKey: ["routes", scope.runId, id],
        queryFn: () => stores.routingDecisions.listByNode(scope, id),
      },
    ],
  });
  const strandId = job?.strandId;
  const strand =
    strandId === undefined ? undefined : report?.program.strands?.find((s) => s.id === strandId);
  const criteria =
    strand === undefined
      ? []
      : (report?.criteria ?? []).filter((c) => strand.successCriteria.includes(c.id));
  const decisions = (report?.graph ?? []).filter((entry) => entry.decision.executionNodeId === id);
  const objective =
    job?.objective ?? (node.parentNodeId === null ? report?.program.objective : undefined);
  const acceptance = strand?.acceptance ?? job?.acceptance ?? [];
  const attempts = [...(routes.data ?? [])]
    .filter((r) => r.purpose === undefined)
    .sort((a, b) => a.attempt - b.attempt);

  return (
    <div className="grid gap-5" data-testid="node-detail">
      <header className="grid gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={node.status} />
          <span className="text-sm text-muted-foreground">
            {strandId === undefined ? node.kind : `strand ${strandId}`} ·{" "}
            <span className="font-mono">{shortId(id)}</span>
            {node.commitSha === null ? "" : ` · landed ${shortSha(node.commitSha)}`}
          </span>
        </div>
        {node.outcomeReason === undefined ? null : (
          <p className="text-sm text-status-danger-foreground">{node.outcomeReason}</p>
        )}
      </header>

      <Block title="What it had to do">
        {objective === undefined ? (
          <p className="text-sm text-muted-foreground">No objective on the record.</p>
        ) : (
          <p className="text-sm whitespace-pre-wrap">{objective}</p>
        )}
        {acceptance.length === 0 ? null : (
          <ul className="ml-4 list-disc text-sm text-muted-foreground">
            {acceptance.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        )}
        {criteria.length === 0 ? null : (
          <ul className="grid gap-1 text-sm" aria-label="Success criteria">
            {criteria.map((c) => (
              <li key={c.id} className="flex items-baseline gap-2">
                <StatusBadge status={c.met ? "met" : "not met"} />
                <span className="font-medium">{c.id}</span>
                <span className="text-muted-foreground">{c.outcome}</span>
              </li>
            ))}
          </ul>
        )}
      </Block>

      <Separator />
      <Block title="What was checked">
        <Verifications verifications={verifications.data ?? []} />
      </Block>

      {attempts.length === 0 ? null : (
        <Block title={`Attempts (${attempts.length})`}>
          <Routes_ routes={attempts} />
        </Block>
      )}

      {(examinations.data ?? []).length === 0 ? null : (
        <Block title="Examined by a second model">
          <Examinations examinations={examinations.data ?? []} />
        </Block>
      )}

      {(agents.data ?? []).length === 0 ? null : (
        <Block title="Agents">
          <AgentsList agents={agents.data ?? []} />
        </Block>
      )}

      {decisions.length === 0 ? null : (
        <Block title="Decisions made here">
          <ul className="grid gap-1 text-sm">
            {decisions.map(({ decision }) => (
              <li key={decision.decisionId}>
                <Link
                  to={`/projects/${scope.projectId}/programs/${scope.programId}/runs/${scope.runId}/decisions/${decision.decisionId}`}
                  className="font-medium underline-offset-4 hover:underline"
                >
                  {decision.choice}
                </Link>{" "}
                <span className="text-muted-foreground">{decision.context}</span>
              </li>
            ))}
          </ul>
        </Block>
      )}
    </div>
  );
};
