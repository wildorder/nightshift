/**
 * The evidence behind one headline summary or chart segment (P20, US-05): the
 * metric's definition as the program states it, the denominator and coverage
 * this run has, the sample size, and links to the attempts, findings, feedback
 * and artifacts it stands on. Resolved against the current report on every
 * render, so a refresh updates it in place.
 */
import {
  type AttemptRow,
  METRIC_DEFINITIONS,
  type RunReport,
  type RunScope,
} from "@nightshift/core";
import { Link } from "react-router";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { when } from "../../../lib/format.js";
import {
  clockText,
  compactCount,
  consumptionOf,
  dollarsText,
  elapsedOf,
  hasObservedOperations,
  NOT_OBSERVED,
  spanText,
  timelineOf,
  tokensCoverageText,
  valuedText,
  verdictText,
} from "../../../lib/overview.js";
import { ArtifactLink } from "../parts.js";
import { decisionHref, findingTexts, workHref } from "./links.js";
import type { Selection } from "./selection.js";

const rowsOf = (selection: Selection, rows: readonly AttemptRow[]): AttemptRow[] => {
  const scope = selection.scope;
  switch (scope.kind) {
    case "role":
      return rows.filter((row) => (row.role ?? "") === scope.value);
    case "model":
      return rows.filter((row) => row.model === scope.value);
    case "cause":
      return rows.filter((row) => row.purpose === "work" && row.attempt > 1);
    case "interval":
      return [];
    case "tile":
      switch (scope.tile) {
        case "delivered":
          return rows.filter((row) => row.purpose === "work");
        case "consumed":
          return [...rows];
        case "review":
          return rows.filter((row) => row.purpose !== "work" || row.attempt > 1);
        default:
          return [];
      }
  }
};

const List = ({ children }: { readonly children: React.ReactNode }) => (
  <ul className="grid gap-1.5 text-xs">{children}</ul>
);

export const EvidenceSheet = ({
  selection,
  report,
  rows,
  scope,
  nodeLabels,
  onClose,
}: {
  readonly selection: Selection | undefined;
  readonly report: RunReport;
  readonly rows: readonly AttemptRow[];
  readonly scope: RunScope;
  readonly nodeLabels: ReadonlyMap<string, string>;
  readonly onClose: () => void;
}) => {
  const labelOf = (nodeId: string): string => nodeLabels.get(nodeId) ?? nodeId.slice(-8);
  const shown = selection === undefined ? [] : rowsOf(selection, rows);
  const consumed = consumptionOf(shown);
  const timeline = timelineOf(report.operations);
  const sel = selection?.scope;
  const interval =
    sel?.kind === "interval" ? timeline.intervals.find((iv) => iv.id === sel.id) : undefined;
  const wantsIntervals = sel?.kind === "tile" && sel.tile === "time";
  const wantsFindings =
    (sel?.kind === "tile" && sel.tile === "review") ||
    (sel?.kind === "cause" && sel.value === "examination_findings");
  const wantsFeedback = sel?.kind === "tile" && sel.tile === "delivered";
  const first = report.delivery.firstAttempt;
  const elapsed = elapsedOf(report);
  const texts = findingTexts(report);
  const ledger = shown.filter((row) => row.ledgerArtifactIds.length > 0);

  const facts = (): { coverage: string[]; sample: string } => {
    if (selection === undefined || sel === undefined) return { coverage: [], sample: "" };
    if (sel.kind === "interval") {
      return {
        coverage: [
          hasObservedOperations(report.operations)
            ? "Observed from lifecycle records; an interval with no recorded end is drawn to the as-of time and is excluded from every union."
            : NOT_OBSERVED,
        ],
        sample: `1 interval of ${report.operations.operations.length} observed`,
      };
    }
    if (sel.kind === "cause") {
      const row =
        report.delivery.rework.byCause.find((candidate) => candidate.kind === sel.value) ??
        undefined;
      return {
        coverage: [
          `${row?.attempts ?? report.delivery.rework.unknownCause.attempts} rework attempt(s) name this cause${
            row === undefined || row.sharedAttempts === 0
              ? ""
              : `; ${row.sharedAttempts} also name another cause`
          }.`,
          "The listed attempts are every work attempt after the first; the report does not attribute a cause to a single row here.",
        ],
        sample: `${report.delivery.rework.attempts} rework attempts`,
      };
    }
    if (sel.kind === "role" || sel.kind === "model") {
      return {
        coverage: [tokensCoverageText(consumed)],
        sample: `${consumed.attempts} attempts`,
      };
    }
    switch (sel.tile) {
      case "delivered":
        return {
          coverage: [
            `${first.succeeded} of ${first.denominator} settled jobs succeeded on the first attempt; ${first.unfinished} unfinished jobs are not in the denominator.`,
            `Coverage: ${first.coverage}${first.reasons.length === 0 ? "" : ` — ${first.reasons.join("; ")}`}.`,
          ],
          sample: `${first.denominator} settled jobs of ${report.delivery.workItems} work items`,
        };
      case "time":
        return {
          coverage: [
            `Elapsed ${spanText(elapsed.ms)}${elapsed.live ? " so far (the run has not ended)" : ""}.`,
            hasObservedOperations(report.operations)
              ? `Waiting ${spanText(report.operations.unions.wait)} as a union of intervals, so overlapping waits count once.`
              : `${NOT_OBSERVED}: no lifecycle observations were recorded, so wait, queue and integration time are unknown.`,
          ],
          sample: `${report.operations.operations.length} observed intervals on ${report.operations.nodes.length} nodes`,
        };
      case "consumed": {
        const all = consumptionOf(rows);
        return {
          coverage: [
            `Tokens: ${tokensCoverageText(all)}.`,
            `API-equivalent estimate: ${dollarsText(all.estimatedUsd)} — ${valuedText(all.estimateValued, all.attempts, all.estimateIncomplete)}.`,
            `Provider-reported dollars, kept apart: ${dollarsText(all.reportedUsd)}${all.reportedUsd === undefined ? "" : ` for ${all.reportedValued} of ${all.attempts} attempts`}.`,
            `Machine estimate: ${report.infrastructure === undefined ? NOT_OBSERVED : dollarsText(report.infrastructure.components.total.usd)}${report.infrastructure === undefined ? "" : ` — ${report.infrastructure.components.total.basis}`}`,
          ],
          sample: `${all.attempts} attempts`,
        };
      }
      case "review":
        return {
          coverage: [
            `${report.delivery.rework.attempts} rework attempts; ${report.review.findings.length} unique findings.`,
            report.review.dispositions.note,
          ],
          sample: `${report.review.findings.length} unique findings, ${report.review.coverage.examinations.total} examinations`,
        };
    }
  };
  const { coverage, sample } = facts();

  return (
    <Sheet open={selection !== undefined} onOpenChange={(open) => (open ? undefined : onClose())}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>{selection?.title ?? "Evidence"}</SheetTitle>
          <SheetDescription>
            What this figure means, what it is measured over, and the records behind it.
          </SheetDescription>
        </SheetHeader>
        {selection === undefined ? null : (
          <div className="grid gap-5 px-4 pb-6 text-sm">
            {selection.metrics.map((id) => {
              const definition = METRIC_DEFINITIONS[id];
              return (
                <section
                  key={id}
                  className="grid gap-1"
                  aria-label={`Definition: ${definition.label}`}
                >
                  <h3 className="font-medium">{definition.label}</h3>
                  <p>{definition.definition}</p>
                  <p className="text-muted-foreground">
                    <span className="font-medium text-foreground">Denominator and coverage:</span>{" "}
                    {definition.denominator}
                  </p>
                </section>
              );
            })}

            <section className="grid gap-1" aria-label="In this run">
              <h3 className="font-medium">In this run</h3>
              {coverage.map((line) => (
                <p key={line}>{line}</p>
              ))}
              <p>
                <span className="font-medium">Sample size:</span> {sample}
              </p>
            </section>

            {interval === undefined ? null : (
              <section className="grid gap-1" aria-label="Interval">
                <h3 className="font-medium">Interval</h3>
                <p>
                  {labelOf(interval.nodeId)} · {interval.phase} · {clockText(interval.startedAt)} to{" "}
                  {interval.open ? "still open" : clockText(interval.endedAt)}
                  {interval.durationMs === undefined ? "" : ` · ${spanText(interval.durationMs)}`}
                </p>
                <p>
                  Blockers: {interval.blockers.length === 0 ? "none" : interval.blockers.join(", ")}
                </p>
                <Link className="underline" to={workHref(scope, interval.nodeId)}>
                  Open {labelOf(interval.nodeId)} in the Work tab
                </Link>
              </section>
            )}

            {!wantsIntervals ? null : (
              <section className="grid gap-1" aria-label="Waiting intervals">
                <h3 className="font-medium">Waiting intervals</h3>
                {timeline.intervals.filter((iv) => iv.group === "wait").length === 0 ? (
                  <p className="text-muted-foreground">None observed.</p>
                ) : (
                  <List>
                    {timeline.intervals
                      .filter((iv) => iv.group === "wait")
                      .map((iv) => (
                        <li key={iv.id}>
                          <Link className="underline" to={workHref(scope, iv.nodeId)}>
                            {labelOf(iv.nodeId)}
                          </Link>{" "}
                          waited{" "}
                          {iv.durationMs === undefined ? NOT_OBSERVED : spanText(iv.durationMs)}
                          {iv.blockers.length === 0 ? "" : ` on ${iv.blockers.join(", ")}`}
                        </li>
                      ))}
                  </List>
                )}
              </section>
            )}

            {shown.length === 0 ? null : (
              <section className="grid gap-1" aria-label="Attempts">
                <h3 className="font-medium">Attempts ({shown.length})</h3>
                <List>
                  {shown.map((row) => (
                    <li
                      key={`${row.nodeId}/${row.routingDecisionId ?? "root"}/${row.measurementSummaryId ?? ""}`}
                    >
                      <Link className="underline" to={workHref(scope, row.nodeId)}>
                        {labelOf(row.nodeId)}
                      </Link>{" "}
                      · {row.role ?? "unknown role"} · {row.model} · attempt {row.attempt}
                      {row.purpose === "work" ? "" : ` (${row.purpose})`} ·{" "}
                      {row.outcome ?? NOT_OBSERVED} · {compactCount(row.resources.tokens.input)} in
                      / {compactCount(row.resources.tokens.output)} out · {row.coverage}
                    </li>
                  ))}
                </List>
              </section>
            )}

            {!wantsFindings ? null : (
              <section className="grid gap-1" aria-label="Findings">
                <h3 className="font-medium">Findings ({report.review.findings.length})</h3>
                {report.review.findings.length === 0 ? (
                  <p className="text-muted-foreground">None raised.</p>
                ) : (
                  <List>
                    {report.review.findings.map((finding) => {
                      const head = finding.occurrences[0];
                      const text =
                        head === undefined
                          ? undefined
                          : texts.get(`${head.examinationId}\u0000${head.findingId}`);
                      return (
                        <li key={`${finding.nodeId}/${head?.examinationId}/${head?.findingId}`}>
                          <b>{finding.severity}</b> {text?.summary ?? "(text not on the report)"} —{" "}
                          {finding.latest.replace("_", " ")} ·{" "}
                          <Link className="underline" to={workHref(scope, finding.nodeId)}>
                            {labelOf(finding.nodeId)}
                          </Link>
                          {finding.rulings.map((ruling) =>
                            ruling.decisionId === undefined ? null : (
                              <span key={ruling.decisionId}>
                                {" · "}
                                <Link
                                  className="underline"
                                  to={decisionHref(scope, ruling.decisionId)}
                                >
                                  decision {ruling.decisionId.slice(-8)}
                                </Link>
                              </span>
                            ),
                          )}
                        </li>
                      );
                    })}
                  </List>
                )}
              </section>
            )}

            {!wantsFeedback ? null : (
              <section className="grid gap-1" aria-label="Human verdict">
                <h3 className="font-medium">Human verdict</h3>
                <p>
                  {verdictText(report.feedback.verdict)}
                  {report.feedback.by === undefined ? "" : ` by ${report.feedback.by}`}
                  {report.feedback.recordedAt === undefined
                    ? ""
                    : ` at ${when(report.feedback.recordedAt)}`}
                  {report.feedback.revisions > 0
                    ? ` · ${report.feedback.revisions} revision(s)`
                    : ""}
                </p>
                <p className="text-muted-foreground">
                  Rated in this program: {report.feedbackCoverage.rated} of{" "}
                  {report.feedbackCoverage.eligible} ended runs. Acceptance never replaces
                  verification.
                </p>
              </section>
            )}

            {ledger.length === 0 ? null : (
              <section className="grid gap-1" aria-label="Request evidence">
                <h3 className="font-medium">Request evidence</h3>
                <List>
                  {ledger.map((row) => (
                    <li
                      key={`${row.nodeId}/${row.measurementSummaryId}`}
                      className="flex flex-wrap gap-2"
                    >
                      <span>
                        {labelOf(row.nodeId)} · attempt {row.attempt}:
                      </span>
                      {row.ledgerArtifactIds.map((id, index) => (
                        <ArtifactLink
                          key={id}
                          artifactId={id}
                          label={`request ledger ${index + 1}`}
                        />
                      ))}
                    </li>
                  ))}
                </List>
              </section>
            )}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
};
