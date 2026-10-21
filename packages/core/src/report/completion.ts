/**
 * A completion history as the report reads it (D-05). Pure: records in, figures out.
 *
 * Three figures are kept apart because they answer different questions, and
 * none of them is human work time:
 * - lead time: the earliest member start to the earliest `worked` verdict. It
 *   includes every wait, and the person's own delay in rating.
 * - run completion: the earliest member start to the end of the run that was
 *   accepted. It stops where the run stopped, before any rating.
 * - active union: the length of the union of the members' run intervals, so
 *   overlapping runs count once and gaps between runs count not at all.
 *
 * Each member counts once. A checkpoint is reported from its stored
 * `measured` block alone, so no later change rewrites it.
 */
import type {
  CompletionCheckpoint,
  CompletionHistory,
  CompletionMeasurement,
  CompletionMemberRef,
  IsoTimestamp,
  Run,
  RunFeedback,
  RunStatus,
} from "@nightshift/contracts";
import { type FeedbackCoverage, feedbackCoverageOf } from "./feedback.js";
import type { InfrastructureReport } from "./infrastructure.js";
import type { ResourceTotals } from "./resources.js";

export interface CompletionMemberReport {
  readonly programId: string;
  readonly runId: string;
  readonly role: CompletionMemberRef["role"];
  readonly status?: RunStatus;
  readonly verdict: "worked" | "did_not_work" | "not_rated";
  readonly carriedStrands: number;
  /** The run is not in the records read: its figures are absent, not zero. */
  readonly unreadable?: true;
}

/** The model figures a completion shows; a checkpoint's measurement carries no more. */
export type CompletionResources = Pick<ResourceTotals, "tokens" | "usd" | "coverage">;

export interface CompletionRunRef {
  readonly programId: string;
  readonly runId: string;
}

export interface CompletionFigures {
  /** Calendar seconds, earliest member start to the verdict. Absent without a `worked` verdict. */
  readonly leadTimeSeconds?: number;
  readonly acceptedRun?: CompletionRunRef;
  /** Calendar seconds, earliest member start to the accepted run's end. */
  readonly runCompletionSeconds?: number;
  /** Seconds covered by at least one member's run interval; open runs run to `asOf`. */
  readonly activeSeconds: number;
  /** Absent, not zero, when no member contributed resource evidence. */
  readonly resources?: CompletionResources;
  /** Readable members whose resource evidence is in `resources`. */
  readonly measuredMembers: number;
  /** Readable members with no resource evidence: unavailable or genuinely unmeasured. */
  readonly unmeasuredMembers: number;
  /** The current view only: members whose measurement read failed, `${programId}/${runId}`. */
  readonly unavailable?: readonly string[];
  /** Machine dollars of the members' infrastructure reports, summed. */
  readonly infrastructure?: { readonly usd: number; readonly members: number };
  readonly membershipVersion: number;
}

export interface CompletionCheckpointReport extends CompletionFigures {
  readonly name: string;
  readonly recordedAt: string;
  readonly verdictRecordedAt: string;
}

export interface CompletionReport {
  readonly completionHistoryId: string;
  readonly title: string;
  readonly version: number;
  readonly members: readonly CompletionMemberReport[];
  readonly coverage: FeedbackCoverage;
  readonly current: CompletionFigures;
  readonly checkpoints: readonly CompletionCheckpointReport[];
  /** Current members that were not in the first checkpoint's snapshot. */
  readonly laterFixes: readonly CompletionMemberReport[];
}

export interface CompletionInput {
  readonly history: CompletionHistory;
  /** Keyed `${programId}/${runId}`. */
  readonly runs: ReadonlyMap<string, Run>;
  readonly feedback: ReadonlyMap<string, RunFeedback>;
  readonly resources?: ReadonlyMap<string, ResourceTotals>;
  readonly infrastructure?: ReadonlyMap<string, InfrastructureReport>;
  /** Members whose measurement read failed, keyed `${programId}/${runId}` with the reason. */
  readonly unavailable?: ReadonlyMap<string, string>;
  readonly asOf: string;
}

const keyOf = (ref: { readonly programId: string; readonly runId: string }): string =>
  `${ref.programId}/${ref.runId}`;
const ms = (value: string): number => Date.parse(value);

const unionSeconds = (spans: readonly { from: number; to: number }[]): number => {
  let total = 0;
  let end = Number.NEGATIVE_INFINITY;
  for (const s of [...spans].sort((a, b) => a.from - b.from)) {
    const from = Math.max(s.from, end);
    if (s.to > from) total += s.to - from;
    end = Math.max(end, s.to);
  }
  return total / 1000;
};

const add = (a: number | undefined, b: number | undefined): number | undefined =>
  b === undefined ? a : (a ?? 0) + b;

/** Sums resource totals; an absent counter adds nothing. */
const sumTotals = (items: readonly ResourceTotals[]): ResourceTotals => {
  const tokens: { -readonly [K in keyof ResourceTotals["tokens"]]: number | undefined } = {
    input: undefined,
    output: undefined,
    cacheRead: undefined,
    cacheWrite: undefined,
    reasoning: undefined,
    inputConventionUnknown: 0,
  };
  const coverage: ResourceTotals["coverage"] = {
    complete: 0,
    partial: 0,
    unknown: 0,
    legacy: 0,
    missing: 0,
  };
  let estimated = 0;
  let reported = 0;
  let unpriced = 0;
  for (const item of items) {
    tokens.input = add(tokens.input, item.tokens.input);
    tokens.output = add(tokens.output, item.tokens.output);
    tokens.cacheRead = add(tokens.cacheRead, item.tokens.cacheRead);
    tokens.cacheWrite = add(tokens.cacheWrite, item.tokens.cacheWrite);
    tokens.reasoning = add(tokens.reasoning, item.tokens.reasoning);
    tokens.inputConventionUnknown =
      (tokens.inputConventionUnknown ?? 0) + item.tokens.inputConventionUnknown;
    estimated += item.usd.estimated;
    reported += item.usd.reported;
    unpriced += item.unpriced;
    for (const key of Object.keys(coverage) as (keyof typeof coverage)[]) {
      coverage[key] += item.coverage[key];
    }
  }
  const present = Object.fromEntries(
    Object.entries(tokens).filter(([, value]) => value !== undefined),
  ) as unknown as ResourceTotals["tokens"];
  return {
    tokens: present,
    usd: { estimated, reported },
    unpriced,
    coverage,
    tokenCoverage: items.every((item) => item.tokenCoverage === "complete")
      ? "complete"
      : "partial",
  };
};

/** A member's totals carry evidence when they cover at least one attempt. */
const hasEvidence = (totals: ResourceTotals): boolean =>
  Object.values(totals.coverage).some((n) => n > 0);

/** The members of `keys` that contributed resource evidence, in order. */
const measuredOf = (
  keys: readonly string[],
  resources: ReadonlyMap<string, ResourceTotals> | undefined,
): ResourceTotals[] =>
  keys.flatMap((k) => {
    const found = resources?.get(k);
    return found === undefined || !hasEvidence(found) ? [] : [found];
  });

const verdictOf = (feedback: RunFeedback | undefined): CompletionMemberReport["verdict"] =>
  feedback?.verdict ?? "not_rated";

const sumResources = (items: readonly ResourceTotals[]): CompletionResources => {
  const { tokens, usd, coverage } = sumTotals(items);
  return { tokens, usd, coverage };
};

export interface MeasureCompletionInput {
  readonly members: readonly CompletionMemberRef[];
  /** Keyed `${programId}/${runId}`. */
  readonly runs: ReadonlyMap<string, Run>;
  readonly feedback: ReadonlyMap<string, RunFeedback>;
  readonly resources?: ReadonlyMap<string, ResourceTotals>;
  readonly infrastructure?: ReadonlyMap<string, InfrastructureReport>;
  readonly accepted: { readonly ref: CompletionRunRef; readonly verdictAt: string };
  /** Intervals are clipped here; open runs end here; later-started runs count for nothing. */
  readonly boundary: IsoTimestamp;
}

/**
 * The figures of a membership bounded at `boundary`. Pure. Tokens and dollars
 * are the totals of the records given, since measurement summaries carry no
 * time slices; every time figure is clipped at the boundary.
 */
export const measureCompletion = (
  input: MeasureCompletionInput,
): Omit<CompletionMeasurement, "recordedAt"> => {
  const boundary = ms(input.boundary);
  const keys = [...new Set(input.members.map(keyOf))];
  const readable = keys.flatMap((k) => {
    const run = input.runs.get(k);
    return run === undefined || ms(run.startedAt) > boundary ? [] : [{ key: k, run }];
  });
  const earliest =
    readable.length === 0 ? undefined : Math.min(...readable.map((m) => ms(m.run.startedAt)));
  const acceptedRun = input.runs.get(keyOf(input.accepted.ref));
  const present = <T>(map: ReadonlyMap<string, T> | undefined): T[] =>
    map === undefined
      ? []
      : readable.flatMap((m) => {
          const found = map.get(m.key);
          return found === undefined ? [] : [found];
        });
  const measured = measuredOf(
    readable.map((m) => m.key),
    input.resources,
  );
  const resources = measured.length === 0 ? undefined : sumResources(measured);
  const machines = input.infrastructure === undefined ? undefined : present(input.infrastructure);
  return {
    measuredTo: input.boundary,
    readableMembers: readable.length,
    measuredMembers: measured.length,
    unmeasuredMembers: readable.length - measured.length,
    ...(earliest === undefined
      ? {}
      : {
          earliestStart: new Date(earliest).toISOString() as IsoTimestamp,
          leadTimeSeconds: Math.max(
            0,
            (Math.min(ms(input.accepted.verdictAt), boundary) - earliest) / 1000,
          ),
        }),
    ...(earliest === undefined || acceptedRun?.endedAt === undefined
      ? {}
      : {
          runCompletionSeconds: Math.max(
            0,
            (Math.min(ms(acceptedRun.endedAt), boundary) - earliest) / 1000,
          ),
        }),
    activeSeconds: unionSeconds(
      readable.map((m) => ({
        from: ms(m.run.startedAt),
        to: Math.min(m.run.endedAt === undefined ? boundary : ms(m.run.endedAt), boundary),
      })),
    ),
    ...(resources === undefined
      ? {}
      : { tokens: resources.tokens, usd: resources.usd, coverage: resources.coverage }),
    ...(machines === undefined
      ? {}
      : {
          infrastructure: {
            usd: machines.reduce((sum, r) => sum + r.components.total.usd, 0),
            members: machines.length,
          },
        }),
  };
};

/** The live view: open runs run to `asOf`, and nothing is clipped. */
const figuresOf = (
  input: CompletionInput,
  members: readonly CompletionMemberRef[],
  version: number,
  accepted: { ref: CompletionRunRef; verdictAt: string } | undefined,
): CompletionFigures => {
  const readable = members.flatMap((m) => {
    const run = input.runs.get(keyOf(m));
    return run === undefined ? [] : [{ ref: m, run }];
  });
  const starts = readable.map((m) => ms(m.run.startedAt));
  const earliest = starts.length === 0 ? undefined : Math.min(...starts);
  const asOf = ms(input.asOf);
  const acceptedRun = accepted === undefined ? undefined : input.runs.get(keyOf(accepted.ref));
  const keys = [...new Set(members.map(keyOf))];
  const resources = input.resources;
  const infrastructure = input.infrastructure;
  const readableKeys = [...new Set(readable.map((m) => keyOf(m.ref)))];
  const totals = measuredOf(readableKeys, resources);
  const unavailable = readableKeys.filter((k) => input.unavailable?.has(k)).sort();
  const machines =
    infrastructure === undefined
      ? []
      : keys.flatMap((k) => {
          const found = infrastructure.get(k);
          return found === undefined ? [] : [found];
        });
  return {
    ...(accepted === undefined || earliest === undefined
      ? {}
      : { leadTimeSeconds: (ms(accepted.verdictAt) - earliest) / 1000 }),
    ...(accepted === undefined ? {} : { acceptedRun: accepted.ref }),
    ...(accepted === undefined || earliest === undefined || acceptedRun?.endedAt === undefined
      ? {}
      : { runCompletionSeconds: (ms(acceptedRun.endedAt) - earliest) / 1000 }),
    activeSeconds: unionSeconds(
      readable.map((m) => ({
        from: ms(m.run.startedAt),
        to: m.run.endedAt === undefined ? asOf : ms(m.run.endedAt),
      })),
    ),
    ...(totals.length === 0 ? {} : { resources: sumResources(totals) }),
    measuredMembers: totals.length,
    unmeasuredMembers: readableKeys.length - totals.length,
    ...(unavailable.length === 0 ? {} : { unavailable }),
    ...(infrastructure === undefined
      ? {}
      : {
          infrastructure: {
            usd: machines.reduce((sum, r) => sum + r.components.total.usd, 0),
            members: machines.length,
          },
        }),
    membershipVersion: version,
  };
};

/** A stored checkpoint, from its measurement alone. */
const checkpointFiguresOf = (c: CompletionCheckpoint): CompletionFigures => {
  const m = c.measured;
  return {
    ...(m.leadTimeSeconds === undefined ? {} : { leadTimeSeconds: m.leadTimeSeconds }),
    acceptedRun: { programId: c.programId, runId: c.runId },
    ...(m.runCompletionSeconds === undefined
      ? {}
      : { runCompletionSeconds: m.runCompletionSeconds }),
    activeSeconds: m.activeSeconds,
    measuredMembers: m.measuredMembers,
    unmeasuredMembers: m.unmeasuredMembers,
    ...(m.tokens === undefined || m.usd === undefined || m.coverage === undefined
      ? {}
      : {
          resources: {
            tokens: Object.fromEntries(
              Object.entries(m.tokens).filter(([, value]) => value !== undefined),
            ) as CompletionResources["tokens"],
            usd: m.usd,
            coverage: m.coverage,
          },
        }),
    ...(m.infrastructure === undefined ? {} : { infrastructure: m.infrastructure }),
    membershipVersion: c.membershipVersion,
  };
};

export const completionOf = (input: CompletionInput): CompletionReport => {
  const { history } = input;
  const seen = new Set<string>();
  const members = history.members.filter((m) => {
    const key = keyOf(m);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const memberReports = members.map((m): CompletionMemberReport => {
    const run = input.runs.get(keyOf(m));
    const feedback = input.feedback.get(keyOf(m));
    return {
      programId: m.programId,
      runId: m.runId,
      role: m.role,
      ...(run === undefined ? {} : { status: run.status }),
      verdict: verdictOf(feedback),
      carriedStrands: run?.carriedStrands?.length ?? 0,
      ...(run === undefined ? { unreadable: true as const } : {}),
    };
  });
  const readableRuns = members.flatMap((m) => {
    const run = input.runs.get(keyOf(m));
    return run === undefined ? [] : [run];
  });
  const readableFeedback = members.flatMap((m) => {
    const feedback = input.feedback.get(keyOf(m));
    return feedback === undefined || !input.runs.has(keyOf(m)) ? [] : [feedback];
  });

  let accepted: { ref: CompletionRunRef; verdictAt: string } | undefined;
  for (const m of members) {
    const feedback = input.feedback.get(keyOf(m));
    if (feedback?.verdict !== "worked" || !input.runs.has(keyOf(m))) continue;
    if (accepted === undefined || ms(feedback.recordedAt) < ms(accepted.verdictAt)) {
      accepted = {
        ref: { programId: m.programId, runId: m.runId },
        verdictAt: feedback.recordedAt,
      };
    }
  }

  const checkpoints = history.checkpoints.map(
    (c: CompletionCheckpoint): CompletionCheckpointReport => ({
      name: c.name,
      recordedAt: c.recordedAt,
      verdictRecordedAt: c.verdictRecordedAt,
      ...checkpointFiguresOf(c),
    }),
  );
  const first = [...history.checkpoints].sort((a, b) => ms(a.recordedAt) - ms(b.recordedAt))[0];
  const firstKeys = new Set((first?.members ?? []).map(keyOf));
  return {
    completionHistoryId: history.completionHistoryId,
    title: history.title,
    version: history.version,
    members: memberReports,
    coverage: feedbackCoverageOf(readableRuns, readableFeedback),
    current: figuresOf(input, members, history.version, accepted),
    checkpoints,
    laterFixes: first === undefined ? [] : memberReports.filter((m) => !firstKeys.has(keyOf(m))),
  };
};
