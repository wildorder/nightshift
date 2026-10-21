import type { RunReport, RunScope } from "@nightshift/core";

const runBase = (scope: RunScope): string =>
  `/projects/${scope.projectId}/programs/${scope.programId}/runs/${scope.runId}`;

/** The Work tab with a node's sheet open. */
export const workHref = (scope: RunScope, nodeId: string): string =>
  `${runBase(scope)}?tab=work&node=${encodeURIComponent(nodeId)}`;

export const decisionHref = (scope: RunScope, decisionId: string): string =>
  `${runBase(scope)}/decisions/${decisionId}`;

export interface FindingText {
  readonly severity: string;
  readonly summary: string;
}

/** What each finding says, from the examinations the report carries. */
export const findingTexts = (report: RunReport): ReadonlyMap<string, FindingText> => {
  const texts = new Map<string, FindingText>();
  for (const strand of report.strands) {
    for (const job of strand.jobs) {
      for (const examination of job.examinations) {
        for (const finding of examination.findings) {
          texts.set(`${examination.examinationId}\u0000${finding.id}`, {
            severity: finding.severity,
            summary: finding.summary,
          });
        }
      }
    }
  }
  return texts;
};
