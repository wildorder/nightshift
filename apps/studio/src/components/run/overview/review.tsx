/**
 * Review evidence (P20, US-05): the unique findings with what became of them,
 * and what the helpers cost as overhead. Dispositions describe what happened to
 * a finding, not whether it was right; nothing here is an accuracy figure.
 */
import type { RunReport, RunScope } from "@nightshift/core";
import { Link } from "react-router";
import { compactCount, NOT_OBSERVED, totalsTokens } from "../../../lib/overview.js";
import { decisionHref, findingTexts, workHref } from "./links.js";

const LINKAGE: Readonly<Record<string, string>> = {
  linked: "linked to a repair attempt",
  unresolved: "no repair attempt yet",
  unknown: "linkage unknown (not enough evidence)",
};

export const ReviewEvidence = ({
  report,
  scope,
  nodeLabels,
}: {
  readonly report: RunReport;
  readonly scope: RunScope;
  readonly nodeLabels: ReadonlyMap<string, string>;
}) => {
  const review = report.review;
  const texts = findingTexts(report);
  const overhead = [
    ["Examiner", review.overhead.examiner],
    ["Answerer", review.overhead.answerer],
    ["Arbiter", review.overhead.arbiter],
    ["Plan review", review.overhead.planReview],
  ] as const;
  return (
    <div className="grid gap-4 lg:grid-cols-[3fr_2fr]">
      <section className="grid content-start gap-2" aria-label="Unique findings">
        <h3 className="text-sm font-medium">Unique findings ({review.findings.length})</h3>
        {review.findings.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No examiner raised a finding in this run
            {review.coverage.examinations.total === 0
              ? ", and no examination is recorded (the run may predate them or have skipped them)"
              : ""}
            .
          </p>
        ) : (
          <ul className="grid gap-2">
            {review.findings.map((finding) => {
              const first = finding.occurrences[0];
              const text =
                first === undefined
                  ? undefined
                  : texts.get(`${first.examinationId}\u0000${first.findingId}`);
              return (
                <li
                  key={`${finding.nodeId}/${first?.examinationId}/${first?.findingId}`}
                  className="rounded-lg border border-border p-2 text-xs"
                >
                  <p>
                    <b>{finding.severity}</b> {text?.summary ?? "(finding text not on the report)"}
                  </p>
                  <p className="text-muted-foreground">
                    Latest disposition: {finding.latest.replace("_", " ")}
                    {finding.open ? " (open)" : ""} · raised {finding.occurrences.length} time
                    {finding.occurrences.length === 1 ? "" : "s"} · {LINKAGE[finding.linkage]}
                  </p>
                  <p>
                    <Link className="underline" to={workHref(scope, finding.nodeId)}>
                      Examination at {nodeLabels.get(finding.nodeId) ?? finding.nodeId.slice(-8)}
                    </Link>
                    {finding.rulings.map((ruling) => (
                      <span
                        key={`${ruling.examinationId}/${ruling.findingId}/${ruling.disposition}`}
                      >
                        {" · "}
                        {ruling.decisionId === undefined ? (
                          `arbiter ${ruling.disposition.replace("_", " ")}`
                        ) : (
                          <Link className="underline" to={decisionHref(scope, ruling.decisionId)}>
                            ruling: {ruling.disposition.replace("_", " ")}
                          </Link>
                        )}
                      </span>
                    ))}
                  </p>
                </li>
              );
            })}
          </ul>
        )}
        <p className="text-xs text-muted-foreground">{review.dispositions.note}</p>
      </section>

      <section className="grid content-start gap-2" aria-label="Review overhead">
        <h3 className="text-sm font-medium">Review overhead by helper role</h3>
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className="p-1">Role</th>
              <th className="p-1">Calls</th>
              <th className="p-1">Tokens</th>
            </tr>
          </thead>
          <tbody>
            {overhead.map(([label, row]) => (
              <tr key={label} className="border-t border-border">
                <td className="p-1">{label}</td>
                <td className="p-1 tabular-nums">{row.calls}</td>
                <td className="p-1 tabular-nums">
                  {row.calls === 0 ? "none called" : compactCount(totalsTokens(row.resources))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="text-xs text-muted-foreground">
          Repairs caused by review ({review.repairs.attempts} implementation attempt
          {review.repairs.attempts === 1 ? "" : "s"},{" "}
          {review.repairs.attempts === 0
            ? "no tokens"
            : `${compactCount(totalsTokens(review.repairs.resources))} tokens`}
          ) are rework, shown apart and never added to overhead. {NOT_OBSERVED} means the harness
          reported no counters, not zero.
        </p>
      </section>
    </div>
  );
};
