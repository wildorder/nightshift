/**
 * What each reported metric means (P20): population, denominator or coverage,
 * unit and the evidence behind it. One place, so every surface words a figure
 * the same way.
 */

export type MetricId =
  | "first_attempt_success"
  | "delivered_outcomes"
  | "elapsed_completion_time"
  | "summed_work_time"
  | "wait_time"
  | "queue_time"
  | "integration_time"
  | "examination_time"
  | "tokens_input"
  | "tokens_output"
  | "tokens_cache_read"
  | "tokens_cache_write"
  | "tokens_reasoning"
  | "api_equivalent_estimate"
  | "provider_reported_estimate"
  | "infrastructure_estimate"
  | "combined_estimate"
  | "rework_attempts"
  | "rework_by_cause"
  | "examiner_dispositions"
  | "review_overhead"
  | "human_verdict"
  | "rating_coverage"
  | "completion_lead_time"
  | "run_completion_time"
  | "active_seconds"
  | "agent_time"
  | "settlement_time"
  | "coverage"
  | "sample_size";

export interface MetricDefinition {
  readonly id: MetricId;
  readonly label: string;
  /** What is measured, how, and what it is not. */
  readonly definition: string;
  /** What the denominator or coverage is, in words, and how missing data is treated. */
  readonly denominator: string;
  readonly unit: "tokens" | "usd" | "ms" | "count" | "ratio";
  readonly evidence: readonly (
    | "attempts"
    | "findings"
    | "feedback"
    | "artifacts"
    | "verifications"
    | "runs"
  )[];
}

export const METRIC_DEFINITIONS: Readonly<Record<MetricId, MetricDefinition>> = {
  first_attempt_success: {
    id: "first_attempt_success",
    label: "First-attempt success",
    definition:
      "Delivered jobs whose first attempt (attempt 1) was verified and integrated without a later attempt. Association with rework is not causation.",
    denominator:
      "Jobs that reached a terminal state in the selected population; jobs still running are not counted.",
    unit: "ratio",
    evidence: ["attempts", "verifications"],
  },
  delivered_outcomes: {
    id: "delivered_outcomes",
    label: "Delivered outcomes",
    definition:
      "Jobs whose work was verified and integrated, counted once each however many attempts it took.",
    denominator: "All jobs in the selected population, delivered or not.",
    unit: "count",
    evidence: ["attempts", "verifications", "runs"],
  },
  elapsed_completion_time: {
    id: "elapsed_completion_time",
    label: "Elapsed completion time",
    definition:
      "Wall-clock time from the start of the run or story to its completion, measured on the clock; overlapping work is counted once.",
    denominator:
      "Completed runs or stories only; unfinished ones are excluded and counted in the sample size.",
    unit: "ms",
    evidence: ["runs"],
  },
  summed_work_time: {
    id: "summed_work_time",
    label: "Summed work time",
    definition:
      "The sum of every attempt's working time. It is not elapsed time: work overlaps, so the sum can exceed the clock time of the run.",
    denominator:
      "Attempts with a recorded start and end; attempts without both add nothing and are counted as missing.",
    unit: "ms",
    evidence: ["attempts"],
  },
  wait_time: {
    id: "wait_time",
    label: "Wait time",
    definition:
      "Time the run spent waiting rather than working: for a human, for capacity, or for a prerequisite, as recorded on the control plane.",
    denominator: "Runs with recorded waiting intervals; absent intervals are unknown, not zero.",
    unit: "ms",
    evidence: ["runs"],
  },
  queue_time: {
    id: "queue_time",
    label: "Queue time",
    definition:
      "Time verification requests waited for the verification queue before they started running.",
    denominator: "Verifications in the selected population that recorded a queue phase.",
    unit: "ms",
    evidence: ["verifications"],
  },
  integration_time: {
    id: "integration_time",
    label: "Integration time",
    definition:
      "Time spent integrating verified work onto its target branch, after verification passed.",
    denominator: "Integrated jobs with recorded integration intervals.",
    unit: "ms",
    evidence: ["attempts", "runs"],
  },
  examination_time: {
    id: "examination_time",
    label: "Examination time",
    definition:
      "Time examiners and the helper routes serving them (answering, arbitrating) spent on examinations of the work.",
    denominator: "Examination routes with a recorded start and end.",
    unit: "ms",
    evidence: ["attempts", "findings"],
  },
  tokens_input: {
    id: "tokens_input",
    label: "Input tokens",
    definition:
      "Input tokens the provider reported, normalized to include cache reads and writes where the convention is known; an unknown convention is flagged and the raw figure kept.",
    denominator:
      "Attempts with a measured input counter; attempts without one are counted in coverage, never as zero.",
    unit: "tokens",
    evidence: ["attempts"],
  },
  tokens_output: {
    id: "tokens_output",
    label: "Output tokens",
    definition: "Output tokens the provider reported for the attempts.",
    denominator: "Attempts with a measured output counter; absent counters are not zero.",
    unit: "tokens",
    evidence: ["attempts"],
  },
  tokens_cache_read: {
    id: "tokens_cache_read",
    label: "Cache-read tokens",
    definition: "Tokens served from the provider's prompt cache, where reported.",
    denominator: "Attempts whose provider reports cache reads; others are not counted as zero.",
    unit: "tokens",
    evidence: ["attempts"],
  },
  tokens_cache_write: {
    id: "tokens_cache_write",
    label: "Cache-write tokens",
    definition: "Tokens written to the provider's prompt cache, where reported.",
    denominator: "Attempts whose provider reports cache writes; others are not counted as zero.",
    unit: "tokens",
    evidence: ["attempts"],
  },
  tokens_reasoning: {
    id: "tokens_reasoning",
    label: "Reasoning tokens",
    definition: "Reasoning or thinking tokens, where the provider reports them apart from output.",
    denominator:
      "Attempts whose provider reports reasoning tokens; others are not counted as zero.",
    unit: "tokens",
    evidence: ["attempts"],
  },
  api_equivalent_estimate: {
    id: "api_equivalent_estimate",
    label: "API-equivalent estimate",
    definition:
      "An estimate of what the measured tokens would cost at a price table's list rates. It is an estimate from a price table, not a bill, and subscription or negotiated pricing may differ.",
    denominator:
      "Attempts with a price-table entry for their model and measured tokens; others are unpriced.",
    unit: "usd",
    evidence: ["attempts"],
  },
  provider_reported_estimate: {
    id: "provider_reported_estimate",
    label: "Provider-reported cost",
    definition:
      "The dollar figure the provider or harness itself reported, kept apart from the price-table estimate and never summed with it. It is an estimate of spend, not an invoice.",
    denominator: "Attempts whose harness reported a cost; others are unpriced.",
    unit: "usd",
    evidence: ["attempts"],
  },
  infrastructure_estimate: {
    id: "infrastructure_estimate",
    label: "Infrastructure estimate",
    definition:
      "An estimate of the machine expense of runs executed on Nightshift-provisioned machines, from their utilization and a rate table.",
    denominator: "Runs with a machine report; local runs have none and are absent, not zero.",
    unit: "usd",
    evidence: ["runs"],
  },
  combined_estimate: {
    id: "combined_estimate",
    label: "Combined estimate",
    definition:
      "The model estimate plus the machine estimate. It is a lower bound when either part is incomplete.",
    denominator: "Runs with both parts measured count fully; the rest are listed as incomplete.",
    unit: "usd",
    evidence: ["attempts", "runs"],
  },
  rework_attempts: {
    id: "rework_attempts",
    label: "Rework attempts",
    definition:
      "Attempts made after a node's first attempt: escalations and retries of the same node's work. Association with other factors is not proof of causation.",
    denominator:
      "Attempts of jobs in the selected population; the first attempt of each job is not rework.",
    unit: "count",
    evidence: ["attempts"],
  },
  rework_by_cause: {
    id: "rework_by_cause",
    label: "Rework by cause",
    definition:
      "Rework attempts grouped by the cause recorded when the attempt was made (for example verification failure or examiner finding). An attempt with several causes appears under each.",
    denominator:
      "Rework attempts with a recorded cause; those without one are counted as unattributed.",
    unit: "count",
    evidence: ["attempts", "findings"],
  },
  examiner_dispositions: {
    id: "examiner_dispositions",
    label: "Examiner dispositions",
    definition: "How examiners' findings were resolved: upheld, rejected, fixed or still open.",
    denominator: "Findings raised in the selected population.",
    unit: "count",
    evidence: ["findings"],
  },
  review_overhead: {
    id: "review_overhead",
    label: "Review overhead",
    definition:
      "Resources and time spent by examination and arbitration routes, shown beside the work they reviewed. It is not a measure of review quality.",
    denominator: "Helper routes in the selected population compared with all routes.",
    unit: "ratio",
    evidence: ["attempts", "findings"],
  },
  human_verdict: {
    id: "human_verdict",
    label: "Human verdict",
    definition:
      "The person's binary verdict on whether a run worked, captured with its attribution. It is separate from deterministic verification and does not change recorded outcomes.",
    denominator: "Runs that received a verdict; unrated runs have none.",
    unit: "count",
    evidence: ["feedback"],
  },
  rating_coverage: {
    id: "rating_coverage",
    label: "Rating coverage",
    definition: "The share of completed runs that carry a human verdict.",
    denominator: "Completed runs in the selected population.",
    unit: "ratio",
    evidence: ["feedback", "runs"],
  },
  completion_lead_time: {
    id: "completion_lead_time",
    label: "Completion lead time",
    definition:
      "Time from a story or goal being planned to its work being delivered, as recorded on a completion checkpoint.",
    denominator: "Completion checkpoints whose members all have recorded times.",
    unit: "ms",
    evidence: ["runs", "artifacts"],
  },
  run_completion_time: {
    id: "run_completion_time",
    label: "Run completion time",
    definition: "Time from a run's start to its completion, measured on the clock.",
    denominator: "Runs that completed.",
    unit: "ms",
    evidence: ["runs"],
  },
  active_seconds: {
    id: "active_seconds",
    label: "Active seconds",
    definition:
      "Seconds during which something was executing for the run, as recorded by the control plane. Idle gaps are excluded.",
    denominator: "Runs with recorded activity intervals.",
    unit: "ms",
    evidence: ["runs"],
  },
  agent_time: {
    id: "agent_time",
    label: "Agent time",
    definition:
      "Harness execution time of an agent, from its start to its end. It excludes verification, queueing and integration.",
    denominator: "Agents with both a recorded start and end.",
    unit: "ms",
    evidence: ["attempts"],
  },
  settlement_time: {
    id: "settlement_time",
    label: "Settlement time",
    definition:
      "Time from an attempt's start until its node settled, including verification, queue and integration. It is longer than agent time.",
    denominator: "Routing decisions that recorded a wall-clock figure.",
    unit: "ms",
    evidence: ["attempts", "verifications"],
  },
  coverage: {
    id: "coverage",
    label: "Coverage",
    definition:
      "How completely an attempt's resources were observed: complete, partial, unknown, legacy (route figures only) or missing. Missing evidence is never shown as zero.",
    denominator: "All attempts in the selected population, tallied by coverage class.",
    unit: "count",
    evidence: ["attempts", "artifacts"],
  },
  sample_size: {
    id: "sample_size",
    label: "Sample size",
    definition:
      "How many rows matched a filter and how many there were in all, so a figure is read against its population.",
    denominator: "Matched rows out of all rows before filtering.",
    unit: "count",
    evidence: ["attempts", "runs"],
  },
};
