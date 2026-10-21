/**
 * The run's Overview (P20, US-05): what was delivered, how long it took, what it
 * consumed and what repair and review added, for this run. The top of the page
 * is four figures; the timeline and bars show where they came from; the sheet
 * and the collapsed sections hold the evidence. Selection, filter and open
 * sections are component state, and nothing here is keyed on data, so the
 * live poll refreshes the figures without losing the reader's place.
 */
import type { Run } from "@nightshift/contracts";
import type { RunReport, RunScope } from "@nightshift/core";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { groupAttempts, hasObservedOperations } from "../../../lib/overview.js";
import { useAttemptRows } from "../../../lib/overview-data.js";
import { ResourceBars, ReworkBars } from "./bars.js";
import { type AttemptFilterState, Details } from "./details.js";
import { EvidenceSheet } from "./evidence-sheet.js";
import { OverviewHeader } from "./header.js";
import { ReviewEvidence } from "./review.js";
import type { Selection } from "./selection.js";
import { Tiles } from "./tiles.js";
import { Timeline } from "./timeline.js";

const Section = ({
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

export const OverviewSkeleton = () => (
  <div className="grid gap-4" data-testid="overview-loading" aria-busy="true">
    <Skeleton className="h-28 w-full" />
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {[0, 1, 2, 3].map((n) => (
        <Skeleton key={n} className="h-40 w-full" />
      ))}
    </div>
    <Skeleton className="h-64 w-full" />
  </div>
);

export const OverviewError = ({
  error,
  onRetry,
}: {
  readonly error: unknown;
  readonly onRetry: () => void;
}) => (
  <div role="alert" className="grid gap-2 rounded-lg border border-border p-4 text-sm">
    <p>Could not build the overview: {String(error)}</p>
    <div>
      <Button type="button" variant="outline" size="sm" onClick={onRetry}>
        Retry
      </Button>
    </div>
  </div>
);

export const OverviewTab = ({
  run,
  report,
  scope,
  nodeLabels,
  live,
  pollMs,
}: {
  readonly run: Run;
  readonly report: RunReport;
  readonly scope: RunScope;
  readonly nodeLabels: ReadonlyMap<string, string>;
  readonly live: boolean;
  readonly pollMs: number;
}) => {
  const attempts = useAttemptRows(scope);
  const [selection, setSelection] = useState<Selection | undefined>(undefined);
  const [filter, setFilter] = useState<AttemptFilterState>({ role: "", model: "", half: "" });
  const rows = attempts.data?.rows;
  const select = (next: Selection) => setSelection(next);

  const missing: string[] = [];
  if (!hasObservedOperations(report.operations)) {
    missing.push(
      "This run recorded no lifecycle observations, so time by node, waiting, queueing and integration are not observed (shown as “not observed”, never 0).",
    );
  }
  if (rows?.length && rows.every((row) => row.measurementSummaryId === undefined)) {
    missing.push(
      "No attempt has a measurement summary: tokens come from each route's own usage record where it has one, and are “not observed” where it has none; there is no request evidence.",
    );
  } else if (rows !== undefined && rows.some((row) => row.coverage === "missing")) {
    missing.push(
      "Some attempts recorded neither a measurement summary nor route usage; their tokens and dollars are not observed.",
    );
  }
  if (report.infrastructure === undefined) {
    missing.push("No machine is recorded for this run, so the machine estimate is not observed.");
  }

  return (
    <div className="grid gap-4" data-testid="overview">
      <OverviewHeader run={run} report={report} scope={scope} live={live} pollMs={pollMs} />

      {missing.length === 0 ? null : (
        <aside
          className="rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground"
          aria-label="Missing evidence"
        >
          <p className="mb-1 font-medium text-foreground">What this run did not record</p>
          <ul className="list-disc pl-4">
            {missing.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </aside>
      )}

      {attempts.isError ? (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-sm">
          Could not read the attempts: {String(attempts.error)}
          <Button type="button" variant="outline" size="sm" onClick={() => void attempts.refetch()}>
            Retry
          </Button>
        </div>
      ) : null}

      <Tiles
        report={report}
        rows={rows}
        attemptsReady={!attempts.isPending}
        selected={selection?.key}
        onSelect={select}
      />

      <Section title="Where the time went">
        <Timeline
          report={report}
          nodeLabels={nodeLabels}
          selected={selection?.key}
          onSelect={select}
        />
      </Section>

      <Section title="What it consumed and what was reworked">
        <div className="grid gap-6 lg:grid-cols-3">
          {rows === undefined ? (
            <Skeleton className="h-40 w-full lg:col-span-2" />
          ) : (
            <div className="lg:col-span-2">
              <ResourceBars
                byRole={groupAttempts(rows, (row) => row.role, "role unknown")}
                byModel={groupAttempts(rows, (row) => row.model, "model unknown")}
                selected={selection?.key}
                onSelect={select}
              />
            </div>
          )}
          <ReworkBars report={report} selected={selection?.key} onSelect={select} />
        </div>
      </Section>

      <Section title="Review evidence">
        <ReviewEvidence report={report} scope={scope} nodeLabels={nodeLabels} />
      </Section>

      {rows === undefined ? null : (
        <Details
          report={report}
          rows={rows}
          scope={scope}
          nodeLabels={nodeLabels}
          filter={filter}
          onFilter={setFilter}
          window={{
            from: report.operations.startedAt,
            to: report.operations.endedAt ?? report.operations.asOf,
          }}
        />
      )}

      <EvidenceSheet
        selection={selection}
        report={report}
        rows={rows ?? []}
        scope={scope}
        nodeLabels={nodeLabels}
        onClose={() => setSelection(undefined)}
      />
    </div>
  );
};
