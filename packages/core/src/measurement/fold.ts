/**
 * Incremental counterparts of the reconciliation: one observation at a time,
 * keeping each segment's running `sources` instead of the observations. The
 * recounting is {@link reconcileSources}, shared with `reconcileSegment`.
 */
import type {
  Agent,
  ArtifactId,
  CoverageGap,
  LaunchRef,
  MeasurementCounters,
  MeasurementCoverage,
  MeasurementObservation,
  MeasurementSummary,
  RouteTarget,
  RoutingDecisionId,
  Segment,
} from "@nightshift/contracts";
import { compareSourceKeys, hasCounters, sumCounters } from "./counters.js";
import { coalesceGaps, subtractGaps } from "./gaps.js";
import { applyObservation, emptySegmentState, reconcileSources } from "./reconcile.js";

/** Most segments a summary lists; older closed ones are compacted. */
export const MAX_SEGMENTS = 64;
/** Most distinct models a summary lists. */
export const MAX_OBSERVED_MODELS = 16;
/** Most artifact ids a summary lists before the recorder rolls them into an index artifact. */
export const MAX_LEDGER_ARTIFACT_IDS = 512;
/** The launch id of the single entry that stands for compacted segments. */
export const COMPACTED_LAUNCH_ID = "compacted";

type TerminalSummaryObservation = Extract<MeasurementObservation, { kind: "terminal_summary" }>;

export interface EmptySummaryInput {
  readonly measurementSummaryId: MeasurementSummary["measurementSummaryId"];
  readonly scope: Pick<MeasurementSummary, "schemaVersion" | "projectId" | "programId" | "runId">;
  readonly executionNodeId: MeasurementSummary["executionNodeId"];
  readonly agent: Pick<Agent, "agentId" | "role">;
  readonly route: RouteTarget;
  readonly routingDecisionId: RoutingDecisionId | null;
  readonly at: string;
}

export const emptySummary = (input: EmptySummaryInput): MeasurementSummary => ({
  measurementVersion: 1,
  schemaVersion: input.scope.schemaVersion,
  projectId: input.scope.projectId,
  programId: input.scope.programId,
  runId: input.scope.runId,
  measurementSummaryId: input.measurementSummaryId,
  executionNodeId: input.executionNodeId,
  agentId: input.agent.agentId,
  role: input.agent.role,
  routingDecisionId: input.routingDecisionId,
  route: input.route,
  observedModels: [],
  segments: [],
  totals: {},
  coverage: "unknown",
  gaps: [],
  ledger: { chunks: 0, artifactIds: [], observationCount: 0, publishedCount: 0 },
  valuation: { source: "unknown" },
  createdAt: input.at,
  updatedAt: input.at,
});

export const rollupCoverage = (
  coverages: readonly MeasurementCoverage[],
  gapCount: number,
): MeasurementCoverage => {
  if (coverages.length === 0) return "unknown";
  if (coverages.every((c) => c === "legacy")) return "legacy";
  if (coverages.every((c) => c === "unknown")) return "unknown";
  if (coverages.every((c) => c === "complete")) return gapCount > 0 ? "partial" : "complete";
  return "partial";
};

const segmentOptions = (segment: Segment) => ({
  baseline: segment.baseline,
  resumedSession: segment.resumedSession,
});

const reconcileOf = (segment: Segment) =>
  reconcileSources(segment.sources, segment.sessionCumulative, segmentOptions(segment));

/** Rolls the segments up into the summary's totals, child counters and coverage. */
const rollup = (summary: MeasurementSummary, at: string): MeasurementSummary => {
  const children = summary.segments
    .map((segment) => reconcileOf(segment).childCounters)
    .filter((c): c is MeasurementCounters => c !== undefined);
  const { childCounters: _drop, ...rest } = summary;
  return {
    ...rest,
    ...(children.length === 0 ? {} : { childCounters: sumCounters(children) }),
    totals: sumCounters(summary.segments.map((segment) => segment.counters)),
    coverage: rollupCoverage(
      summary.segments.map((segment) => segment.coverage),
      summary.gaps.length,
    ),
    updatedAt: at,
  };
};

const indexOfSegment = (summary: MeasurementSummary, launch: LaunchRef): number => {
  const index = summary.segments.findIndex(
    (segment) => segment.launchId === launch.launchId && segment.segment === launch.segment,
  );
  if (index < 0) {
    throw new Error(`measurement summary has no segment ${launch.launchId}#${launch.segment}`);
  }
  return index;
};

const replaceSegment = (
  summary: MeasurementSummary,
  index: number,
  segment: Segment,
): MeasurementSummary => ({
  ...summary,
  segments: summary.segments.map((existing, i) => (i === index ? segment : existing)),
});

/** Appends a closed-by-compaction entry for the oldest closed segments when the list is full. */
const compactSegments = (
  summary: MeasurementSummary,
  room: number,
  at: string,
): MeasurementSummary => {
  if (summary.segments.length + room <= MAX_SEGMENTS) return summary;
  const existing = summary.segments.find((s) => s.launchId === COMPACTED_LAUNCH_ID);
  // Folding j closed segments into the compacted entry frees j (or j - 1 when it is new).
  const needed = summary.segments.length + room - MAX_SEGMENTS + (existing === undefined ? 1 : 0);
  const victims = summary.segments
    .filter((s) => !s.open && s.launchId !== COMPACTED_LAUNCH_ID)
    .slice(0, needed);
  if (victims.length < needed) {
    throw new Error(`measurement summary cannot hold more than ${MAX_SEGMENTS} open segments`);
  }
  const parts = existing === undefined ? victims : [existing, ...victims];
  const counters = sumCounters(parts.map((s) => s.counters));
  const compacted: Segment = {
    launchId: COMPACTED_LAUNCH_ID,
    segment: Math.max(...parts.map((s) => s.segment)),
    resumedSession: false,
    open: false,
    counters,
    coverage: rollupCoverage(
      parts.map((s) => s.coverage),
      0,
    ),
    sources: {
      requests: counters,
      requestCount: parts.reduce((sum, s) => sum + s.sources.requestCount, 0),
    },
    receivedSequence: 0,
    publishedSequence: 0,
    observed: {
      requests: parts.reduce((sum, s) => sum + s.observed.requests, 0),
      snapshots: parts.reduce((sum, s) => sum + s.observed.snapshots, 0),
      terminal: parts.some((s) => s.observed.terminal),
    },
  };
  const gone = new Set(victims);
  const remaining = summary.segments.filter(
    (s) => !gone.has(s) && s.launchId !== COMPACTED_LAUNCH_ID,
  );
  return {
    ...summary,
    segments: [compacted, ...remaining],
    gaps: coalesceGaps([
      ...summary.gaps,
      {
        reason: "other",
        detail: `${victims.length} older closed segments compacted into one entry`,
        from: at,
        to: at,
        count: 1,
      },
    ]),
  };
};

/** Appends an open segment for a launch. Starting a segment already listed changes nothing. */
export const startSegment = (
  summary: MeasurementSummary,
  launch: LaunchRef,
  options: {
    sessionId?: string | undefined;
    resumedSession: boolean;
    baseline?: MeasurementCounters | undefined;
    at: string;
  },
): MeasurementSummary => {
  const exists = summary.segments.some(
    (s) => s.launchId === launch.launchId && s.segment === launch.segment,
  );
  if (exists) return summary;
  const state = emptySegmentState();
  const segment: Segment = {
    launchId: launch.launchId,
    segment: launch.segment,
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    resumedSession: options.resumedSession,
    open: true,
    counters: {},
    coverage: "unknown",
    ...(options.baseline === undefined ? {} : { baseline: options.baseline }),
    sources: state.sources,
    receivedSequence: 0,
    publishedSequence: 0,
    observed: state.observed,
  };
  const compacted = compactSegments(summary, 1, options.at);
  return rollup({ ...compacted, segments: [...compacted.segments, segment] }, options.at);
};

const modelOf = (observation: MeasurementObservation): string | undefined =>
  observation.kind === "lifecycle"
    ? undefined
    : observation.kind === "request" ||
        observation.kind === "cumulative_snapshot" ||
        observation.kind === "terminal_summary"
      ? observation.model
      : undefined;

const sessionIdOf = (observation: MeasurementObservation): string | undefined =>
  observation.kind === "request" || observation.kind === "cumulative_snapshot"
    ? observation.sessionId
    : undefined;

/**
 * Folds one observation into its segment. Idempotent: a sequence already folded
 * returns the summary unchanged.
 */
export const foldObservation = (
  summary: MeasurementSummary,
  observation: MeasurementObservation,
  sequence: number,
  at: string,
): MeasurementSummary => {
  const launch = observation.launch;
  if (launch === undefined)
    throw new Error("an observation folded into a segment names its launch");
  return foldInto(summary, launch, observation, sequence, at);
};

const foldInto = (
  summary: MeasurementSummary,
  launch: LaunchRef,
  observation: MeasurementObservation,
  sequence: number,
  at: string,
  exitKind?: Segment["exitKind"],
): MeasurementSummary => {
  const index = indexOfSegment(summary, launch);
  const segment = summary.segments[index];
  if (segment === undefined || sequence <= segment.receivedSequence) return summary;

  const before = reconcileOf(segment);
  const state = applyObservation(segment, observation);
  const sessionId = segment.sessionId ?? sessionIdOf(observation);
  const next: Segment = {
    ...segment,
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(exitKind === undefined ? {} : { exitKind }),
    sources: state.sources,
    observed: state.observed,
    receivedSequence: sequence,
  };
  if (state.sessionCumulative !== undefined) next.sessionCumulative = state.sessionCumulative;
  const after = reconcileOf(next);
  next.counters = after.counters;
  next.coverage = after.coverage;

  const model = modelOf(observation);
  const observedModels =
    model === undefined ||
    summary.observedModels.includes(model) ||
    summary.observedModels.length >= MAX_OBSERVED_MODELS
      ? summary.observedModels
      : [...summary.observedModels, model];

  return rollup(
    {
      ...replaceSegment(summary, index, next),
      observedModels,
      gaps: coalesceGaps([...subtractGaps(summary.gaps, before.gaps), ...after.gaps]),
      ledger: { ...summary.ledger, observationCount: summary.ledger.observationCount + 1 },
    },
    at,
  );
};

/** Records a launch's terminal summary and how it ended. */
export const foldExit = (
  summary: MeasurementSummary,
  launch: LaunchRef,
  terminal: TerminalSummaryObservation,
  sequence: number,
  at: string,
): MeasurementSummary => foldInto(summary, launch, terminal, sequence, at, terminal.exitKind);

/** Marks a launch's segment no longer open. */
export const closeSegment = (
  summary: MeasurementSummary,
  launch: LaunchRef,
  at: string,
): MeasurementSummary => {
  const index = indexOfSegment(summary, launch);
  const segment = summary.segments[index];
  if (segment === undefined || !segment.open) return summary;
  return { ...replaceSegment(summary, index, { ...segment, open: false }), updatedAt: at };
};

/** Records a known hole in the evidence. */
export const markGap = (
  summary: MeasurementSummary,
  gap: Omit<CoverageGap, "count"> & { count?: number },
  at: string,
): MeasurementSummary =>
  rollup(
    { ...summary, gaps: coalesceGaps([...summary.gaps, { ...gap, count: gap.count ?? 1 }]) },
    at,
  );

/**
 * Records a published ledger chunk. Idempotent on the artifact id. The id is
 * always appended; when that takes the list past {@link MAX_LEDGER_ARTIFACT_IDS}
 * the result says `overflow`, and the recorder writes an index artifact holding
 * the listed ids and calls {@link rollLedgerIndex}.
 */
export const markPublished = (
  summary: MeasurementSummary,
  published: {
    segment: LaunchRef;
    artifactId: ArtifactId;
    toSequence: number;
    observations: number;
  },
  at: string,
): { summary: MeasurementSummary; overflow: boolean } => {
  if (summary.ledger.artifactIds.includes(published.artifactId)) {
    return { summary, overflow: false };
  }
  const index = indexOfSegment(summary, published.segment);
  const segment = summary.segments[index];
  if (segment === undefined) return { summary, overflow: false };
  const artifactIds = [...summary.ledger.artifactIds, published.artifactId];
  const next = replaceSegment(summary, index, {
    ...segment,
    publishedSequence: Math.min(
      segment.receivedSequence,
      Math.max(segment.publishedSequence, published.toSequence),
    ),
  });
  return {
    summary: {
      ...next,
      ledger: {
        ...summary.ledger,
        chunks: summary.ledger.chunks + 1,
        artifactIds,
        publishedCount: Math.min(
          summary.ledger.observationCount,
          summary.ledger.publishedCount + published.observations,
        ),
      },
      updatedAt: at,
    },
    overflow: artifactIds.length > MAX_LEDGER_ARTIFACT_IDS,
  };
};

/** The listed artifact ids now live in an index artifact: clear the list and point at the index. */
export const rollLedgerIndex = (
  summary: MeasurementSummary,
  indexArtifactId: ArtifactId,
  at: string,
): MeasurementSummary => ({
  ...summary,
  ledger: { ...summary.ledger, artifactIds: [], indexArtifactId },
  updatedAt: at,
});

/**
 * The session-scoped value a later launch of `sessionId` measures from: the
 * latest raw session cumulative among the segments that used it.
 */
export const baselineFor = (
  summary: MeasurementSummary,
  sessionId: string,
): MeasurementCounters | undefined => {
  let latest: NonNullable<Segment["sessionCumulative"]> | undefined;
  for (const segment of summary.segments) {
    const candidate = segment.sessionCumulative;
    if (segment.sessionId !== sessionId || candidate === undefined) continue;
    if (!hasCounters(candidate.counters)) continue;
    if (latest === undefined || compareSourceKeys(candidate, latest) >= 0) latest = candidate;
  }
  return latest?.counters;
};
