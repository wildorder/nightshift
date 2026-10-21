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
import { Link } from "react-router";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { when } from "../../../lib/format.js";
import { compactCount, dollarsText, NOT_OBSERVED, spanText } from "../../../lib/overview.js";
import { useStudio } from "../../../studio.js";
import { StatusBadge } from "../../status-badge.js";
import { AcceptanceState } from "../verdict.js";

const runHref = (scope: RunScope, member: { programId: string; runId: string }): string =>
  `/projects/${scope.projectId}/programs/${member.programId}/runs/${member.runId}`;

const keyOf = (member: { programId: string; runId: string }): string =>
  `${member.programId}/${member.runId}`;

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
  children,
}: {
  readonly id: string;
  readonly label: string;
  readonly children: React.ReactNode;
}) => (
  <div
    data-history-tile={id}
    className="flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-card p-4 text-card-foreground shadow-xs"
  >
    <h2 className="text-sm font-medium text-muted-foreground">{label}</h2>
    {children}
  </div>
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
            ; {combined.coverage.membersWithoutMachine} without a machine. An estimate, never a
            bill.
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

export const HistoryTiles = ({ history }: { readonly history: CompletionReport }) => (
  <fieldset
    className="m-0 grid min-w-0 gap-3 border-0 p-0 sm:grid-cols-2 xl:grid-cols-3"
    aria-label="Headline summaries for this completion history"
  >
    <HistoryTile id="time" label="Time to a working result">
      <Times figures={history.current} />
    </HistoryTile>
    <HistoryTile id="consumed" label="Consumed across the members">
      <Consumption figures={history.current} />
    </HistoryTile>
    <HistoryTile id="rating" label="Did it work">
      <Rating coverage={history.coverage} />
    </HistoryTile>
  </fieldset>
);

const MemberRow = ({
  member,
  scope,
}: {
  readonly member: CompletionMemberReport;
  readonly scope: RunScope;
}) => (
  <tr className="border-t border-border align-top">
    <td className="py-1.5 pr-3">{member.role}</td>
    <td className="py-1.5 pr-3">
      <Link className="font-mono underline" to={runHref(scope, member)}>
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
}: {
  readonly label: string;
  readonly members: readonly CompletionMemberReport[];
  readonly scope: RunScope;
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
          <MemberRow key={keyOf(member)} member={member} scope={scope} />
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
    queryKey: ["history-member-runs", scope.projectId, keys],
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
          : `${dollarsText(figures.combined.usd)}${figures.combined.lowerBound ? " (lower bound)" : ""}`}
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
}) => (
  <>
    <HistoryTiles history={history} />

    <Section title="Member runs">
      <MembersTable label="Member runs" members={history.members} scope={scope} />
    </Section>

    <Section title="Where the time went, by run">
      <MemberTimeline history={history} report={report} scope={scope} />
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
          <MembersTable label="Later fixes" members={history.laterFixes} scope={scope} />
        </>
      )}
    </Section>
  </>
);
