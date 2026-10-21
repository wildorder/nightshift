/**
 * The pure arithmetic behind the run's Overview (P20, US-05): wording for
 * figures, what the attempts consumed, how intervals are laid out and which
 * metric a chart segment stands for. Nothing here turns a missing figure into
 * zero: an absent value stays `undefined` and prints as "not observed".
 */
import {
  type AttemptRow,
  type MetricId,
  type OperationInterval,
  type OperationsReport,
  type ProgramStatus,
  type ResourceTotals,
  type RunReport,
  sumResources,
} from "@nightshift/core";

export const NOT_OBSERVED = "not observed";

/** 1,234,567 -> "1.23M". Exact counts are printed apart, in the text tables. */
export const compactCount = (value: number | undefined): string => {
  if (value === undefined) return NOT_OBSERVED;
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(abs >= 10_000_000 ? 1 : 2)}M`;
  if (abs >= 10_000) return `${(value / 1000).toFixed(0)}K`;
  if (abs >= 1000) return `${(value / 1000).toFixed(1)}K`;
  return String(value);
};

export const exactCount = (value: number | undefined): string =>
  value === undefined ? NOT_OBSERVED : value.toLocaleString("en-US");

export const dollarsText = (value: number | undefined): string =>
  value === undefined ? NOT_OBSERVED : `$${value.toFixed(value < 1 ? 4 : 2)}`;

export const spanText = (ms: number | undefined): string => {
  if (ms === undefined) return NOT_OBSERVED;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    const rest = seconds % 60;
    return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
  }
  const hours = Math.floor(minutes / 60);
  return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`;
};

export const percentText = (part: number, whole: number): string =>
  `${Math.round((part / whole) * 100)}%`;

export const clockText = (iso: string | undefined): string =>
  iso === undefined ? NOT_OBSERVED : iso.slice(11, 19);

const add = (total: number | undefined, value: number | undefined): number | undefined =>
  value === undefined ? total : (total ?? 0) + value;

/** What a set of attempts consumed. Tokens and the two dollar kinds are never combined. */
export interface Consumption {
  readonly attempts: number;
  readonly input?: number;
  readonly output?: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
  readonly reasoning?: number;
  /** Attempts with an input or output counter observed. */
  readonly tokenAttempts: number;
  readonly estimatedUsd?: number;
  /** Attempts the API-equivalent estimate valued. */
  readonly estimateValued: number;
  /** Attempts whose estimate leaves some usage unvalued. */
  readonly estimateIncomplete: number;
  readonly reportedUsd?: number;
  readonly reportedValued: number;
  readonly coverage: ResourceTotals["coverage"];
}

export const consumptionOf = (rows: readonly AttemptRow[]): Consumption => {
  let input: number | undefined;
  let output: number | undefined;
  let cacheRead: number | undefined;
  let cacheWrite: number | undefined;
  let reasoning: number | undefined;
  let estimatedUsd: number | undefined;
  let reportedUsd: number | undefined;
  let tokenAttempts = 0;
  let estimateValued = 0;
  let estimateIncomplete = 0;
  let reportedValued = 0;
  for (const row of rows) {
    const { tokens, usd } = row.resources;
    input = add(input, tokens.input);
    output = add(output, tokens.output);
    cacheRead = add(cacheRead, tokens.cacheRead);
    cacheWrite = add(cacheWrite, tokens.cacheWrite);
    reasoning = add(reasoning, tokens.reasoning);
    if (tokens.input !== undefined || tokens.output !== undefined) tokenAttempts += 1;
    // One row is one attempt: a zero dollar total with the attempt unpriced is "no figure".
    if (usd.estimated > 0) {
      estimatedUsd = add(estimatedUsd, usd.estimated);
      estimateValued += 1;
    }
    if (usd.reported > 0) {
      reportedUsd = add(reportedUsd, usd.reported);
      reportedValued += 1;
    }
    if ((row.resources.estimateIncomplete ?? 0) > 0) estimateIncomplete += 1;
  }
  const coverage = sumCoverage(rows);
  return {
    attempts: rows.length,
    ...(input === undefined ? {} : { input }),
    ...(output === undefined ? {} : { output }),
    ...(cacheRead === undefined ? {} : { cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWrite }),
    ...(reasoning === undefined ? {} : { reasoning }),
    tokenAttempts,
    ...(estimatedUsd === undefined ? {} : { estimatedUsd }),
    estimateValued,
    estimateIncomplete,
    ...(reportedUsd === undefined ? {} : { reportedUsd }),
    reportedValued,
    coverage,
  };
};

const sumCoverage = (rows: readonly AttemptRow[]): ResourceTotals["coverage"] =>
  sumResources(
    rows.map((row) => ({
      tokens: { inputConvention: "inclusive" as const },
      usd: { source: "none" as const },
      coverage: row.coverage,
    })),
  ).coverage;

/** Input and output tokens together (input includes cache), or undefined when neither was observed. */
export const tokenTotal = (consumed: Pick<Consumption, "input" | "output">): number | undefined =>
  consumed.input === undefined && consumed.output === undefined
    ? undefined
    : (consumed.input ?? 0) + (consumed.output ?? 0);

/** "n of m attempts valued" wording for a dollar estimate, with its understatement. */
export const valuedText = (valued: number, attempts: number, incomplete = 0): string => {
  if (attempts === 0) return `${NOT_OBSERVED}: no attempts`;
  if (valued === 0) return `${NOT_OBSERVED}: no attempt was valued`;
  const base = `${valued} of ${attempts} attempts valued`;
  const partial = valued < attempts ? " (partial: the total understates)" : "";
  const unvalued = incomplete > 0 ? `; ${incomplete} valued without all of their usage priced` : "";
  return `${base}${partial}${unvalued}`;
};

export const tokensCoverageText = (consumed: Consumption): string =>
  consumed.attempts === 0
    ? `${NOT_OBSERVED}: no attempts`
    : consumed.tokenAttempts === 0
      ? `${NOT_OBSERVED}: no attempt reported token counters`
      : `${consumed.tokenAttempts} of ${consumed.attempts} attempts reported tokens${
          consumed.tokenAttempts < consumed.attempts ? " (partial)" : ""
        }`;

/** The resource bars: one additive bar per group, sharing one scale of tokens. */
export interface BarGroup {
  readonly key: string;
  readonly label: string;
  readonly rows: readonly AttemptRow[];
  readonly consumed: Consumption;
  /** input + output; undefined when the group's attempts reported no counters. */
  readonly tokens?: number;
}

export const groupAttempts = (
  rows: readonly AttemptRow[],
  keyOf: (row: AttemptRow) => string | null,
  unknownLabel: string,
): BarGroup[] => {
  const groups = new Map<string, AttemptRow[]>();
  for (const row of rows) {
    const key = keyOf(row) ?? "";
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const result = [...groups].map(([key, members]) => {
    const consumed = consumptionOf(members);
    const tokens = tokenTotal(consumed);
    return {
      key,
      label: key === "" ? unknownLabel : key,
      rows: members,
      consumed,
      ...(tokens === undefined ? {} : { tokens }),
    };
  });
  return result.sort(
    (a, b) => (b.tokens ?? -1) - (a.tokens ?? -1) || a.label.localeCompare(b.label),
  );
};

/** Phases drawn in one colour: examination, answering, arbitration and plan review read as one. */
export type PhaseGroup = "work" | "wait" | "queue" | "integration" | "examination" | "other";

export const phaseGroupOf = (phase: string): PhaseGroup => {
  switch (phase) {
    case "work":
    case "wait":
    case "queue":
    case "integration":
      return phase;
    case "examination":
    case "answer":
    case "arbitration":
    case "plan_review":
      return "examination";
    default:
      return "other";
  }
};

export const PHASE_GROUPS: readonly PhaseGroup[] = [
  "work",
  "wait",
  "queue",
  "integration",
  "examination",
  "other",
];

/** Which metric a phase's interval is an instance of. */
export const metricOfPhase = (phase: string): MetricId => {
  switch (phaseGroupOf(phase)) {
    case "work":
      return "summed_work_time";
    case "wait":
      return "wait_time";
    case "queue":
      return "queue_time";
    case "integration":
      return "integration_time";
    case "examination":
      return "examination_time";
    default:
      return "coverage";
  }
};

export interface DrawnInterval {
  readonly id: string;
  readonly nodeId: string;
  readonly phase: string;
  readonly group: PhaseGroup;
  readonly state: OperationInterval["state"];
  readonly startedAt?: string;
  readonly endedAt?: string;
  /** Epoch ms of the drawn extent; absent when the interval has no start. */
  readonly from?: number;
  readonly to?: number;
  /** Drawn to the report's `asOf` because it was never observed to end. */
  readonly open: boolean;
  readonly durationMs?: number;
  readonly blockers: readonly string[];
  readonly lane: number;
}

export interface TimelineModel {
  readonly from: number;
  readonly to: number;
  readonly asOf: number;
  readonly intervals: readonly DrawnInterval[];
  /** Per node, in report order, with the lanes its overlapping intervals needed. */
  readonly rows: readonly { readonly nodeId: string; readonly lanes: number }[];
}

const blockerText = (blocker: { kind: string; ref: string }): string =>
  `${blocker.kind} ${blocker.ref.slice(-8)}`;

/**
 * Lays the observed intervals out. An open interval is drawn to `asOf`, and an
 * `incomplete` one to the next start it was observed until; one with no start is
 * listed but not drawn. Overlapping intervals of one node take separate lanes
 * and are never summed.
 */
export const timelineOf = (operations: OperationsReport): TimelineModel => {
  const asOf = Date.parse(operations.asOf);
  const from = Date.parse(operations.startedAt);
  const ended = operations.endedAt === undefined ? asOf : Date.parse(operations.endedAt);
  const intervals: DrawnInterval[] = [];
  const rows: { nodeId: string; lanes: number }[] = [];
  let latest = ended;
  for (const node of operations.nodes) {
    const mine = node.operations;
    if (mine.length === 0) continue;
    const laneEnds: number[] = [];
    const sorted = [...mine].sort(
      (a, b) => Date.parse(a.startedAt ?? "9") - Date.parse(b.startedAt ?? "9") || 0,
    );
    for (const op of sorted) {
      const start = op.startedAt === undefined ? undefined : Date.parse(op.startedAt);
      const open = op.endedAt === undefined && start !== undefined;
      const end =
        op.endedAt !== undefined
          ? Date.parse(op.endedAt)
          : op.observedUntil !== undefined
            ? Date.parse(op.observedUntil)
            : open
              ? asOf
              : undefined;
      let lane = 0;
      if (start !== undefined) {
        lane = laneEnds.findIndex((last) => last <= start);
        if (lane === -1) lane = laneEnds.length;
        laneEnds[lane] = end ?? start;
        if (end !== undefined) latest = Math.max(latest, end);
      }
      intervals.push({
        id: `${op.operationId}#${op.occurrence}`,
        nodeId: op.nodeId,
        phase: op.phase,
        group: phaseGroupOf(op.phase),
        state: op.state,
        ...(op.startedAt === undefined ? {} : { startedAt: op.startedAt }),
        ...(op.endedAt === undefined ? {} : { endedAt: op.endedAt }),
        ...(start === undefined ? {} : { from: start }),
        ...(end === undefined ? {} : { to: end }),
        open: open && op.state === "open",
        ...(op.durationMs === undefined ? {} : { durationMs: op.durationMs }),
        blockers: op.blockerSpans.flatMap((span) => span.blockers.map(blockerText)),
        lane,
      });
    }
    rows.push({ nodeId: node.nodeId, lanes: Math.max(1, laneEnds.length) });
  }
  return { from, to: Math.max(latest, from + 1), asOf, intervals, rows };
};

export const intervalLabel = (interval: DrawnInterval): string => {
  const blockers =
    interval.blockers.length === 0 ? "" : `, waiting on ${interval.blockers.join(", ")}`;
  const when =
    interval.startedAt === undefined
      ? "start not observed"
      : `${clockText(interval.startedAt)} to ${interval.open ? "still open" : clockText(interval.endedAt)}`;
  return `${interval.phase}, ${when}${blockers}`;
};

/** A run that has not ended is measured so far, to `asOf`. */
export const elapsedOf = (report: RunReport): { ms: number; live: boolean } => {
  const { operations } = report;
  if (operations.elapsedMs !== undefined) return { ms: operations.elapsedMs, live: false };
  return {
    ms: Math.max(0, Date.parse(operations.asOf) - Date.parse(operations.startedAt)),
    live: true,
  };
};

/** Lifecycle observations exist for the run; otherwise every union is "not observed", not zero. */
export const hasObservedOperations = (operations: OperationsReport): boolean =>
  operations.operations.length > 0;

/** Tokens a resource total carries, input + output, or undefined when neither was observed. */
export const totalsTokens = (totals: ResourceTotals): number | undefined =>
  tokenTotal({
    ...(totals.tokens.input === undefined ? {} : { input: totals.tokens.input }),
    ...(totals.tokens.output === undefined ? {} : { output: totals.tokens.output }),
  });

export const verdictText = (verdict: RunReport["feedback"]["verdict"]): string =>
  verdict === "worked" ? "Worked" : verdict === "did_not_work" ? "Did not work" : "Not rated";

/** True when a live run's report is older than three poll intervals. */
export const isStale = (asOf: string, now: string, pollMs: number): boolean =>
  Date.parse(now) - Date.parse(asOf) > 3 * pollMs;

/** The run's spend against its budget, as the program status computed it (D-02). */
export type BudgetSpend = ProgramStatus["spend"];

/** "n unpriced, m unmeasured" and whatever else the evaluation could not see. */
export const budgetGapText = (evaluation: BudgetSpend["evaluation"]): string => {
  const parts = [`${evaluation.unpriced} unpriced`, `${evaluation.unmeasured} unmeasured`];
  if (evaluation.estimateIncomplete > 0) {
    parts.push(`${evaluation.estimateIncomplete} with unvalued usage`);
  }
  return parts.join(", ");
};

/**
 * The budget evaluation in words: the configured limit, what has been spent so
 * far and, when the figures leave something out, that the budget cannot be
 * evaluated completely. "Within budget" is only ever said of a complete
 * evaluation.
 */
export const budgetLines = (spend: BudgetSpend): string[] => {
  const { evaluation } = spend;
  if (!evaluation.configured) return ["Budget: no limit is configured for this program."];
  const limit =
    spend.budgetUsd === undefined
      ? "a token limit is configured"
      : `limit ${dollarsText(spend.budgetUsd)}`;
  const lines = [
    `Budget: ${limit}; spent so far ${dollarsText(spend.usd)}${spend.estimated ? " (partly estimated)" : ""}.`,
  ];
  if (!evaluation.complete) {
    lines.push(`Cannot be evaluated completely: ${budgetGapText(evaluation)}.`);
  } else if (spend.budgetUsd !== undefined) {
    lines.push(spend.usd < spend.budgetUsd ? "Within budget." : "At or over the limit.");
  }
  return lines;
};
