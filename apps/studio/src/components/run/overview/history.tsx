/**
 * The Overview under a completion-history scope (D-05): the figures of the
 * whole outcome across its member runs, from the report's CompletionReport and
 * nothing of this run's own tiles. Estimates are labelled estimates: the model
 * figure is API-equivalent, the machine figure is separate, and their sum is a
 * lower bound whenever a member is missing, never a bill. An unrated run is
 * counted as neither worked nor did not work, and every share names its
 * denominator.
 */
import type { ProgramId, RunId } from "@nightshift/contracts";
import type {
  CompletionFigures,
  CompletionMemberReport,
  CompletionReport,
  RunReport,
  RunScope,
} from "@nightshift/core";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { when } from "../../../lib/format.js";
import { compactCount, dollarsText, NOT_OBSERVED, spanText } from "../../../lib/overview.js";
import { useStudio } from "../../../studio.js";
import { StatusBadge } from "../../status-badge.js";
import { AcceptanceState } from "../verdict.js";
import { HistoryReworkBars } from "./bars.js";
import { HistoryEvidenceSheet } from "./evidence-sheet.js";
import {
  acrossText,
  hasObservedTime,
  memberKey,
  memberOperations,
  memberTimeText,
  missingMembers,
  unionText,
} from "./history-figures.js";
import { memberRunHref } from "./links.js";
import type { HistoryTileId } from "./selection.js";

const keyOf = memberKey;

const seconds = (value: number | undefined, absent: string): string =>
  value === undefined ? absent : spanText(value * 1000);

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

const Line = ({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}) => (
  <span className="block text-xs text-muted-foreground">
    <span className="font-medium text-foreground">{label}</span> {children}
  </span>
);

const Big = ({ children }: { readonly children: React.ReactNode }) => (
  <span className="text-2xl leading-tight font-semibold tabular-nums">{children}</span>
);

const HistoryTile = ({
  id,
  label,
  selected,
  onSelect,
  children,
}: {
  readonly id: HistoryTileId;
  readonly label: string;
  readonly selected: boolean;
  readonly onSelect: (id: HistoryTileId) => void;
  readonly children: React.ReactNode;
}) => (
  <button
    type="button"
    data-history-tile={id}
    aria-haspopup="dialog"
    aria-pressed={selected}
    onClick={() => onSelect(id)}
    className="flex min-w-0 flex-col items-stretch gap-2 rounded-lg border border-border bg-card p-4 text-left text-card-foreground shadow-xs outline-none hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring aria-pressed:border-ring"
  >
    <span className="text-sm font-medium text-muted-foreground">{label}</span>
    <span className="sr-only">
      Open the definition, coverage and member runs behind this figure.
    </span>
    {children}
  </button>
);

const verdictOf = (member: CompletionMemberReport) =>
  member.verdict === "not_rated" ? null : member.verdict;

const nameList = (keys: readonly string[]) =>
  keys.map((key, i) => (
    <span key={key}>
      {i === 0 ? "" : ", "}
      <code className="font-mono break-all">{key}</code>
    </span>
  ));

const priceBasisText = (basis: {
  model: string;
  source?: string;
  version?: string;
  incomplete: boolean;
}): string =>
  `${basis.model}: ${basis.source ?? "price source not recorded"}${basis.version === undefined ? "" : ` ${basis.version}`}${basis.incomplete ? " (some usage unvalued)" : ""}`;

/** Tokens, the two estimates and their sum, with the coverage each stands on. */
const Consumption = ({ figures }: { readonly figures: CompletionFigures }) => {
  const { resources, combined, infrastructure } = figures;
  const total = figures.measuredMembers + figures.unmeasuredMembers;
  const machine = infrastructure?.usd ?? combined?.infrastructure;
  return (
    <>
      {resources === undefined ? (
        <Big>{NOT_OBSERVED}</Big>
      ) : (
        <span className="grid gap-1">
          <span className="flex items-baseline gap-2">
            <Big>{compactCount(resources.tokens.input)}</Big>
            <span className="text-xs text-muted-foreground">input tokens (incl. cache)</span>
          </span>
          <span className="flex items-baseline gap-2">
            <Big>{compactCount(resources.tokens.output)}</Big>
            <span className="text-xs text-muted-foreground">output tokens</span>
          </span>
        </span>
      )}
      <Line label="Token coverage:">
        measured {figures.measuredMembers} of {total} members
      </Line>
      {figures.unavailable === undefined ? null : (
        <Line label="Unavailable (measurement could not be read):">
          {nameList(figures.unavailable)}
        </Line>
      )}
      <span className="block border-t border-border pt-2" />
      <Line label="Model API-equivalent estimate:">
        {dollarsText(combined?.model)}
        {combined?.model === undefined ? "" : " · from the price list, not a bill"}
      </Line>
      <Line label="Machine estimate:">
        {machine === undefined
          ? `${NOT_OBSERVED} (no member has a recorded machine)`
          : `${dollarsText(machine)} · ${infrastructure?.members ?? "some"} of ${total} members had a machine${
              infrastructure === undefined ? "" : `, ${infrastructure.withoutMachine} without`
            }`}
      </Line>
      <Line label="Combined estimate:">
        {combined === undefined ? (
          NOT_OBSERVED
        ) : (
          <>
            {dollarsText(combined.usd)}
            {combined.lowerBound
              ? " · lower bound: something is missing, so the true figure is higher"
              : " · every member measured"}
            . Model measured {combined.coverage.measuredMembers} of{" "}
            {combined.coverage.measuredMembers + combined.coverage.unmeasuredMembers} members
            {combined.coverage.estimateIncomplete > 0
              ? `, ${combined.coverage.estimateIncomplete} with unvalued usage`
              : ""}
            ; {combined.coverage.membersWithoutMachine} without a machine
            {combined.coverage.attemptsWithoutEstimate === undefined
              ? "; attempts without an estimate: not recorded"
              : `; ${combined.coverage.attemptsWithoutEstimate} attempts without an estimate`}
            . An estimate, never a bill.
          </>
        )}
      </Line>
      {combined === undefined || combined.priceBases.length === 0 ? null : (
        <Line label="Price provenance:">{combined.priceBases.map(priceBasisText).join("; ")}</Line>
      )}
    </>
  );
};

const Rating = ({ coverage }: { readonly coverage: CompletionReport["coverage"] }) => (
  <>
    <Big>
      {coverage.rated} of {coverage.eligible} rated
    </Big>
    <Line label="Worked:">
      {coverage.positive} of {coverage.rated} rated
    </Line>
    <Line label="Did not work:">
      {coverage.negative} of {coverage.rated} rated
    </Line>
    <Line label="Not rated:">
      {coverage.unrated} of {coverage.eligible} eligible, counted as neither
    </Line>
  </>
);

const Times = ({ figures }: { readonly figures: CompletionFigures }) => (
  <>
    <Big>{seconds(figures.leadTimeSeconds, "no worked verdict yet")}</Big>
    <Line label="Lead time:">
      earliest member start to the earliest “worked” verdict, including waits and the delay in
      rating
    </Line>
    <Line label="Run completion time:">
      {seconds(figures.runCompletionSeconds, NOT_OBSERVED)} · start to the accepted run's end
    </Line>
    <Line label="Active time:">
      {seconds(figures.activeSeconds, NOT_OBSERVED)} · union of member run intervals, gaps not
      counted
    </Line>
  </>
);

const Delivered = ({ history }: { readonly history: CompletionReport }) => {
  const d = history.current.delivery;
  if (d === undefined) {
    return (
      <>
        <Big>{NOT_OBSERVED}</Big>
        <Line label="Coverage:">
          {acrossText(history, history.current.evidenceCoverage)}; no member run left delivery
          evidence
        </Line>
      </>
    );
  }
  return (
    <>
      {d.denominator === 0 ? (
        <Big>none settled yet</Big>
      ) : (
        <Big>
          {d.succeededFirstAttempt} of {d.denominator}
        </Big>
      )}
      <Line label="First-attempt success:">
        {d.denominator === 0
          ? "no work item has settled"
          : `${d.succeededFirstAttempt} of ${d.denominator} unique work items`}
      </Line>
      <Line label="Unfinished:">{d.unfinished} work items, not in the denominator</Line>
      <Line label="Coverage:">{acrossText(history, d.coverage)}</Line>
      {d.carriedFromOutside === 0 ? null : (
        <Line label="Carried from outside:">
          {d.carriedFromOutside} strand{d.carriedFromOutside === 1 ? "" : "s"} built by a run that
          is not a member, not counted
        </Line>
      )}
    </>
  );
};

const Repair = ({ history }: { readonly history: CompletionReport }) => {
  const { rework, review } = history.current;
  if (rework === undefined || review === undefined) {
    return (
      <>
        <Big>{NOT_OBSERVED}</Big>
        <Line label="Coverage:">
          {acrossText(history, history.current.evidenceCoverage)}; no member run left rework or
          review evidence
        </Line>
      </>
    );
  }
  const causes = [...rework.byCause]
    .sort((a, b) => b.attempts - a.attempts)
    .slice(0, 3)
    .map((row) => `${row.kind.replaceAll("_", " ")} ${row.attempts}`);
  const d = review.dispositions;
  return (
    <>
      <Big>
        {rework.attempts} rework attempt{rework.attempts === 1 ? "" : "s"}
      </Big>
      <Line label="Top causes:">
        {causes.length === 0 ? "none" : causes.join(", ")}
        {rework.unknownCause > 0 ? `; ${rework.unknownCause} with no recorded cause` : ""}
      </Line>
      <Line label="Examiner dispositions:">
        upheld {d.upheld}, overturned {d.overturned}, risk accepted {d.risk_accepted}
      </Line>
      <Line label="Findings:">{review.uniqueFindings} unique, summed over member runs</Line>
      <Line label="Coverage:">{acrossText(history, review.coverage)}</Line>
      <Line label="Read with care:">association with rework is not causation</Line>
    </>
  );
};

export const HistoryTiles = ({
  history,
  selected,
  onSelect,
}: {
  readonly history: CompletionReport;
  readonly selected?: HistoryTileId | undefined;
  readonly onSelect: (id: HistoryTileId) => void;
}) => (
  <fieldset
    className="m-0 grid min-w-0 gap-3 border-0 p-0 sm:grid-cols-2 xl:grid-cols-3"
    aria-label="Headline summaries for this completion history"
  >
    <HistoryTile
      id="delivered"
      label="Delivered"
      selected={selected === "delivered"}
      onSelect={onSelect}
    >
      <Delivered history={history} />
    </HistoryTile>
    <HistoryTile
      id="time"
      label="Time to a working result"
      selected={selected === "time"}
      onSelect={onSelect}
    >
      <Times figures={history.current} />
    </HistoryTile>
    <HistoryTile
      id="consumed"
      label="Consumed across the members"
      selected={selected === "consumed"}
      onSelect={onSelect}
    >
      <Consumption figures={history.current} />
    </HistoryTile>
    <HistoryTile
      id="review"
      label="Repair and review"
      selected={selected === "review"}
      onSelect={onSelect}
    >
      <Repair history={history} />
    </HistoryTile>
    <HistoryTile
      id="rating"
      label="Did it work"
      selected={selected === "rating"}
      onSelect={onSelect}
    >
      <Rating coverage={history.coverage} />
    </HistoryTile>
  </fieldset>
);

const MemberRow = ({
  member,
  scope,
  historyId,
}: {
  readonly member: CompletionMemberReport;
  readonly scope: RunScope;
  readonly historyId: string;
}) => (
  <tr className="border-t border-border align-top">
    <td className="py-1.5 pr-3">{member.role}</td>
    <td className="py-1.5 pr-3">
      <Link className="font-mono underline" to={memberRunHref(scope, member, historyId)}>
        run {member.runId.slice(-8)}
      </Link>{" "}
      <span className="text-xs text-muted-foreground">
        in <span className="font-mono">{member.programId}</span>
        {member.programId === scope.programId && member.runId === scope.runId ? " (this run)" : ""}
      </span>
    </td>
    <td className="py-1.5 pr-3">
      {member.status === undefined ? (
        <span className="text-muted-foreground">not readable</span>
      ) : (
        <StatusBadge status={member.status} />
      )}
    </td>
    <td className="py-1.5 pr-3">
      <AcceptanceState verdict={verdictOf(member)} />
    </td>
    <td className="py-1.5 tabular-nums">{member.carriedStrands}</td>
  </tr>
);

const MembersTable = ({
  label,
  members,
  scope,
  historyId,
}: {
  readonly label: string;
  readonly members: readonly CompletionMemberReport[];
  readonly scope: RunScope;
  readonly historyId: string;
}) => (
  <div className="overflow-x-auto">
    <table aria-label={label} className="w-full min-w-[32rem] text-sm">
      <thead className="text-left text-xs text-muted-foreground">
        <tr>
          <th className="pr-3 pb-1 font-medium">Role</th>
          <th className="pr-3 pb-1 font-medium">Run</th>
          <th className="pr-3 pb-1 font-medium">Status</th>
          <th className="pr-3 pb-1 font-medium">Verdict</th>
          <th className="pb-1 font-medium">Carried strands</th>
        </tr>
      </thead>
      <tbody>
        {members.map((member) => (
          <MemberRow key={keyOf(member)} member={member} scope={scope} historyId={historyId} />
        ))}
      </tbody>
    </table>
  </div>
);

interface MemberSpan {
  readonly member: CompletionMemberReport;
  readonly from?: number;
  readonly to?: number;
  readonly open: boolean;
}

/** The member runs as intervals, start to end, one row per run; an open run is drawn to as-of. */
const MemberTimeline = ({
  history,
  report,
  scope,
}: {
  readonly history: CompletionReport;
  readonly report: RunReport;
  readonly scope: RunScope;
}) => {
  const { stores } = useStudio();
  const keys = history.members.map(keyOf).join(",");
  const runs = useQuery({
    // Under the run-status prefix so the live poll refreshes the intervals.
    queryKey: ["run-status", scope.runId, "history-member-runs", scope.projectId, keys],
    queryFn: () =>
      Promise.all(
        history.members.map((m) =>
          stores.runs.get(
            { projectId: scope.projectId, programId: m.programId as ProgramId },
            m.runId as RunId,
          ),
        ),
      ),
  });
  if (runs.isPending)
    return <p className="text-sm text-muted-foreground">Reading the member runs…</p>;
  if (runs.isError) {
    return (
      <p role="alert" className="text-sm">
        Could not read the member runs: {String(runs.error)}
      </p>
    );
  }
  const asOf = Date.parse(report.asOf);
  const spans: MemberSpan[] = history.members.map((member, i) => {
    const run = runs.data[i];
    if (run === undefined) return { member, open: false };
    const from = Date.parse(run.startedAt);
    const open = run.endedAt === undefined;
    return { member, from, to: open ? asOf : Date.parse(run.endedAt as string), open };
  });
  const drawn = spans.filter((s) => s.from !== undefined && s.to !== undefined);
  const lo = Math.min(...drawn.map((s) => s.from as number));
  const hi = Math.max(...drawn.map((s) => s.to as number));
  const extent = Math.max(1, hi - lo);
  return (
    <>
      <p className="sr-only" data-testid="history-timeline-summary">
        {drawn.length} of {spans.length} member runs have an interval, from{" "}
        {drawn.length === 0 ? NOT_OBSERVED : when(new Date(lo).toISOString())} to{" "}
        {drawn.length === 0 ? NOT_OBSERVED : when(new Date(hi).toISOString())}. Each run's start,
        end and span are listed below.
      </p>
      <ol className="grid gap-2" data-testid="history-timeline" aria-label="Member runs over time">
        {spans.map((s) => (
          <li key={keyOf(s.member)} className="grid gap-1 text-xs">
            <span>
              <span className="font-medium">{s.member.role}</span>{" "}
              <span className="font-mono">run {s.member.runId.slice(-8)}</span>{" "}
              <span className="text-muted-foreground">
                {s.from === undefined || s.to === undefined
                  ? "not readable, no interval"
                  : `${when(new Date(s.from).toISOString())} to ${s.open ? "still open (drawn to as-of)" : when(new Date(s.to).toISOString())} · ${spanText(s.to - s.from)}`}
              </span>
            </span>
            <span className="relative block h-3 rounded-sm bg-muted" aria-hidden="true">
              {s.from === undefined || s.to === undefined ? null : (
                <span
                  className={`absolute inset-y-0 rounded-sm ${s.open ? "bg-chart-2/40 border border-chart-2" : "bg-chart-1"}`}
                  style={{
                    left: `${((s.from - lo) / extent) * 100}%`,
                    width: `max(2px, ${((s.to - s.from) / extent) * 100}%)`,
                  }}
                />
              )}
            </span>
          </li>
        ))}
      </ol>
    </>
  );
};

/** Each member's elapsed time and its overlapping wait/queue/integration/examination unions. */
const MemberTimeTable = ({
  history,
  scope,
}: {
  readonly history: CompletionReport;
  readonly scope: RunScope;
}) => {
  const ops = history.current.operations;
  const span = (ms: number | undefined) => (ms === undefined ? NOT_OBSERVED : spanText(ms));
  const anyObserved = (ops?.members ?? []).some(hasObservedTime);
  const summedText = (ms: number | undefined) => (anyObserved ? span(ms) : NOT_OBSERVED);
  return (
    <div className="grid gap-2" data-testid="history-time-table">
      <p className="text-xs text-muted-foreground">
        Summed over member runs, overlapping; not elapsed. Two runs that waited at the same time
        both count it, so these do not add up to the history's elapsed time.
      </p>
      <p className="sr-only" data-testid="history-time-text">
        {history.members
          .map(
            (member) =>
              `Run ${member.runId.slice(-8)} (${member.role}): ${memberTimeText(history, member)}.`,
          )
          .join(" ")}{" "}
        {ops === undefined
          ? `Summed over member runs: ${NOT_OBSERVED}.`
          : `Summed over member runs, overlapping, not elapsed: waiting ${summedText(ops.summed.wait)}, queue ${summedText(ops.summed.queue)}, integration ${summedText(ops.summed.integration)}, examination ${summedText(ops.summed.examination)}, work ${summedText(ops.summed.summedWorkMs)}; ${acrossText(history, ops.coverage)}.`}
      </p>
      <p className="text-xs text-muted-foreground sm:hidden">
        Scroll the table sideways for every column.
      </p>
      <section
        className="overflow-x-auto rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a keyboard user must be able to scroll the table
        tabIndex={0}
        aria-label="Time by run, scrollable"
      >
        <table
          aria-label="Elapsed and summed bottleneck time by run"
          className="w-full min-w-[34rem] text-sm"
        >
          <thead className="text-left text-xs text-muted-foreground">
            <tr>
              <th className="pr-3 pb-1 font-medium">Run</th>
              <th className="pr-3 pb-1 font-medium">Elapsed</th>
              <th className="pr-3 pb-1 font-medium">Waiting</th>
              <th className="pr-3 pb-1 font-medium">Queue</th>
              <th className="pr-3 pb-1 font-medium">Integration</th>
              <th className="pb-1 font-medium">Examination</th>
            </tr>
          </thead>
          <tbody className="tabular-nums">
            {history.members.map((member) => {
              const m = memberOperations(history, member);
              return (
                <tr key={keyOf(member)} className="border-t border-border">
                  <td className="py-1.5 pr-3">
                    <Link
                      className="font-mono underline"
                      to={memberRunHref(scope, member, history.completionHistoryId)}
                    >
                      run {member.runId.slice(-8)}
                    </Link>{" "}
                    <span className="text-xs text-muted-foreground">{member.role}</span>
                  </td>
                  <td className="py-1.5 pr-3">
                    {m !== undefined && m.elapsedMs === undefined && m.endedAt === undefined
                      ? "still running"
                      : span(m?.elapsedMs)}
                  </td>
                  <td className="py-1.5 pr-3">{unionText(m, "wait")}</td>
                  <td className="py-1.5 pr-3">{unionText(m, "queue")}</td>
                  <td className="py-1.5 pr-3">{unionText(m, "integration")}</td>
                  <td className="py-1.5">{unionText(m, "examination")}</td>
                </tr>
              );
            })}
            <tr className="border-t border-border font-medium">
              <td className="py-1.5 pr-3">Summed over runs</td>
              <td className="py-1.5 pr-3 text-muted-foreground">not summed</td>
              <td className="py-1.5 pr-3">{summedText(ops?.summed.wait)}</td>
              <td className="py-1.5 pr-3">{summedText(ops?.summed.queue)}</td>
              <td className="py-1.5 pr-3">{summedText(ops?.summed.integration)}</td>
              <td className="py-1.5">{summedText(ops?.summed.examination)}</td>
            </tr>
          </tbody>
        </table>
      </section>
      <p className="text-xs text-muted-foreground">
        {ops === undefined
          ? `${NOT_OBSERVED}: no member run left timing evidence.`
          : `Summed work ${summedText(ops.summed.summedWorkMs)} (overlapping). ${acrossText(history, ops.coverage)}.`}
        {missingMembers(history, ops?.coverage ?? history.current.evidenceCoverage).map((m) => (
          <span key={m.key}>
            {" "}
            <code className="font-mono break-all">{m.key}</code>: {NOT_OBSERVED} ({m.why}).
          </span>
        ))}
      </p>
    </div>
  );
};

const FigureList = ({ figures }: { readonly figures: CompletionFigures }) => {
  const total = figures.measuredMembers + figures.unmeasuredMembers;
  return (
    <ul className="grid gap-0.5 text-xs">
      <li>Lead time: {seconds(figures.leadTimeSeconds, NOT_OBSERVED)}</li>
      <li>Run completion time: {seconds(figures.runCompletionSeconds, NOT_OBSERVED)}</li>
      <li>Active time: {seconds(figures.activeSeconds, NOT_OBSERVED)}</li>
      <li>
        Tokens: {compactCount(figures.resources?.tokens.input)} input,{" "}
        {compactCount(figures.resources?.tokens.output)} output · measured {figures.measuredMembers}{" "}
        of {total} members
      </li>
      <li>
        Combined estimate:{" "}
        {figures.combined === undefined
          ? NOT_OBSERVED
          : `${dollarsText(figures.combined.usd)}${figures.combined.lowerBound ? " (lower bound)" : ""}${
              figures.combined.coverage.attemptsWithoutEstimate === undefined
                ? "; attempts without an estimate: not recorded"
                : figures.combined.coverage.attemptsWithoutEstimate > 0
                  ? `; ${figures.combined.coverage.attemptsWithoutEstimate} attempts without an estimate`
                  : ""
            }`}
      </li>
    </ul>
  );
};

export const HistoryBody = ({
  history,
  report,
  scope,
}: {
  readonly history: CompletionReport;
  readonly report: RunReport;
  readonly scope: RunScope;
}) => {
  const [tile, setTile] = useState<HistoryTileId | undefined>(undefined);
  return (
    <>
      <HistoryTiles history={history} selected={tile} onSelect={setTile} />
      <HistoryEvidenceSheet
        tile={tile}
        history={history}
        report={report}
        scope={scope}
        onClose={() => setTile(undefined)}
      />

      <Section title="Member runs">
        <MembersTable
          label="Member runs"
          members={history.members}
          scope={scope}
          historyId={history.completionHistoryId}
        />
      </Section>

      <Section title="Rework by cause">
        {history.current.rework === undefined ? (
          <p className="text-sm text-muted-foreground" data-testid="history-rework-empty">
            {NOT_OBSERVED}: {acrossText(history, history.current.evidenceCoverage)} left rework
            evidence.
          </p>
        ) : (
          <>
            <p className="sr-only">
              Rework attempts by cause across the member runs, in counts of attempts. Each attempt
              is counted once. Show as text gives the same figures as a table.
            </p>
            <HistoryReworkBars rework={history.current.rework} onSelect={() => setTile("review")} />
          </>
        )}
      </Section>

      <Section title="Where the time went, by run">
        <MemberTimeline history={history} report={report} scope={scope} />
        <div className="mt-4 border-t border-border pt-3">
          <MemberTimeTable history={history} scope={scope} />
        </div>
      </Section>

      <Section title="Checkpoints">
        {history.checkpoints.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No checkpoint was recorded. The figures above are the current view and move as members
            change.
          </p>
        ) : (
          <ul className="grid gap-3" data-testid="history-checkpoints">
            {history.checkpoints.map((checkpoint) => (
              <li key={`${checkpoint.name}${checkpoint.recordedAt}`} className="grid gap-1 text-sm">
                <span>
                  <span className="font-medium">{checkpoint.name}</span>{" "}
                  <span className="text-xs text-muted-foreground">
                    recorded {when(checkpoint.recordedAt)} · membership version{" "}
                    {checkpoint.membershipVersion} · frozen, later changes do not rewrite it
                  </span>
                </span>
                <FigureList figures={checkpoint} />
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Later fixes">
        {history.laterFixes.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No member was added after the first checkpoint.
          </p>
        ) : (
          <>
            <p className="mb-2 text-xs text-muted-foreground">
              Members added after the first checkpoint was taken.
            </p>
            <MembersTable
              label="Later fixes"
              members={history.laterFixes}
              scope={scope}
              historyId={history.completionHistoryId}
            />
          </>
        )}
      </Section>
    </>
  );
};
