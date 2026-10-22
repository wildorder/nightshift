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
 * `measured` block alone, so no later change rewrites it. A checkpoint freezes
 * time and resources only: delivery, rework, review and bottleneck evidence
 * are history-wide figures of the live view (`current`), never stored.
 *
 * The live view also integrates the members' delivery, rework, review and
 * lifecycle evidence through the same pure reducers a single run uses. A work
 * item is `${programId}/${strandId}`; one attempted in several member runs
 * counts once, its first attempt the earliest, later attempts rework. A strand
 * a member carried over is counted by the run that built it, never again.
 */
import type {
  CarriedStrand,
  CompletionCheckpoint,
  CompletionCombined,
  CompletionHistory,
  CompletionMeasurement,
  CompletionMemberRef,
  ExecutionNode,
  IsoTimestamp,
  JobContract,
  RoutingDecision,
  Run,
  RunFeedback,
  RunStatus,
} from "@nightshift/contracts";
import {
  attemptsOfNode,
  type DeliveryReport,
  type FinalOutcome,
  failureReasonOf,
  finalOutcomeOf,
  workItemsOf,
} from "./delivery.js";
import { type FeedbackCoverage, feedbackCoverageOf } from "./feedback.js";
import type { InfrastructureReport } from "./infrastructure.js";
import type { OperationEndings, OperationUnions } from "./operations.js";
import type { PriceBasis, ResourceTotals } from "./resources.js";
import type { ReviewReport } from "./review.js";

export interface CompletionMemberReport {
  readonly programId: string;
  readonly runId: string;
  readonly role: CompletionMemberRef["role"];
  readonly status?: RunStatus;
  readonly verdict: "worked" | "did_not_work" | "not_rated";
  readonly carriedStrands: number;
  /** The member's own input and output tokens; absent when it contributed no evidence. */
  readonly tokens?: { readonly input?: number; readonly output?: number };
  /** The member's own API-equivalent estimate; absent when no attempt carried one. */
  readonly estimatedUsd?: number;
  /** The run is not in the records read: its figures are absent, not zero. */
  readonly unreadable?: true;
  /** The member's own delivery, rework, review and timing; absent without evidence. */
  readonly summary?: MemberSummary;
}

export interface MemberSummary {
  /** First attempt landed `succeeded` of `of` settled work items, in this run alone. */
  readonly firstAttempt: { readonly succeeded: number; readonly of: number };
  readonly reworkAttempts: number;
  readonly uniqueFindings: number;
  readonly elapsedMs?: number;
}

/** The pick of a run's OperationsReport a completion keeps. */
export interface CompactOperations {
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly elapsedMs?: number;
  readonly unions: OperationUnions;
  readonly endings: OperationEndings;
  readonly summedWorkMs: number;
}

/** One job node of a member run, with what the history-wide reducers need to deduplicate it. */
export interface WorkItemEvidence {
  /** `${programId}/${strandId}`; a node with no strand is its own identity. */
  readonly identity: string;
  readonly strandBearing: boolean;
  readonly repair: boolean;
  readonly nodeId: string;
  /** Earliest work attempt, else the node's creation. */
  readonly firstAt: string;
  /** Work attempts at this node (routing decisions with no purpose). */
  readonly attempts: number;
  readonly outcome: FinalOutcome;
  /** Why the node did not land, when it ended unsuccessfully. */
  readonly failure?: string;
}

/** What one readable member run contributes to a history's delivery, review and bottleneck figures. */
export interface MemberEvidence {
  readonly delivery: DeliveryReport;
  readonly review: ReviewReport;
  readonly operations: CompactOperations;
  readonly carriedStrands: readonly CarriedStrand[];
  readonly workItems: readonly WorkItemEvidence[];
}

/** The reasoning a node's end gives a later attempt for existing; absent when it did not fail. */
const failureLabelOf = (node: ExecutionNode, outcome: FinalOutcome): string | undefined => {
  if (outcome === "failed") {
    const reason = failureReasonOf(node.outcomeReason);
    return reason === "other" ? "failed" : reason;
  }
  return outcome === "verification_failed" ||
    outcome === "examination_failed" ||
    outcome === "cancelled" ||
    outcome === "interrupted"
    ? outcome
    : undefined;
};

/** The job nodes of one member run as identities, from the records `deliveryOf` reads. */
export const workItemEvidenceOf = (
  programId: string,
  runId: string,
  nodes: readonly ExecutionNode[],
  jobs: readonly JobContract[],
  routes: readonly RoutingDecision[],
): WorkItemEvidence[] => {
  const jobById = new Map(jobs.map((job) => [job.jobContractId as string, job]));
  return workItemsOf(nodes).map((node): WorkItemEvidence => {
    const job = node.jobContractId === null ? undefined : jobById.get(node.jobContractId);
    const attempts = attemptsOfNode(
      routes.filter((r) => r.executionNodeId === node.executionNodeId),
    );
    const outcome = finalOutcomeOf(node, nodes);
    const failure = failureLabelOf(node, outcome);
    const strandBearing = job?.strandId !== undefined;
    return {
      identity: strandBearing
        ? `${programId}/${job?.strandId}`
        : `${programId}/${runId}/${node.executionNodeId}`,
      strandBearing,
      repair: job?.repair !== undefined,
      nodeId: node.executionNodeId,
      firstAt: attempts[0]?.createdAt ?? node.createdAt,
      attempts: attempts.length,
      outcome,
      ...(failure === undefined ? {} : { failure }),
    };
  });
};

/** The model figures a completion shows; a checkpoint's measurement carries no more. */
export type CompletionResources = Pick<
  ResourceTotals,
  "tokens" | "usd" | "coverage" | "reportedAttempts" | "estimatedAttempts"
>;

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
  /**
   * Machine dollars of the members' infrastructure reports, summed. Absent, not
   * zero, when no member has a report; `withoutMachine` counts the readable
   * members with none (local runs, or none observed).
   */
  readonly infrastructure?: {
    readonly usd: number;
    readonly members: number;
    readonly withoutMachine: number;
  };
  /**
   * Model API-equivalent estimate plus machine estimate; a lower bound when
   * anything is missing, never a bill. Absent, not zero, when neither exists.
   */
  readonly combined?: CompletionCombined;
  readonly membershipVersion: number;
}

export interface CompletionCheckpointReport extends CompletionFigures {
  readonly name: string;
  readonly recordedAt: string;
  readonly verdictRecordedAt: string;
}

/** Members whose evidence a block covers; a missing member is listed, never counted as zero. */
export interface EvidenceCoverage {
  readonly withEvidence: number;
  readonly readable: number;
  /** Readable members with no evidence, `${programId}/${runId}`, with the reason when a read failed. */
  readonly unavailable: readonly string[];
  readonly reasons?: Readonly<Record<string, string>>;
}

export interface CompletionDelivery {
  /** Unique work items counted. */
  readonly workItems: number;
  readonly succeededFirstAttempt: number;
  /** Settled work items. */
  readonly denominator: number;
  readonly unfinished: number;
  /** Settled work items that ended cancelled; inside the denominator. */
  readonly cancelled: number;
  /** Work items attempted in more than one member run. */
  readonly reattemptedAcrossRuns: number;
  /** Carried strands whose building run is not a member: excluded, counted here. */
  readonly carriedFromOutside: number;
  readonly excludingRepairs: {
    readonly succeededFirstAttempt: number;
    readonly denominator: number;
    readonly unfinished: number;
  };
  readonly coverage: EvidenceCoverage;
}

export interface CompletionReworkRow {
  readonly kind: string;
  readonly attempts: number;
  /** Of `attempts`, those that are a later run re-attempting an identity. */
  readonly crossRunAttempts: number;
  readonly sharedAttempts: number;
}

export interface CompletionRework {
  /** Rework attempts, each once: the members' own plus cross-run re-attempts. */
  readonly attempts: number;
  readonly crossRunAttempts: number;
  readonly byCause: readonly CompletionReworkRow[];
  readonly unknownCause: number;
  readonly coverage: EvidenceCoverage;
}

export interface CompletionOverheadRow {
  readonly calls: number;
  readonly resources: CompletionResources;
}

export interface CompletionReview {
  readonly dispositions: {
    readonly upheld: number;
    readonly overturned: number;
    readonly risk_accepted: number;
  };
  /** Summed over members: findings are identified inside one run. */
  readonly uniqueFindings: number;
  readonly overhead: {
    readonly examiner: CompletionOverheadRow;
    readonly answerer: CompletionOverheadRow;
    readonly arbiter: CompletionOverheadRow;
    readonly planReview: CompletionOverheadRow;
  };
  readonly coverage: EvidenceCoverage;
}

export interface CompletionMemberOperations {
  readonly programId: string;
  readonly runId: string;
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly elapsedMs?: number;
  readonly unions: Pick<OperationUnions, "wait" | "queue" | "integration" | "examination">;
  readonly summedWorkMs: number;
}

export interface CompletionOperations {
  readonly members: readonly CompletionMemberOperations[];
  /** Summed over member runs: overlapping runs count twice, so this is not elapsed time. */
  readonly summed: {
    readonly wait: number;
    readonly queue: number;
    readonly integration: number;
    readonly examination: number;
    readonly summedWorkMs: number;
  };
  readonly coverage: EvidenceCoverage;
}

/** The live view: the frozen kinds of figure plus history-wide evidence, which a checkpoint never stores. */
export interface CompletionCurrentFigures extends CompletionFigures {
  /** Which readable members have evidence; absent only on figures built without any. */
  readonly evidenceCoverage?: EvidenceCoverage;
  readonly delivery?: CompletionDelivery;
  readonly rework?: CompletionRework;
  readonly review?: CompletionReview;
  readonly operations?: CompletionOperations;
}

export interface CompletionReport {
  readonly completionHistoryId: string;
  readonly title: string;
  readonly version: number;
  readonly members: readonly CompletionMemberReport[];
  readonly coverage: FeedbackCoverage;
  readonly current: CompletionCurrentFigures;
  readonly checkpoints: readonly CompletionCheckpointReport[];
  /** The time the current figures were read. */
  readonly asOf: string;
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
  /** Per-member delivery, review and bottleneck evidence, keyed `${programId}/${runId}`. */
  readonly evidence?: ReadonlyMap<string, MemberEvidence>;
  /** Members whose evidence records could not be read, keyed like `evidence`, with the reason. */
  readonly evidenceUnavailable?: ReadonlyMap<string, string>;
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
  let estimateIncomplete = 0;
  const priceBases: PriceBasis[] = [];
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
  let reportedAttempts = 0;
  let estimatedAttempts = 0;
  for (const item of items) {
    reportedAttempts += item.reportedAttempts ?? 0;
    estimatedAttempts += item.estimatedAttempts ?? 0;
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
    estimateIncomplete += item.estimateIncomplete ?? 0;
    for (const basis of item.priceBases ?? []) {
      if (
        !priceBases.some(
          (seen) =>
            seen.model === basis.model &&
            seen.source === basis.source &&
            seen.version === basis.version &&
            seen.incomplete === basis.incomplete,
        )
      ) {
        priceBases.push(basis);
      }
    }
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
    priceBases,
    estimateIncomplete,
    reportedAttempts,
    estimatedAttempts,
  };
};

/**
 * A member's totals carry evidence when they cover at least one attempt that
 * was observed. Launches with nothing measured (an unmeasured root, D-02) are
 * not evidence: a member with only those is unmeasured, not measured at zero.
 */
const hasEvidence = (totals: ResourceTotals): boolean =>
  Object.entries(totals.coverage).some(([kind, n]) => kind !== "missing" && n > 0);

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
  const { tokens, usd, coverage, reportedAttempts, estimatedAttempts } = sumTotals(items);
  return {
    tokens,
    usd,
    coverage,
    reportedAttempts: reportedAttempts ?? 0,
    estimatedAttempts: estimatedAttempts ?? 0,
  };
};

/**
 * The combined estimate: model estimate plus machine estimate. Reported dollars
 * never enter it. `readable` is the readable member count; `unavailable` the
 * members whose measurement read failed.
 */
const combinedOf = (
  measured: readonly ResourceTotals[],
  machines: readonly InfrastructureReport[],
  readable: number,
  unavailable = 0,
): CompletionCombined | undefined => {
  const totals = measured.length === 0 ? undefined : sumTotals(measured);
  const model =
    totals !== undefined && (totals.usd.estimated > 0 || (totals.priceBases ?? []).length > 0)
      ? totals.usd.estimated
      : undefined;
  const infrastructure =
    machines.length === 0
      ? undefined
      : machines.reduce((sum, r) => sum + r.components.total.usd, 0);
  if (model === undefined && infrastructure === undefined) return undefined;
  const estimateIncomplete = totals?.estimateIncomplete ?? 0;
  const membersWithoutMachine = readable - machines.length;
  const unmeasuredMembers = readable - measured.length;
  // A measured member whose root launch has no summary (D-02) leaves usage out: a lower bound.
  const unmeasuredLaunches = measured.some((member) => member.coverage.missing > 0);
  const attempts =
    totals === undefined ? 0 : Object.values(totals.coverage).reduce((a, b) => a + b, 0);
  const attemptsWithoutEstimate = Math.max(0, attempts - (totals?.estimatedAttempts ?? 0));
  return {
    usd: (model ?? 0) + (infrastructure ?? 0),
    ...(model === undefined ? {} : { model }),
    ...(infrastructure === undefined ? {} : { infrastructure }),
    coverage: {
      measuredMembers: measured.length,
      unmeasuredMembers,
      estimateIncomplete,
      membersWithoutMachine,
      attemptsWithoutEstimate,
    },
    lowerBound:
      model === undefined ||
      unmeasuredMembers > 0 ||
      unavailable > 0 ||
      unmeasuredLaunches ||
      estimateIncomplete > 0 ||
      attemptsWithoutEstimate > 0 ||
      membersWithoutMachine > 0,
    priceBases: [...(totals?.priceBases ?? [])],
  };
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
  const combined = combinedOf(measured, machines ?? [], readable.length);
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
      : {
          tokens: resources.tokens,
          usd: resources.usd,
          ...(resources.reportedAttempts === undefined
            ? {}
            : { reportedAttempts: resources.reportedAttempts }),
          ...(resources.estimatedAttempts === undefined
            ? {}
            : { estimatedAttempts: resources.estimatedAttempts }),
          coverage: resources.coverage,
        }),
    ...(machines === undefined || machines.length === 0
      ? {}
      : {
          infrastructure: {
            usd: machines.reduce((sum, r) => sum + r.components.total.usd, 0),
            members: machines.length,
            withoutMachine: readable.length - machines.length,
          },
        }),
    ...(combined === undefined ? {} : { combined }),
  };
};

const REWORK_LATER_RUN = "re-attempted in a later run";

const coverageOf = (
  readableKeys: readonly string[],
  evidence: ReadonlyMap<string, MemberEvidence> | undefined,
  reasonOf: ReadonlyMap<string, string> | undefined,
): EvidenceCoverage => {
  const unavailable = readableKeys.filter((k) => !evidence?.has(k)).sort();
  const reasons = unavailable.flatMap((k) => {
    const reason = reasonOf?.get(k);
    return reason === undefined ? [] : [[k, reason] as const];
  });
  return {
    withEvidence: readableKeys.length - unavailable.length,
    readable: readableKeys.length,
    unavailable,
    ...(reasons.length === 0 ? {} : { reasons: Object.fromEntries(reasons) }),
  };
};

/** The history-wide blocks of the live view; absent, not zero, for members with no evidence. */
const evidenceFiguresOf = (
  readableKeys: readonly string[],
  evidence: ReadonlyMap<string, MemberEvidence> | undefined,
  reasons: ReadonlyMap<string, string> | undefined,
): Pick<
  CompletionCurrentFigures,
  "evidenceCoverage" | "delivery" | "rework" | "review" | "operations"
> => {
  if (evidence === undefined) return {};
  const coverage = coverageOf(readableKeys, evidence, reasons);
  const withEvidence = readableKeys.flatMap((key) => {
    const found = evidence?.get(key);
    return found === undefined ? [] : [{ key, found }];
  });
  if (withEvidence.length === 0) return { evidenceCoverage: coverage };

  // Delivery: one work item per identity, earliest attempt first.
  const memberKeys = new Set(readableKeys);
  const nodesOf = new Map<string, { key: string; item: WorkItemEvidence }[]>();
  const carriedOutside = new Set<string>();
  for (const { key, found } of withEvidence) {
    const programId = key.slice(0, key.indexOf("/"));
    const carried = new Set(found.carriedStrands.map((c) => `${programId}/${c.strandId}`));
    for (const c of found.carriedStrands) {
      if (!memberKeys.has(`${programId}/${c.fromRunId}`))
        carriedOutside.add(`${programId}/${c.strandId}`);
    }
    for (const item of found.workItems) {
      if (item.strandBearing && carried.has(item.identity)) continue;
      nodesOf.set(item.identity, [...(nodesOf.get(item.identity) ?? []), { key, item }]);
    }
  }
  let succeeded = 0;
  let denominator = 0;
  let unfinished = 0;
  let cancelled = 0;
  let reattempted = 0;
  const plain = { succeeded: 0, denominator: 0, unfinished: 0 };
  const crossRun = new Map<string, number>();
  for (const entries of nodesOf.values()) {
    const ordered = [...entries].sort((a, b) => ms(a.item.firstAt) - ms(b.item.firstAt));
    const last = ordered[ordered.length - 1]?.item;
    if (last === undefined) continue;
    const attempts = ordered.reduce((n, e) => n + e.item.attempts, 0);
    const settled = last.outcome !== "unfinished";
    const won = last.outcome === "landed" && attempts === 1 ? 1 : 0;
    succeeded += won;
    denominator += settled ? 1 : 0;
    unfinished += settled ? 0 : 1;
    if (last.outcome === "cancelled") cancelled += 1;
    if (!ordered.some((e) => e.item.repair)) {
      plain.succeeded += won;
      plain.denominator += settled ? 1 : 0;
      plain.unfinished += settled ? 0 : 1;
    }
    // A node in a member run later than the identity's first run re-attempts it.
    const firstKey = ordered[0]?.key;
    if (ordered.some((e) => e.key !== firstKey)) reattempted += 1;
    ordered.forEach((entry, index) => {
      if (entry.key === firstKey || entry.item.attempts === 0) return;
      const label = ordered[index - 1]?.item.failure ?? REWORK_LATER_RUN;
      crossRun.set(label, (crossRun.get(label) ?? 0) + 1);
    });
  }
  const delivery: CompletionDelivery = {
    workItems: nodesOf.size,
    succeededFirstAttempt: succeeded,
    denominator,
    unfinished,
    cancelled,
    reattemptedAcrossRuns: reattempted,
    carriedFromOutside: carriedOutside.size,
    excludingRepairs: {
      succeededFirstAttempt: plain.succeeded,
      denominator: plain.denominator,
      unfinished: plain.unfinished,
    },
    coverage,
  };

  // Rework: the per-run rows summed, plus attempts that are a later run re-attempting an identity.
  const rows = new Map<
    string,
    { attempts: number; crossRunAttempts: number; sharedAttempts: number }
  >();
  const row = (kind: string) => {
    const found = rows.get(kind) ?? { attempts: 0, crossRunAttempts: 0, sharedAttempts: 0 };
    rows.set(kind, found);
    return found;
  };
  let reworkAttempts = 0;
  let unknownCause = 0;
  for (const { found } of withEvidence) {
    reworkAttempts += found.delivery.rework.attempts;
    unknownCause += found.delivery.rework.unknownCause.attempts;
    for (const r of found.delivery.rework.byCause) {
      row(r.kind).attempts += r.attempts;
      row(r.kind).sharedAttempts += r.sharedAttempts;
    }
  }
  let crossRunTotal = 0;
  for (const [kind, n] of crossRun) {
    row(kind).attempts += n;
    row(kind).crossRunAttempts += n;
    crossRunTotal += n;
  }
  const rework: CompletionRework = {
    attempts: reworkAttempts + crossRunTotal,
    crossRunAttempts: crossRunTotal,
    byCause: [...rows.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([kind, r]) => ({ kind, ...r })),
    unknownCause,
    coverage,
  };

  // Review: dispositions and overhead summed over members.
  const dispositions = { upheld: 0, overturned: 0, risk_accepted: 0 };
  let uniqueFindings = 0;
  for (const { found } of withEvidence) {
    uniqueFindings += found.review.dispositions.unique;
    for (const k of Object.keys(dispositions) as (keyof typeof dispositions)[]) {
      dispositions[k] += found.review.dispositions.rulings[k];
    }
  }
  const overheadOf = (kind: keyof ReviewReport["overhead"]): CompletionOverheadRow => ({
    calls: withEvidence.reduce((n, { found }) => n + found.review.overhead[kind].calls, 0),
    resources: sumResources(withEvidence.map(({ found }) => found.review.overhead[kind].resources)),
  });
  const review: CompletionReview = {
    dispositions,
    uniqueFindings,
    overhead: {
      examiner: overheadOf("examiner"),
      answerer: overheadOf("answerer"),
      arbiter: overheadOf("arbiter"),
      planReview: overheadOf("planReview"),
    },
    coverage,
  };

  // Bottlenecks: unions of each member run, summed as they are (overlap counts twice).
  const members = withEvidence.map(({ key, found }): CompletionMemberOperations => {
    const [programId = "", runId = ""] = key.split("/");
    const o = found.operations;
    return {
      programId,
      runId,
      startedAt: o.startedAt,
      ...(o.endedAt === undefined ? {} : { endedAt: o.endedAt }),
      ...(o.elapsedMs === undefined ? {} : { elapsedMs: o.elapsedMs }),
      unions: {
        wait: o.unions.wait,
        queue: o.unions.queue,
        integration: o.unions.integration,
        examination: o.unions.examination,
      },
      summedWorkMs: o.summedWorkMs,
    };
  });
  const total = (pick: (m: CompletionMemberOperations) => number): number =>
    members.reduce((n, m) => n + pick(m), 0);
  const operations: CompletionOperations = {
    members,
    summed: {
      wait: total((m) => m.unions.wait),
      queue: total((m) => m.unions.queue),
      integration: total((m) => m.unions.integration),
      examination: total((m) => m.unions.examination),
      summedWorkMs: total((m) => m.summedWorkMs),
    },
    coverage,
  };
  return { evidenceCoverage: coverage, delivery, rework, review, operations };
};

/** The live view: open runs run to `asOf`, and nothing is clipped. */
const figuresOf = (
  input: CompletionInput,
  members: readonly CompletionMemberRef[],
  version: number,
  accepted: { ref: CompletionRunRef; verdictAt: string } | undefined,
): CompletionCurrentFigures => {
  const readable = members.flatMap((m) => {
    const run = input.runs.get(keyOf(m));
    return run === undefined ? [] : [{ ref: m, run }];
  });
  const starts = readable.map((m) => ms(m.run.startedAt));
  const earliest = starts.length === 0 ? undefined : Math.min(...starts);
  const asOf = ms(input.asOf);
  const acceptedRun = accepted === undefined ? undefined : input.runs.get(keyOf(accepted.ref));
  const resources = input.resources;
  const infrastructure = input.infrastructure;
  const readableKeys = [...new Set(readable.map((m) => keyOf(m.ref)))];
  const totals = measuredOf(readableKeys, resources);
  const unavailable = readableKeys.filter((k) => input.unavailable?.has(k)).sort();
  const machines =
    infrastructure === undefined
      ? []
      : readableKeys.flatMap((k) => {
          const found = infrastructure.get(k);
          return found === undefined ? [] : [found];
        });
  const combined = combinedOf(totals, machines, readableKeys.length, unavailable.length);
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
    ...(machines.length === 0
      ? {}
      : {
          infrastructure: {
            usd: machines.reduce((sum, r) => sum + r.components.total.usd, 0),
            members: machines.length,
            withoutMachine: readableKeys.length - machines.length,
          },
        }),
    ...(combined === undefined ? {} : { combined }),
    ...evidenceFiguresOf(readableKeys, input.evidence, input.evidenceUnavailable),
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
            ...(m.reportedAttempts === undefined ? {} : { reportedAttempts: m.reportedAttempts }),
            ...(m.estimatedAttempts === undefined
              ? {}
              : { estimatedAttempts: m.estimatedAttempts }),
            coverage: m.coverage,
          },
        }),
    ...(m.infrastructure === undefined ? {} : { infrastructure: m.infrastructure }),
    ...(m.combined === undefined ? {} : { combined: m.combined }),
    membershipVersion: c.membershipVersion,
  };
};

/** A member's own tokens and estimate, when it contributed evidence; absent is not zero. */
const memberOwnFiguresOf = (
  totals: ResourceTotals | undefined,
): Pick<CompletionMemberReport, "tokens" | "estimatedUsd"> => {
  if (totals === undefined || !hasEvidence(totals)) return {};
  const { input, output } = totals.tokens;
  return {
    ...(input === undefined && output === undefined
      ? {}
      : {
          tokens: {
            ...(input === undefined ? {} : { input }),
            ...(output === undefined ? {} : { output }),
          },
        }),
    ...((totals.estimatedAttempts ?? 0) > 0 ? { estimatedUsd: totals.usd.estimated } : {}),
  };
};

const memberSummaryOf = (
  evidence: MemberEvidence | undefined,
): Pick<CompletionMemberReport, "summary"> =>
  evidence === undefined
    ? {}
    : {
        summary: {
          firstAttempt: {
            succeeded: evidence.delivery.firstAttempt.succeeded,
            of: evidence.delivery.firstAttempt.denominator,
          },
          reworkAttempts: evidence.delivery.rework.attempts,
          uniqueFindings: evidence.review.dispositions.unique,
          ...(evidence.operations.elapsedMs === undefined
            ? {}
            : { elapsedMs: evidence.operations.elapsedMs }),
        },
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
      ...memberOwnFiguresOf(input.resources?.get(keyOf(m))),
      ...memberSummaryOf(input.evidence?.get(keyOf(m))),
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
    asOf: input.asOf,
    laterFixes: first === undefined ? [] : memberReports.filter((m) => !firstKeys.has(keyOf(m))),
  };
};

const NOT_OBSERVED_TEXT = "not observed";

const secondsText = (value: number): string => `${Number((value / 1000).toFixed(3))}s`;

const coverageText = (c: EvidenceCoverage): string =>
  `evidence from ${c.withEvidence} of ${c.readable} members${
    c.unavailable.length === 0
      ? ""
      : `; no evidence for ${c.unavailable
          .map((k) => (c.reasons?.[k] === undefined ? k : `${k} (${c.reasons[k]})`))
          .join(", ")}`
  }`;

/**
 * The live view's delivery, rework, review and bottleneck lines. One text for
 * the rendered report and the CLI, so both say the same thing. Missing
 * evidence reads "not observed", never zero.
 */
export const completionEvidenceLines = (current: CompletionCurrentFigures): string[] => {
  const { delivery: d, rework: w, review: r, operations: o } = current;
  const suffix = (c: EvidenceCoverage) => `; ${coverageText(c)}`;
  const tokens = (rows: readonly CompletionOverheadRow[], key: "input" | "output"): string => {
    const values = rows.map((row) => row.resources.tokens[key]).filter((v) => v !== undefined);
    return values.length === 0 ? NOT_OBSERVED_TEXT : String(values.reduce((a, b) => a + b, 0));
  };
  return [
    d === undefined
      ? `delivery: ${NOT_OBSERVED_TEXT} (${current.evidenceCoverage === undefined ? "no evidence gathered" : coverageText(current.evidenceCoverage)})`
      : `delivery: first attempt succeeded ${d.succeededFirstAttempt} of ${d.denominator} settled work items (${d.unfinished} unfinished, ${d.cancelled} cancelled), ${d.reattemptedAcrossRuns} re-attempted across runs${
          d.carriedFromOutside === 0
            ? ""
            : `, ${d.carriedFromOutside} carried from a run outside the history (not counted)`
        }${suffix(d.coverage)}`,
    w === undefined
      ? `rework: ${NOT_OBSERVED_TEXT}`
      : `rework: ${w.attempts} attempts${
          w.byCause.length === 0
            ? ""
            : ` — ${w.byCause.map((row) => `${row.kind} ${row.attempts}`).join(", ")}`
        }${w.unknownCause === 0 ? "" : `; ${w.unknownCause} with no recorded cause`}; ${w.crossRunAttempts} from later runs re-attempting${suffix(w.coverage)}`,
    r === undefined
      ? `review: ${NOT_OBSERVED_TEXT}`
      : `review: dispositions upheld ${r.dispositions.upheld}, overturned ${r.dispositions.overturned}, risk accepted ${r.dispositions.risk_accepted}; ${r.uniqueFindings} unique finding${r.uniqueFindings === 1 ? "" : "s"}; overhead examiner ${r.overhead.examiner.calls} calls, answerer ${r.overhead.answerer.calls}, arbiter ${r.overhead.arbiter.calls}, plan review ${r.overhead.planReview.calls}, tokens in ${tokens(Object.values(r.overhead), "input")}, out ${tokens(Object.values(r.overhead), "output")}${suffix(r.coverage)}`,
    o === undefined
      ? `bottlenecks: ${NOT_OBSERVED_TEXT}`
      : `bottlenecks, summed over member runs (not elapsed): waiting ${secondsText(o.summed.wait)}, queue ${secondsText(o.summed.queue)}, integration ${secondsText(o.summed.integration)}, examination ${secondsText(o.summed.examination)}; work ${secondsText(o.summed.summedWorkMs)}${suffix(o.coverage)}`,
  ];
};
