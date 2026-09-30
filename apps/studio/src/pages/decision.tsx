/**
 * A decision's page, and its reversal (T5, D-P11-08).
 *
 * Reversing here records exactly what `nightshift decision reverse` records:
 * the same builder in `core`, the same refusals. Nothing else moves; the page
 * then shows the correction's next step, which is planned with the owner in a
 * session, never here.
 */
import type { Decision, DecisionId } from "@nightshift/contracts";
import { DecisionIdSchema } from "@nightshift/contracts";
import {
  buildReversal,
  CONFIRMED_CLASSES,
  gatherReport,
  isSuperseded,
  whyNotReversible,
} from "@nightshift/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useParams } from "react-router";
import { Button } from "@/components/ui/button";
import { Json } from "../components/json.js";
import { StatusBadge } from "../components/status-badge.js";
import { shortId, when } from "../lib/format.js";
import { narrate } from "../lib/narrate.js";
import { readAll } from "../lib/read-all.js";
import { useStudio } from "../studio.js";
import { useRunScope } from "./run.js";

const Alternatives = ({ decision }: { readonly decision: Decision }) => (
  <ul className="ml-4 list-disc text-sm">
    {decision.alternatives.map((a) => (
      <li key={a.summary}>
        {a.summary}
        {a.rejectedBecause === undefined ? (
          ""
        ) : (
          <span className="text-muted-foreground"> — rejected because {a.rejectedBecause}</span>
        )}
      </li>
    ))}
  </ul>
);

const ReverseForm = ({
  decision,
  onDone,
}: {
  readonly decision: Decision;
  readonly onDone: (reversal: Decision) => void;
}) => {
  const { stores, ids, now } = useStudio();
  const [choice, setChoice] = useState("");
  const [reason, setReason] = useState("");
  const reverse = useMutation({
    mutationFn: async (): Promise<Decision> => {
      const reversal = buildReversal(decision, {
        decisionId: ids.next("dec"),
        choice: choice.trim(),
        reason: reason.trim(),
        at: now(),
      });
      await stores.decisions.put(reversal);
      return reversal;
    },
    onSuccess: onDone,
  });
  return (
    <form
      className="grid gap-3 rounded-lg border bg-card p-4 text-card-foreground"
      onSubmit={(event) => {
        event.preventDefault();
        reverse.mutate();
      }}
    >
      <h3 className="font-semibold">Reverse this decision</h3>
      <p className="text-sm text-muted-foreground">
        It chose <b>{decision.choice}</b>. Your choice replaces it on your authority; nothing else
        moves until a correction is planned and run.
      </p>
      {CONFIRMED_CLASSES.includes(decision.reversibility) ? (
        <p className="text-sm text-status-warning-foreground">
          It is <b>{decision.reversibility}</b>: its effects reach outside the repository. The
          correction will be flagged, and <code>nightshift run</code> will ask you to confirm.
        </p>
      ) : null}
      <label className="text-sm">
        Your choice
        <input
          className="ml-2 h-9 w-96 max-w-full rounded-md border border-input bg-background px-3 text-sm"
          value={choice}
          onChange={(e) => setChoice(e.target.value)}
          required
        />
      </label>
      <label className="text-sm">
        Why
        <input
          className="ml-2 h-9 w-96 max-w-full rounded-md border border-input bg-background px-3 text-sm"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          required
        />
      </label>
      {reverse.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {String(reverse.error)}
        </p>
      ) : null}
      <div>
        <Button
          type="submit"
          disabled={reverse.isPending || choice.trim() === "" || reason.trim() === ""}
        >
          Record the reversal
        </Button>
      </div>
    </form>
  );
};

const NextStep = ({
  decision,
  reversal,
}: {
  readonly decision: Decision;
  readonly reversal: Decision;
}) => (
  <div
    className="rounded-lg border border-status-success-foreground/30 bg-status-success p-4 text-sm text-status-success-foreground"
    data-testid="next-step"
  >
    <p>
      <b>Reversed</b> as <code>{reversal.decisionId}</code>: {reversal.choice}. {reversal.rationale}
    </p>
    <p className="mt-2">
      Nothing else changed. To correct the program under your decision, write the brief from a
      checkout of the repository and plan the correction from it with the owner:
    </p>
    <pre className="mt-1 rounded-md bg-background p-2 font-mono text-xs whitespace-pre-wrap text-foreground">
      {`nightshift decision brief <program> ${decision.decisionId} --run ${decision.runId} --out docs/programs/<correction>/brief.md`}
    </pre>
    <p className="mt-1 text-muted-foreground">
      <code>&lt;program&gt;</code> is the program's directory under <code>docs/programs/</code>{" "}
      whose contract names <code>{decision.programId}</code>. Then, in a coding session, ask{" "}
      <code>plan-program</code> to plan the correction from that brief; it is ratified and run like
      any program.
    </p>
  </div>
);

export const DecisionPage = () => {
  const scope = useRunScope();
  const { decisionId: rawId } = useParams();
  const decisionId: DecisionId = DecisionIdSchema.parse(rawId);
  const { stores } = useStudio();
  const client = useQueryClient();
  const [justReversed, setJustReversed] = useState<Decision | undefined>(undefined);

  const decisions = useQuery({
    queryKey: ["decisions", scope.runId],
    queryFn: () => readAll((page) => stores.decisions.listByRun(scope, page)),
  });
  const report = useQuery({
    queryKey: ["report", scope.runId],
    queryFn: () => gatherReport(stores, scope),
  });
  const decision = decisions.data?.find((d) => d.decisionId === decisionId);
  const node = useQuery({
    queryKey: ["node", scope.runId, decision?.executionNodeId],
    queryFn: () =>
      decision === undefined
        ? undefined
        : stores.executionNodes.get(scope, decision.executionNodeId),
    enabled: decision !== undefined,
  });
  const agent = useQuery({
    queryKey: ["agent", scope.runId, decision?.agentId],
    queryFn: () =>
      decision?.agentId == null ? undefined : stores.agents.get(scope, decision.agentId),
    enabled: decision?.agentId != null,
  });
  const events = useQuery({
    queryKey: ["events", scope.runId],
    queryFn: () => readAll((page) => stores.events.listByRun(scope, page)),
  });

  if (decisions.isPending) return <p>Loading decision…</p>;
  if (decisions.isError) return <p role="alert">Could not read the run's decisions.</p>;
  if (decision === undefined) return <p role="alert">No such decision in this run.</p>;

  const all = decisions.data;
  const entry = report.data?.graph.find((e) => e.decision.decisionId === decisionId);
  const reversal =
    justReversed ??
    all
      .filter((d) => d.supersedesDecisionId === decisionId && d.authority === "human")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .at(-1);
  const refusal = whyNotReversible(decision);
  const around = (events.data ?? [])
    .filter((e) => e.executionNodeId === decision.executionNodeId)
    .slice(-12);
  const runPath = `/projects/${scope.projectId}/programs/${scope.programId}/runs/${scope.runId}`;

  return (
    <div className="flex flex-col gap-4">
      <header>
        <p className="text-sm text-muted-foreground">
          <Link to={runPath} className="underline">
            run {shortId(scope.runId)}
          </Link>{" "}
          · decision
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">{decision.choice}</h1>
        <p className="text-sm text-muted-foreground">
          {entry === undefined ? null : <StatusBadge status={entry.place} />} {decision.authority} ·{" "}
          {decision.reversibility} · {when(decision.createdAt)} · <code>{decision.decisionId}</code>
        </p>
      </header>

      <section className="rounded-lg border bg-card p-4 text-card-foreground">
        <p className="mb-2">{decision.context}</p>
        <p className="mb-2 text-sm">
          <b>Chose:</b> {decision.choice}. {decision.rationale}
        </p>
        <p className="text-sm">
          <b>Weighed:</b>
        </p>
        <Alternatives decision={decision} />
        <p className="mt-2 text-sm">
          <b>Produced:</b>{" "}
          {decision.produced === undefined
            ? "nothing that landed"
            : decision.produced.commits.length === 0
              ? "no commits"
              : decision.produced.commits.map((c) => c.slice(0, 8)).join(", ")}
          {decision.checkpointBefore === undefined
            ? ""
            : ` · made at checkpoint ${shortId(decision.checkpointBefore)}`}
          {decision.checkpointAfter === undefined
            ? ""
            : `, landed at ${shortId(decision.checkpointAfter)}`}
        </p>
        <p className="text-sm text-muted-foreground">
          On node <code>{shortId(decision.executionNodeId)}</code>
          {node.data === undefined ? "" : ` (${node.data.kind}, ${node.data.status})`}
          {agent.data === undefined
            ? ""
            : `, by ${agent.data.role} on ${agent.data.harness}/${agent.data.model}`}
          {entry?.where === undefined ? "" : ` · ${entry.where}`}
        </p>
        {entry !== undefined && entry.correctedBy.length > 0 ? (
          <p className="text-sm">
            <b>Corrected by</b> {entry.correctedBy.join(", ")}
          </p>
        ) : null}
      </section>

      {reversal !== undefined ? (
        <NextStep decision={decision} reversal={reversal} />
      ) : refusal !== undefined ? (
        <p
          role="alert"
          className="rounded-md border border-status-warning-foreground/30 bg-status-warning p-3 text-sm text-status-warning-foreground"
        >
          {refusal}
        </p>
      ) : isSuperseded(decision, all) ? (
        <p
          role="alert"
          className="rounded-md border border-status-warning-foreground/30 bg-status-warning p-3 text-sm text-status-warning-foreground"
        >
          {decision.decisionId} has already been superseded.
        </p>
      ) : (
        <ReverseForm
          decision={decision}
          onDone={async (made) => {
            setJustReversed(made);
            await client.invalidateQueries({ queryKey: ["decisions", scope.runId] });
            await client.invalidateQueries({ queryKey: ["report", scope.runId] });
          }}
        />
      )}

      <section className="rounded-lg border bg-card p-4 text-card-foreground">
        <h2 className="mb-1 font-semibold">Around it</h2>
        {around.length === 0 ? (
          <p className="text-sm text-muted-foreground">No events on its node.</p>
        ) : (
          <ol className="text-xs">
            {around.map((event) => (
              <li key={event.eventId}>
                <span className="text-muted-foreground">{when(event.occurredAt)}</span>{" "}
                {narrate(event)}
              </li>
            ))}
          </ol>
        )}
      </section>

      <details>
        <summary className="cursor-pointer text-sm">The decision record (JSON)</summary>
        <Json value={decision} />
      </details>
    </div>
  );
};
