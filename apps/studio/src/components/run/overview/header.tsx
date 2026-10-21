/**
 * The Overview's header (P20, US-05): which run, what the engine says, what a
 * person said, and how fresh the figures are. The engine status and the human
 * acceptance are separate on purpose: acceptance never stands in for
 * verification, and neither colours the other.
 */
import type { Run } from "@nightshift/contracts";
import { isRunTerminal, type RunReport, type RunScope } from "@nightshift/core";
import { Clock, Radio } from "lucide-react";
import { useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { when } from "../../../lib/format.js";
import { isStale, spanText } from "../../../lib/overview.js";
import { useStudio } from "../../../studio.js";
import { StatusBadge } from "../../status-badge.js";
import { AcceptanceState, RunVerdict } from "../verdict.js";
import { memberCountsText, type OverviewScope, scopeParam } from "./scope.js";

const selectClass =
  "h-8 min-w-0 max-w-full rounded-md border border-input bg-background px-2 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring";

const Group = ({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}) => (
  <fieldset aria-label={label} className="m-0 grid min-w-0 content-start gap-1.5 border-0 p-0">
    <span className="text-xs font-medium text-muted-foreground">{label}</span>
    {children}
  </fieldset>
);

export const OverviewHeader = ({
  run,
  report,
  scope,
  overview,
  onScope,
  live,
  pollMs,
}: {
  readonly run: Run;
  readonly report: RunReport;
  readonly scope: RunScope;
  readonly overview: OverviewScope;
  readonly onScope: (param: string) => void;
  readonly live: boolean;
  readonly pollMs: number;
}) => {
  const { now } = useStudio();
  const [, tick] = useState(0);
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => tick((n) => n + 1), pollMs);
    return () => clearInterval(timer);
  }, [live, pollMs]);
  const stale = live && isStale(report.asOf, now(), pollMs);
  const age = Math.max(0, Date.parse(now()) - Date.parse(report.asOf));
  const only = overview.kind === "history" ? " (this run only)" : "";
  const verdict = report.feedback.verdict === "not_rated" ? null : report.feedback.verdict;

  return (
    <Card>
      <CardContent className="grid grid-cols-[minmax(0,1fr)] gap-4">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <p className="text-sm">
            <span
              className="rounded-md bg-muted px-1.5 py-0.5 text-xs font-medium"
              data-testid="scope-label"
            >
              {overview.kind === "history"
                ? `Completion history: ${overview.history.title}`
                : "This run"}
            </span>{" "}
            {overview.kind === "history" ? (
              <>
                <span data-testid="history-counts">{memberCountsText(overview.history)}</span> ·
                membership version{" "}
                <span data-testid="history-version">
                  {overview.history.current.membershipVersion}
                </span>{" "}
                · viewed from run <span className="font-mono">{scope.runId.slice(-8)}</span>
              </>
            ) : (
              <>
                <span className="font-mono">{scope.programId}</span> · run{" "}
                <span className="font-mono">{scope.runId.slice(-8)}</span> · started{" "}
                {when(run.startedAt)} ·{" "}
                <span data-testid="contributing-runs">contributing runs: 1 (this run)</span>
              </>
            )}
          </p>
          <div className="flex min-w-0 max-w-full flex-wrap items-center gap-1.5 text-xs">
            <span aria-hidden="true">Scope</span>
            <select
              aria-label="Scope"
              className={selectClass}
              value={scopeParam(overview)}
              onChange={(event) => onScope(event.target.value)}
            >
              <option value="run">This run</option>
              {report.completions.map((c) => (
                <option key={c.completionHistoryId} value={`history:${c.completionHistoryId}`}>
                  Completion history: {c.title}
                </option>
              ))}
            </select>
            <span className="text-muted-foreground">
              Completion histories: {report.completions.length}
            </span>
          </div>
        </div>

        {overview.kind === "run" && overview.note !== undefined ? (
          <p
            role="status"
            className="text-xs text-status-warning-foreground"
            data-testid="scope-note"
          >
            {overview.note}
          </p>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-2">
          <Group label={`Engine status${only}`}>
            <span>
              <StatusBadge status={run.status} />
            </span>
            <span className="text-xs text-muted-foreground">
              What Nightshift's own verification and integration concluded.
            </span>
          </Group>
          <Group label={`Human acceptance${only}`}>
            {isRunTerminal(run.status) ? (
              <RunVerdict scope={scope} run={run} />
            ) : (
              <>
                <AcceptanceState verdict={verdict} />
                <span className="text-xs text-muted-foreground">
                  A person can rate the run once it has ended.
                </span>
              </>
            )}
          </Group>
        </div>

        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span data-testid="as-of">As of {when(report.asOf)}</span>
          {live ? (
            <span className="inline-flex items-center gap-1 text-status-info-foreground">
              <Radio className="size-3.5 animate-pulse" aria-hidden="true" /> live
            </span>
          ) : null}
          {stale ? (
            <span
              className="inline-flex items-center gap-1 font-medium text-status-warning-foreground"
              data-testid="stale"
            >
              <Clock className="size-3.5" aria-hidden="true" /> Stale: figures are {spanText(age)}{" "}
              old, more than three polls behind
            </span>
          ) : null}
        </p>
      </CardContent>
    </Card>
  );
};
