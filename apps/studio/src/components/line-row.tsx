/**
 * A project's line, one row: its branch and head, its last composition, what
 * it parked, and its live run. The line is a run of its own program, so the row
 * links to runs, never to a plan.
 */
import type { LineParked, LineRange, ProgramContract, ProjectId, Run } from "@nightshift/contracts";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import { readable, shortSha } from "../lib/format.js";
import { useStudio } from "../studio.js";
import { StatusBadge } from "./status-badge.js";

/** Parked entries shown before the rest are collapsed. */
const PARKED_SHOWN = 3;

const runPath = (projectId: ProjectId, run: Run): string =>
  `/projects/${projectId}/programs/${run.programId}/runs/${run.runId}`;

const rangesOf = (ranges: readonly LineRange[], nameOf: (programId: string) => string): string =>
  [...new Set(ranges.map((range) => nameOf(range.program)))].join(", ");

const ParkedItem = ({
  entry,
  nameOf,
}: {
  readonly entry: LineParked;
  readonly nameOf: (programId: string) => string;
}) => (
  <li className="flex flex-wrap items-baseline gap-x-3" data-testid="line-parked">
    <span className="font-mono">{rangesOf(entry.ranges, nameOf)}</span>
    <span className="text-muted-foreground">{entry.reason}</span>
  </li>
);

export const LineRow = ({
  projectId,
  program,
  runs,
  nameOf,
  now,
}: {
  readonly projectId: ProjectId;
  readonly program: ProgramContract;
  readonly runs: readonly Run[];
  readonly nameOf: (programId: string) => string;
  readonly now: number;
}) => {
  const { stores } = useStudio();
  const branch = program.line?.branch;
  const [all, setAll] = useState(false);
  const line = useQuery({
    queryKey: ["line", projectId, branch],
    queryFn: () => stores.lines.get(projectId, branch as string),
    enabled: branch !== undefined,
  });
  const latest = [...runs].sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
  const live = latest !== undefined && (latest.status === "pending" || latest.status === "running");
  const record = line.data;
  const composition = record?.compositions.at(-1);
  const parked = record?.parked ?? [];
  const shown = all ? parked : parked.slice(0, PARKED_SHOWN);
  return (
    <li className="grid gap-1 border-b py-3 text-sm last:border-b-0" data-testid="line-row">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <span className="font-mono font-medium">{branch ?? program.programId}</span>
        <span className="text-muted-foreground">
          head{" "}
          <span className="font-mono text-foreground">
            {line.isPending && branch !== undefined ? "…" : shortSha(record?.head)}
          </span>
        </span>
        {latest === undefined ? (
          <span className="text-muted-foreground">no run yet</span>
        ) : (
          <>
            <Link
              to={runPath(projectId, latest)}
              className="underline-offset-4 hover:underline"
              title={live ? "The live run" : "The last run"}
            >
              {live ? "live run" : "last run"} {readable(latest.startedAt, now)}
            </Link>
            <StatusBadge status={latest.status} />
          </>
        )}
      </div>
      {line.isError ? (
        <p role="alert" className="text-destructive">
          Could not read the line: {String(line.error)}
        </p>
      ) : null}
      {composition === undefined ? (
        <p className="text-muted-foreground">No composition yet.</p>
      ) : (
        <p data-testid="line-composition">
          <span className="text-muted-foreground">last composition </span>
          <span className="font-mono">{shortSha(composition.commit)}</span>
          <span className="text-muted-foreground"> of </span>
          <span className="font-mono">{rangesOf(composition.ranges, nameOf)}</span>
          <span className="text-muted-foreground"> · verification </span>
          {composition.verification.outcome}
          <span className="text-muted-foreground"> · {readable(composition.composedAt, now)}</span>
        </p>
      )}
      {parked.length === 0 ? null : (
        <div>
          <p className="text-status-warning-foreground">
            {parked.length} parked range{parked.length === 1 ? "" : "s"}
          </p>
          <ul className="mt-1 grid gap-1 border-l pl-3" aria-label="Parked ranges">
            {shown.map((entry) => (
              <ParkedItem key={entry.compositionId} entry={entry} nameOf={nameOf} />
            ))}
          </ul>
          {parked.length > PARKED_SHOWN ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-muted-foreground"
              aria-expanded={all}
              onClick={() => setAll(!all)}
            >
              {all ? <ChevronDown /> : <ChevronRight />}
              {all ? "show fewer" : `show all ${parked.length}`}
            </Button>
          ) : null}
        </div>
      )}
    </li>
  );
};
