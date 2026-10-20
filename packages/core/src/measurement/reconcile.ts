/**
 * Reconciliation of one launch segment's usage evidence.
 *
 * Requests, cumulative snapshots and terminal summaries overlap: they are
 * sources to reconcile, never values to add. The segment's value per counter is
 * the maximum across the sources available, so a source that says less (an
 * empty terminal from a legacy adapter's cancel, a partial one) never erases
 * evidence that another source holds; where sources differ the difference is
 * recorded as a gap.
 */
import type {
  CoverageGap,
  MeasurementCounters,
  MeasurementCoverage,
  MeasurementObservation,
  Segment,
} from "@nightshift/contracts";
import {
  addCounters,
  COUNTER_KEYS,
  cleanCounters,
  compareSourceKeys,
  hasAnyCounters,
  hasCounters,
  mergeInputConvention,
  sourceKeyOf,
  sumCounters,
} from "./counters.js";
import { coalesceGaps } from "./gaps.js";

type Sources = Segment["sources"];
type SessionCumulative = NonNullable<Segment["sessionCumulative"]>;
type Inclusion = "self" | "includes_children" | "unknown";

export interface SegmentReconciliation {
  readonly counters: MeasurementCounters;
  readonly coverage: Exclude<MeasurementCoverage, "legacy">;
  readonly gaps: CoverageGap[];
  readonly observed: Segment["observed"];
  readonly sources: Sources;
  readonly sessionCumulative?: SessionCumulative;
  readonly childCounters?: MeasurementCounters;
}

export interface ReconcileOptions {
  /** The session-scoped value this segment's session sources are measured from. */
  readonly baseline?: MeasurementCounters | undefined;
  readonly resumedSession: boolean;
}

/** The part of a segment that observations change. */
export interface SegmentState {
  readonly sources: Sources;
  readonly sessionCumulative?: SessionCumulative | undefined;
  readonly observed: Segment["observed"];
}

export const emptySegmentState = (): SegmentState => ({
  sources: { requests: {}, requestCount: 0 },
  observed: { requests: 0, snapshots: 0, terminal: false },
});

const combineInclusion = (a: Inclusion | undefined, b: Inclusion): Inclusion => {
  if (a === "unknown" || b === "unknown") return "unknown";
  if (a === "includes_children" || b === "includes_children") return "includes_children";
  return "self";
};

/**
 * An observation's counters with the emitter's `reportedCostUsd` copied in as
 * `reportedUsd` when the counters carry none, so dollars travel with the tokens.
 */
const countersOf = (
  observation: Exclude<MeasurementObservation, { kind: "lifecycle" }>,
): MeasurementCounters => {
  const counters = cleanCounters(observation.counters);
  if (
    counters.reportedUsd === undefined &&
    (observation.kind === "request" || observation.kind === "terminal_summary") &&
    observation.reportedCostUsd !== undefined
  ) {
    counters.reportedUsd = observation.reportedCostUsd;
  }
  return counters;
};

/** One observation applied to a segment's running sources. Lifecycle observations change nothing. */
export const applyObservation = (
  state: SegmentState,
  observation: MeasurementObservation,
): SegmentState => {
  if (observation.kind === "lifecycle") return state;
  const { sources, observed } = state;

  if (observation.kind === "request") {
    const counters = countersOf(observation);
    const next: Sources =
      observation.childRef === undefined
        ? { ...sources, requests: addCounters(sources.requests, counters) }
        : { ...sources, childRequests: addCounters(sources.childRequests ?? {}, counters) };
    return {
      ...state,
      sources: { ...next, requestCount: sources.requestCount + 1 },
      observed: { ...observed, requests: observed.requests + 1 },
    };
  }

  // A child's own cumulative figures say nothing about this execution's segment.
  if (observation.childRef !== undefined) return state;

  const counters = countersOf(observation);
  const key = sourceKeyOf(observation);
  const isTerminal = observation.kind === "terminal_summary";
  let nextSources: Sources = {
    ...sources,
    aggregateInclusion: combineInclusion(sources.aggregateInclusion, observation.inclusion),
  };
  let sessionCumulative = state.sessionCumulative;

  // An aggregate with no counters never supersedes one that has some.
  if (hasAnyCounters(counters)) {
    if (observation.counterScope === "launch") {
      if (isTerminal) {
        if (
          sources.latestTerminalKey === undefined ||
          compareSourceKeys(key, sources.latestTerminalKey) >= 0
        ) {
          nextSources = {
            ...nextSources,
            terminal: counters,
            terminalCoverage: observation.coverage,
            latestTerminalKey: key,
          };
        }
      } else if (
        sources.latestLaunchSnapshotKey === undefined ||
        compareSourceKeys(key, sources.latestLaunchSnapshotKey) >= 0
      ) {
        nextSources = {
          ...nextSources,
          latestLaunchSnapshot: counters,
          latestLaunchSnapshotKey: key,
        };
      }
    } else if (sessionCumulative === undefined || compareSourceKeys(key, sessionCumulative) >= 0) {
      sessionCumulative = { counters, kind: observation.kind, ...key };
      if (isTerminal) nextSources = { ...nextSources, terminalCoverage: observation.coverage };
    }
  }

  return {
    sources: nextSources,
    ...(sessionCumulative === undefined ? {} : { sessionCumulative }),
    observed: isTerminal
      ? { ...observed, terminal: true }
      : { ...observed, snapshots: observed.snapshots + 1 },
  };
};

const subtractBaseline = (
  counters: MeasurementCounters,
  baseline: MeasurementCounters,
): MeasurementCounters => {
  const out: MeasurementCounters = {};
  for (const key of COUNTER_KEYS) {
    const value = counters[key];
    if (value !== undefined) out[key] = Math.max(0, value - (baseline[key] ?? 0));
  }
  if (counters.reportedUsd !== undefined)
    out.reportedUsd = Math.max(0, counters.reportedUsd - (baseline.reportedUsd ?? 0));
  if (counters.inputIncludesCache !== undefined)
    out.inputIncludesCache = counters.inputIncludesCache;
  return out;
};

interface NamedSource {
  readonly name: string;
  readonly counters: MeasurementCounters;
}

const describeConvention = (flag: boolean | undefined): string =>
  flag === true ? "inclusive" : flag === false ? "exclusive" : "unstated";

/**
 * The shared pure reconciliation of a segment's running sources, used by both
 * the one-shot and the incremental path so they cannot disagree.
 */
export const reconcileSources = (
  sources: Sources,
  sessionCumulative: SessionCumulative | undefined,
  options: ReconcileOptions,
): {
  counters: MeasurementCounters;
  coverage: Exclude<MeasurementCoverage, "legacy">;
  gaps: CoverageGap[];
  childCounters?: MeasurementCounters;
} => {
  const gaps: CoverageGap[] = [];

  // (d) Inclusion of children.
  const inclusion = sources.aggregateInclusion;
  const childRequests = sources.childRequests;
  const childrenExist = hasAnyCounters(childRequests);
  const requests = sources.requests;
  let addChildren = false;
  let childCounters: MeasurementCounters | undefined;
  if (childrenExist && childRequests !== undefined) {
    if (inclusion === "includes_children") {
      childCounters = childRequests;
    } else if (inclusion === "unknown") {
      gaps.push({
        reason: "native_child_unscoped",
        detail:
          "native child usage excluded: an aggregate source does not say whether it includes children",
        count: 1,
      });
    } else {
      // Under `self` (or with no aggregate at all) children are disjoint from the parent's evidence.
      addChildren = true;
      childCounters = childRequests;
    }
  }

  const named: NamedSource[] = [];
  if (hasAnyCounters(requests)) named.push({ name: "requests", counters: requests });
  if (hasAnyCounters(sources.latestLaunchSnapshot) && sources.latestLaunchSnapshot !== undefined) {
    named.push({ name: "snapshot", counters: sources.latestLaunchSnapshot });
  }
  const launchTerminal = hasAnyCounters(sources.terminal) ? sources.terminal : undefined;
  if (launchTerminal !== undefined) named.push({ name: "terminal", counters: launchTerminal });

  // (b) The session-scoped source is this segment's share only above the baseline.
  let sessionIncluded = false;
  if (sessionCumulative !== undefined) {
    if (!options.resumedSession) {
      sessionIncluded = true;
      named.push({
        name:
          sessionCumulative.kind === "terminal_summary" ? "session_terminal" : "session_snapshot",
        counters: sessionCumulative.counters,
      });
    } else if (options.baseline !== undefined) {
      sessionIncluded = true;
      named.push({
        name:
          sessionCumulative.kind === "terminal_summary" ? "session_terminal" : "session_snapshot",
        counters: subtractBaseline(sessionCumulative.counters, options.baseline),
      });
    } else {
      gaps.push({
        reason: "baseline_unknown",
        detail: "resumed session with no known baseline: session-scoped totals excluded",
        count: 1,
      });
    }
  }

  // (e) Conventions: differing known conventions are compared only where they cannot matter.
  const known = new Set(
    named.map((source) => source.counters.inputIncludesCache).filter((flag) => flag !== undefined),
  );
  const mismatch = known.size > 1;
  if (mismatch) {
    gaps.push({
      reason: "discrepancy",
      detail: `input token convention differs between sources: ${named
        .map((s) => `${s.name}=${describeConvention(s.counters.inputIncludesCache)}`)
        .join(", ")}`.slice(0, 400),
      count: 1,
    });
  }

  // (c) Maximum per counter; differences are recorded once, with a count.
  const counters: MeasurementCounters = {};
  const differences: string[] = [];
  for (const key of COUNTER_KEYS) {
    const present = named.filter((source) => source.counters[key] !== undefined);
    if (present.length === 0) continue;
    const values = present.map((source) => source.counters[key] ?? 0);
    const max = Math.max(...values);
    counters[key] = max;
    if (present.length < 2 || (mismatch && key === "inputTokens")) continue;
    const min = Math.min(...values);
    if (min === max) continue;
    const high = present.find((source) => source.counters[key] === max);
    const low = present.find((source) => source.counters[key] === min);
    differences.push(`${key}: ${high?.name} ${max} vs ${low?.name} ${min} (by ${max - min})`);
  }
  const reported = named.filter((source) => source.counters.reportedUsd !== undefined);
  if (reported.length > 0) {
    const values = reported.map((source) => source.counters.reportedUsd ?? 0);
    const max = Math.max(...values);
    counters.reportedUsd = max;
    const min = Math.min(...values);
    if (reported.length >= 2 && min !== max) {
      const high = reported.find((source) => source.counters.reportedUsd === max);
      const low = reported.find((source) => source.counters.reportedUsd === min);
      differences.push(`reportedUsd: ${high?.name} ${max} vs ${low?.name} ${min}`);
    }
  }
  if (differences.length > 0) {
    gaps.push({
      reason: "discrepancy",
      detail: `sources disagree; the larger is kept. ${differences.join("; ")}`.slice(0, 400),
      count: differences.length,
    });
  }
  const convention = mergeInputConvention(named.map((source) => source.counters));
  if (convention !== undefined) counters.inputIncludesCache = convention;

  // The parent's evidence is reconciled first; disjoint child usage is added after, so it never
  // takes part in the discrepancy comparison above.
  const total =
    addChildren && childCounters !== undefined ? addCounters(counters, childCounters) : counters;

  // (f) Coverage.
  // Dollars alone are not token evidence: they neither make coverage partial nor a terminal present.
  const terminalPresent =
    hasCounters(launchTerminal) ||
    (sessionIncluded &&
      sessionCumulative?.kind === "terminal_summary" &&
      hasCounters(sessionCumulative.counters));
  const coverage: Exclude<MeasurementCoverage, "legacy"> = terminalPresent
    ? (sources.terminalCoverage ?? "partial")
    : named.some((source) => hasCounters(source.counters))
      ? "partial"
      : "unknown";

  return {
    counters: total,
    coverage,
    gaps: coalesceGaps(gaps),
    ...(childCounters === undefined ? {} : { childCounters }),
  };
};

/** One launch segment's observations reconciled. Duplicate observation ids are dropped. */
export const reconcileSegment = (
  observations: readonly MeasurementObservation[],
  options: ReconcileOptions,
): SegmentReconciliation => {
  const seen = new Set<string>();
  let state = emptySegmentState();
  for (const observation of observations) {
    if (seen.has(observation.observationId)) continue;
    seen.add(observation.observationId);
    state = applyObservation(state, observation);
  }
  const reconciled = reconcileSources(state.sources, state.sessionCumulative, options);
  return {
    ...reconciled,
    observed: state.observed,
    sources: state.sources,
    ...(state.sessionCumulative === undefined
      ? {}
      : { sessionCumulative: state.sessionCumulative }),
  };
};

/** Disjoint segment shares summed, the convention merged as for sources. */
export const reconcileSegments = (
  segments: readonly { counters: MeasurementCounters }[],
): MeasurementCounters => sumCounters(segments.map((segment) => segment.counters));
