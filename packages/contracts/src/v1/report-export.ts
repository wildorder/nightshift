/**
 * The versioned export of a run's report (P20): a compact, machine-readable
 * view of the same figures `report.md` shows, for analysis outside Nightshift.
 *
 * It carries metric definitions with the figures that use them, one row per
 * attempt (filtered) with the ledger artifact ids request evidence is fetched
 * by through the artifact download route, and no request artifacts and no raw
 * events. Absent evidence is absent, never zero.
 */
import { z } from "zod";
import { CompletionCombinedSchema } from "./completion.js";

export const reportExportVersion = 1 as const;

const nonNegative = z.number().min(0);
const nonNegativeInt = z.int().min(0);
const JsonObjectSchema = z.record(z.string(), z.json());

export const ReportExportDefinitionSchema = z.strictObject({
  id: z.string().min(1),
  label: z.string(),
  definition: z.string(),
  denominator: z.string(),
  unit: z.enum(["tokens", "usd", "ms", "count", "ratio"]),
  evidence: z.array(z.string()),
});

export const ReportExportFiltersSchema = z.strictObject({
  role: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});
export type ReportExportFilters = z.infer<typeof ReportExportFiltersSchema>;

export const ReportExportAttemptSchema = z.strictObject({
  nodeId: z.string(),
  strandId: z.string().nullable(),
  purpose: z.string(),
  role: z.string().nullable(),
  attempt: nonNegativeInt,
  harness: z.string(),
  model: z.string(),
  observedModels: z.array(z.string()),
  routingDecisionId: z.string().nullable(),
  measurementSummaryId: z.string().optional(),
  agentId: z.string().optional(),
  startedAt: z.string().optional(),
  endedAt: z.string().optional(),
  /** Harness execution time. */
  agentMs: nonNegative.optional(),
  /** Attempt start until the node settled. */
  settlementMs: nonNegative.optional(),
  resources: JsonObjectSchema,
  coverage: z.enum(["complete", "partial", "unknown", "legacy", "missing"]),
  outcome: z.string().nullable(),
  /** Request-evidence artifacts, fetched through the existing artifact download route. */
  ledgerArtifactIds: z.array(z.string()),
  root: z.boolean(),
});

export const ReportExportUsageRowSchema = z.strictObject({
  harness: z.string(),
  model: z.string(),
  purpose: z.string(),
  attempts: nonNegativeInt,
  /** Absent when no attempt observed tokens. */
  inputTokens: nonNegativeInt.optional(),
  outputTokens: nonNegativeInt.optional(),
  /** Absent when no attempt had a dollar figure. */
  costUsd: nonNegative.optional(),
  label: z.enum([
    "API-equivalent estimate",
    "provider-reported",
    "provider-reported and API-equivalent estimate",
    "unknown",
  ]),
  attemptsValued: nonNegativeInt,
  unpriced: nonNegativeInt,
  estimateIncomplete: nonNegativeInt,
  priceBases: z.array(
    z.strictObject({
      source: z.string().optional(),
      version: z.string().optional(),
      model: z.string(),
      incomplete: z.boolean(),
    }),
  ),
});

export const ReportExportBudgetSchema = z.strictObject({
  limits: z.strictObject({ maxUsd: nonNegative.optional(), maxTokens: nonNegative.optional() }),
  /** Known spend: a lower bound when the evaluation is incomplete. */
  usd: nonNegative,
  tokens: nonNegativeInt,
  estimated: z.boolean(),
  evaluation: z.strictObject({
    configured: z.boolean(),
    complete: z.boolean(),
    unpriced: nonNegativeInt,
    unmeasured: nonNegativeInt,
    estimateIncomplete: nonNegativeInt,
  }),
});

export const ReportExportCompletionSchema = z.strictObject({
  completionHistoryId: z.string(),
  title: z.string(),
  version: nonNegativeInt,
  members: z.array(JsonObjectSchema),
  coverage: JsonObjectSchema,
  current: z.looseObject({ combined: CompletionCombinedSchema.optional() }),
  checkpoints: z.array(z.looseObject({ combined: CompletionCombinedSchema.optional() })),
});

export const ReportExportSchema = z
  .strictObject({
    reportExportVersion: z.literal(reportExportVersion),
    asOf: z.string(),
    scope: z.strictObject({ projectId: z.string(), programId: z.string(), runId: z.string() }),
    run: z.strictObject({ status: z.string(), outcome: z.string().optional() }),
    filters: ReportExportFiltersSchema,
    sampleSize: z.strictObject({ matched: nonNegativeInt, total: nonNegativeInt }),
    definitions: z.array(ReportExportDefinitionSchema),
    /** Section name → the metric ids its figures use; each is in `definitions`. */
    metricsBySection: z.record(z.string(), z.array(z.string())),
    attempts: z.array(ReportExportAttemptSchema),
    usage: z.array(ReportExportUsageRowSchema),
    budget: ReportExportBudgetSchema.optional(),
    operations: JsonObjectSchema,
    delivery: JsonObjectSchema,
    review: JsonObjectSchema,
    feedback: JsonObjectSchema,
    feedbackCoverage: JsonObjectSchema,
    completions: z.array(ReportExportCompletionSchema),
    gateHealth: z.strictObject({ verificationTime: JsonObjectSchema }),
  })
  .superRefine((value, ctx) => {
    const defined = new Set(value.definitions.map((definition) => definition.id));
    for (const [section, ids] of Object.entries(value.metricsBySection)) {
      for (const id of ids) {
        if (!defined.has(id)) {
          ctx.addIssue({
            code: "custom",
            path: ["metricsBySection", section],
            message: `metric ${id} is used but not defined`,
          });
        }
      }
    }
    if (value.sampleSize.matched !== value.attempts.length) {
      ctx.addIssue({
        code: "custom",
        path: ["sampleSize", "matched"],
        message: "sampleSize.matched must equal the number of attempts exported",
      });
    }
  });
export type ReportExport = z.infer<typeof ReportExportSchema>;
