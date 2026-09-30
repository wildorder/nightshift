/**
 * Why a program exists (P14, D-P14-09): its user stories, shown before the
 * technical record. One story line on the Status tab and the program card; the
 * story in full on the Why tab; "Serves" at the top of every detail. The link
 * from a job, strand or decision to a story is `storiesOf` in `core`, derived
 * from the record, never written at run time (D-P14-03).
 */
import type { ProgramContract, Story } from "@nightshift/contracts";
import type { RunReport, RunScope, StoryStatus } from "@nightshift/core";
import { strandsOfDecision } from "@nightshift/core";
import { Quote } from "lucide-react";
import { Link } from "react-router";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "./status-badge.js";

const trimStop = (text: string): string => text.trim().replace(/\.\s*$/, "");

/** The story in one line: what changes, and for whom. */
export const StoryLine = ({
  story,
  met,
}: {
  readonly story: Story;
  /** Whether every criterion serving it is met; absent where nothing has run. */
  readonly met?: boolean;
}) => (
  <li className="flex items-baseline gap-2 text-sm" data-story={story.id}>
    {met === undefined ? null : <StatusBadge status={met ? "met" : "not met"} />}
    <span>
      <span className="mr-1.5 font-mono text-xs text-muted-foreground">{story.id}</span>
      <span className="font-medium">{trimStop(story.outcome)}</span>{" "}
      <span className="text-muted-foreground">
        for {story.who.charAt(0).toLowerCase() + story.who.slice(1)}
      </span>
    </span>
  </li>
);

/** Each story in a line, with whether it is done (the Status tab's first panel). */
export const StoryLines = ({ statuses }: { readonly statuses: readonly StoryStatus[] }) => (
  <ul className="grid gap-1.5" aria-label="Stories">
    {statuses.map(({ story, met }) => (
      <StoryLine key={story.id} story={story} met={met} />
    ))}
  </ul>
);

/** The first stories' outcomes on a program's card, and how many more there are. */
export const CardStories = ({
  program,
  shown = 2,
}: {
  readonly program: ProgramContract;
  readonly shown?: number;
}) => {
  const stories = program.stories ?? [];
  if (stories.length === 0) return null;
  const rest = stories.length - shown;
  return (
    <div className="grid gap-1">
      <ul className="grid gap-1" aria-label="Stories">
        {stories.slice(0, shown).map((story) => (
          <StoryLine key={story.id} story={story} />
        ))}
      </ul>
      {rest > 0 ? <p className="text-xs text-muted-foreground">+{rest} more</p> : null}
    </div>
  );
};

/** The human's own words, as they typed them in planning. */
export const Words = ({
  words,
  verified,
}: {
  readonly words: readonly string[];
  /** False when the program keeps no conversation to hold the quotes to (D-P14-04). */
  readonly verified: boolean;
}) =>
  words.length === 0 ? null : (
    <div className="grid gap-1.5">
      {words.map((line) => (
        <blockquote
          key={line}
          className="flex gap-2 border-l-2 border-primary pl-3 text-sm italic text-foreground"
        >
          <Quote className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
          <span>{line}</span>
        </blockquote>
      ))}
      {verified ? null : (
        <p className="text-xs text-muted-foreground">
          Unverified: this program keeps no planning conversation to check these against.
        </p>
      )}
    </div>
  );

const Field = ({ label, children }: { readonly label: string; readonly children: string }) => (
  <div className="grid gap-0.5 sm:grid-cols-[7rem_1fr] sm:gap-3">
    <dt className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{label}</dt>
    <dd className="text-sm">{children}</dd>
  </div>
);

/** A story in full, on the Why tab: who, today, afterwards, the words, and what serves it. */
export const StoryCard = ({
  status,
  report,
  scope,
}: {
  readonly status: StoryStatus;
  readonly report: RunReport;
  readonly scope: RunScope;
}) => {
  const { story, criteria, strands, met } = status;
  const strandNames = new Map((report.program.strands ?? []).map((s) => [s.id, s.name]));
  const serving = new Set(strands);
  const decisions = report.graph.filter((entry) =>
    strandsOfDecision(report, entry.decision).some((id) => serving.has(id)),
  );
  const runPath = `/projects/${scope.projectId}/programs/${scope.programId}/runs/${scope.runId}`;
  return (
    <article className="grid gap-4 rounded-lg border p-4" data-testid={`story-${story.id}`}>
      <header className="flex flex-wrap items-center gap-2">
        <StatusBadge status={met ? "met" : "not met"} />
        <span className="font-mono text-xs text-muted-foreground">{story.id}</span>
        <h3 className="text-base font-semibold">{trimStop(story.outcome)}</h3>
      </header>
      <dl className="grid gap-2">
        <Field label="Who">{story.who}</Field>
        <Field label="Today">{story.problem}</Field>
      </dl>
      <Words words={story.words ?? []} verified={report.program.keepConversation !== false} />
      <div className="grid gap-1">
        <h4 className="text-sm font-semibold">Checked by</h4>
        <ul className="grid gap-1 text-sm">
          {criteria.map((c) => (
            <li key={c.id} className="flex flex-wrap items-baseline gap-2">
              <StatusBadge status={c.met ? "met" : "not met"} />
              <span className="font-medium">{c.id}</span>
              <span className="text-muted-foreground">{c.outcome}</span>
            </li>
          ))}
        </ul>
      </div>
      <div className="flex flex-wrap items-baseline gap-2 text-sm">
        <h4 className="font-semibold">Built by</h4>
        {strands.length === 0 ? (
          <span className="text-muted-foreground">no strand</span>
        ) : (
          strands.map((id) => (
            <Badge key={id} variant="outline">
              {id} {strandNames.get(id) ?? ""}
            </Badge>
          ))
        )}
      </div>
      <div className="grid gap-1">
        <h4 className="text-sm font-semibold">Decisions behind it</h4>
        {decisions.length === 0 ? (
          <p className="text-sm text-muted-foreground">None recorded.</p>
        ) : (
          <ul className="grid gap-1 text-sm">
            {decisions.map(({ decision }) => (
              <li key={decision.decisionId}>
                <Link to={`${runPath}/decisions/${decision.decisionId}`} className="underline">
                  {decision.choice}
                </Link>
                <span className="text-muted-foreground"> — {decision.context}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </article>
  );
};

/** What a job, strand or decision is for, at the top of its detail. */
export const Serves = ({ stories }: { readonly stories: readonly Story[] }) =>
  stories.length === 0 ? null : (
    <section className="grid gap-2 rounded-md bg-muted/50 p-3" aria-label="Serves">
      <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        Serves
      </h3>
      <ul className="grid gap-2">
        {stories.map((story) => (
          <li key={story.id} className="grid gap-0.5 text-sm">
            <span>
              <span className="font-mono text-xs text-muted-foreground">{story.id}</span>{" "}
              <span className="font-medium">{trimStop(story.outcome)}</span>
            </span>
            <span className="text-muted-foreground">
              {story.who}. Today: {story.problem}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
