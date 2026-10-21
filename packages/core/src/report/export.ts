/**
 * The report as a versioned export (P20): the figures `report.md` shows, in a
 * compact, machine-readable form validated by `ReportExportSchema`. Pure.
 *
 * Attempts are the only filtered section; `sampleSize` says how many matched
 * out of how many exist. Metric definitions travel with the figures that use
 * them. Request artifacts and raw events are never embedded: an attempt names
 * its `ledgerArtifactIds`, which the artifact download route serves.
 */
import { type ReportExport, ReportExportSchema, reportExportVersion } from "@nightshift/contracts";
import { type AttemptFilter, filterAttempts } from "./attempts.js";
import { METRIC_DEFINITIONS, type MetricId } from "./definitions.js";
import type { RunReport, UsageRow } from "./report.js";

export type ReportExportFilters = AttemptFilter;

export const METRICS_BY_SECTION: Readonly<Record<string, readonly MetricId[]>> = {
  attempts: [
    "agent_time",
    "settlement_time",
    "tokens_input",
    "tokens_output",
    "tokens_cache_read",
    "tokens_cache_write",
    "tokens_reasoning",
    "coverage",
    "sample_size",
  ],
  usage: [
    "tokens_input",
    "tokens_output",
    "api_equivalent_estimate",
    "provider_reported_estimate",
    "coverage",
  ],
  budget: ["api_equivalent_estimate", "provider_reported_estimate"],
  operations: [
    "elapsed_completion_time",
    "summed_work_time",
    "wait_time",
    "queue_time",
    "integration_time",
    "examination_time",
  ],
  delivery: ["first_attempt_success", "delivered_outcomes", "rework_attempts", "rework_by_cause"],
  review: ["examiner_dispositions", "review_overhead"],
  feedback: ["human_verdict", "rating_coverage"],
  completions: [
    "completion_lead_time",
    "run_completion_time",
    "active_seconds",
    "combined_estimate",
    "infrastructure_estimate",
  ],
};

/** The sections the report's figures fall in, each with its metric ids; the budget section only when a budget was evaluated. */
export const metricSectionsOf = (
  report: Pick<RunReport, "budget">,
): Record<string, readonly MetricId[]> =>
  Object.fromEntries(
    Object.entries(METRICS_BY_SECTION).filter(
      ([name]) => name !== "budget" || report.budget !== undefined,
    ),
  );

/** The definitions of every metric id the sections use, sorted by id. */
export const definitionsOfSections = (
  sections: Readonly<Record<string, readonly MetricId[]>>,
): (typeof METRIC_DEFINITIONS)[MetricId][] =>
  [...new Set<MetricId>(Object.values(sections).flat())].sort().map((id) => METRIC_DEFINITIONS[id]);

const usageLabel = (row: UsageRow): ReportExport["usage"][number]["label"] => {
  const reported = (row.reportedAttempts ?? 0) > 0;
  const estimated = (row.estimatedAttempts ?? 0) > 0;
  if (reported && estimated) return "provider-reported and API-equivalent estimate";
  if (reported) return "provider-reported";
  return estimated ? "API-equivalent estimate" : "unknown";
};

const usageOfExport = (row: UsageRow): ReportExport["usage"][number] => {
  // Rows built before the observation counts existed carry their tokens as they were.
  const observed = row.tokensObserved === undefined || row.tokensObserved > 0;
  return {
    harness: row.harness,
    model: row.model,
    purpose: row.purpose,
    attempts: row.attempts,
    ...(observed ? { inputTokens: row.inputTokens, outputTokens: row.outputTokens } : {}),
    ...(row.unpriced === row.attempts ? {} : { costUsd: row.costUsd }),
    label: usageLabel(row),
    attemptsValued: row.attempts - row.unpriced,
    unpriced: row.unpriced,
    estimateIncomplete: row.estimateIncomplete ?? 0,
    priceBases: (row.priceBases ?? []).map((basis) => ({ ...basis })),
  };
};

/** Drops `undefined` and anything JSON cannot carry, so the schema sees what a file would hold. */
const jsonOf = <T>(value: T): unknown => JSON.parse(JSON.stringify(value));

export const exportReport = (
  report: RunReport,
  filters: ReportExportFilters = {},
): ReportExport => {
  const { run, program } = report;
  const { rows, sampleSize } = filterAttempts(report.attempts ?? [], filters);
  const budget = report.budget;
  const { maxUsd, maxTokens } = program.costPolicy;
  const sections = metricSectionsOf(report);
  const draft = {
    reportExportVersion,
    asOf: report.asOf,
    scope: { projectId: run.projectId, programId: run.programId, runId: run.runId },
    run: {
      status: run.status,
      ...(run.outcomeReason === undefined ? {} : { outcome: run.outcomeReason }),
    },
    filters: Object.fromEntries(Object.entries(filters).filter(([, value]) => value !== undefined)),
    sampleSize,
    definitions: definitionsOfSections(sections).map((definition) => ({
      ...definition,
      evidence: [...definition.evidence],
    })),
    metricsBySection: sections,
    attempts: rows,
    usage: report.usage.map(usageOfExport),
    ...(budget === undefined
      ? {}
      : {
          budget: {
            limits: {
              ...(maxUsd === undefined ? {} : { maxUsd }),
              ...(maxTokens === undefined ? {} : { maxTokens }),
            },
            usd: budget.usd,
            tokens: budget.tokens,
            estimated: budget.estimated,
            evaluation: {
              configured: budget.evaluation.configured,
              complete: budget.evaluation.complete,
              unpriced: budget.evaluation.unpriced,
              unmeasured: budget.evaluation.unmeasured,
              estimateIncomplete: budget.evaluation.estimateIncomplete,
            },
          },
        }),
    operations: {
      startedAt: report.operations.startedAt,
      endedAt: report.operations.endedAt,
      elapsedMs: report.operations.elapsedMs,
      unions: report.operations.unions,
      concurrency: {
        peak: report.operations.concurrency.peak,
        summedWorkMs: report.operations.concurrency.summedWorkMs,
        averageOverElapsed: report.operations.concurrency.averageOverElapsed,
      },
      unattributedMs: report.operations.unattributedMs,
      ambiguousMs: report.operations.ambiguousMs,
      endings: report.operations.endings,
      chain: report.operations.chain,
    },
    delivery: report.delivery,
    review: report.review,
    feedback: report.feedback,
    feedbackCoverage: report.feedbackCoverage,
    completions: report.completions.map((c) => ({
      completionHistoryId: c.completionHistoryId,
      title: c.title,
      version: c.version,
      members: c.members,
      coverage: c.coverage,
      current: c.current,
      checkpoints: c.checkpoints,
    })),
    gateHealth: { verificationTime: report.gateHealth.verificationTime },
  };
  return ReportExportSchema.parse(jsonOf(draft));
};
