/**
 * Where a run's elapsed time went, from lifecycle observations (P20, S-05).
 * Pure: records and observations in, a report out.
 *
 * Operations are rebuilt into occurrences by observed boundaries only. An
 * operation with a start and no end is open and is never closed by `asOf`, the
 * run's end or the node's status; its observed-so-far time is reported apart
 * (`ambiguousMs`) and kept out of every union. Overlapping and shared
 * intervals are merged before they are summed, so they count once.
 */
import type {
  Agent,
  AttemptCause,
  Examination,
  ExecutionNode,
  IsoTimestamp,
  JobContract,
  LifecycleObservation,
  RoutingDecision,
  Run,
  Verification,
} from "@nightshift/contracts";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export type OperationState = "closed" | "open" | "end_only" | "incomplete";
export type TimeSource = "occurredAt" | "receivedAt";

export interface BlockerSpan {
  readonly from: IsoTimestamp;
  /** Absent while the span was never observed to end. */
  readonly to?: IsoTimestamp;
  readonly blockers: readonly { readonly kind: string; readonly ref: string }[];
}

export interface OperationNote {
  readonly at: IsoTimestamp;
  readonly reason: string;
}

export interface OperationInterval {
  readonly operationId: string;
  /** 1 for the first occurrence of this operation; a re-entry is the next. */
  readonly occurrence: number;
  readonly nodeId: string;
  readonly phase: string;
  readonly attempt?: number;
  readonly agentId?: string;
  readonly launch?: {
    readonly agentId: string;
    readonly launchId: string;
    readonly segment: number;
  };
  readonly startedAt?: IsoTimestamp;
  readonly endedAt?: IsoTimestamp;
  readonly state: OperationState;
  /** The end's reason when it ended, else the start's. */
  readonly reason?: string;
  readonly notes: readonly OperationNote[];
  readonly refs: readonly { readonly kind: string; readonly ref: string }[];
  readonly parentOperationId?: string;
  readonly blockerSpans: readonly BlockerSpan[];
  /** Closed intervals only. */
  readonly durationMs?: number;
  /** For `incomplete`: the next start, up to which time was observed. */
  readonly observedUntil?: IsoTimestamp;
  /** `occurredAt` only when every boundary used it; otherwise `receivedAt`. */
  readonly timeSource: TimeSource;
}

export interface NodeTimeline {
  readonly nodeId: string;
  readonly kind: string;
  readonly status: string;
  readonly operations: readonly OperationInterval[];
  /** Union of the node's closed intervals per phase. */
  readonly byPhase: Readonly<Record<string, number>>;
  /** Earliest start to latest end; `to` is absent while anything is unfinished. */
  readonly activeSpan?: { readonly from: IsoTimestamp; readonly to?: IsoTimestamp };
  /** Active span minus the union of the closed phase intervals; absent without a closed span. */
  readonly unattributedMs?: number;
  readonly openCount: number;
  readonly incompleteCount: number;
  readonly coverage: "observed" | "legacy";
  /** Legacy nodes only: the union of the agents' startedAt..endedAt, not an observed phase. */
  readonly legacyWorkMs?: number;
}

export interface ConcurrencyPoint {
  readonly at: IsoTimestamp;
  readonly running: number;
}

export interface OperationEndings {
  readonly integrated: number;
  readonly merged: number;
  readonly integration_conflict: number;
  readonly verification_failed: number;
  readonly deferred: number;
  readonly examination_stopped: number;
  readonly failed: number;
  /** Integration ends with any other reason, or none. */
  readonly other: number;
  /** Integration notes whose reason starts "examination: skipped". */
  readonly examinationSkipped: number;
}

export interface OperationUnions {
  readonly work: number;
  readonly wait: number;
  readonly waitByBlockerKind: Readonly<Record<string, number>>;
  readonly queue: number;
  readonly integration: number;
  /** examination + answer + arbitration + plan_review */
  readonly examination: number;
  readonly setup: number;
  readonly startup: number;
  /** From Verification records' startedAt..endedAt, not from observations. */
  readonly verification: number;
}

export type ChainLink = "end" | "queue_order" | "work" | "dependency" | "attempt" | "retry";

export interface ChainStep {
  readonly operationId: string;
  readonly occurrence: number;
  readonly nodeId: string;
  readonly phase: string;
  readonly from: IsoTimestamp;
  readonly to: IsoTimestamp;
  /** How the walk reached this step from the one after it. */
  readonly link: ChainLink;
  readonly causes?: readonly AttemptCause[];
}

export interface ChainCandidate {
  readonly operationId: string;
  readonly occurrence: number;
  readonly nodeId: string;
  readonly phase: string;
  readonly link: ChainLink;
}

export interface ChainAmbiguity {
  /** The step whose predecessor was a tie within 1 ms. */
  readonly operationId: string;
  readonly occurrence: number;
  readonly candidates: readonly ChainCandidate[];
}

/** An observed chain of boundaries; never a claim about a faster schedule. */
export interface ObservedChain {
  readonly steps: readonly ChainStep[];
  readonly coveredMs: number;
  readonly elapsedMs?: number;
  readonly coverage?: number;
  readonly incomplete: boolean;
  readonly stoppedBecause?: string;
  readonly ambiguous: readonly ChainAmbiguity[];
}

export interface OperationsReport {
  readonly asOf: IsoTimestamp;
  readonly startedAt: IsoTimestamp;
  readonly endedAt?: IsoTimestamp;
  readonly elapsedMs?: number;
  readonly operations: readonly OperationInterval[];
  readonly nodes: readonly NodeTimeline[];
  readonly concurrency: {
    readonly series: readonly ConcurrencyPoint[];
    readonly peak: number;
    /** Closed work time over elapsed; open work is not counted, so a lower bound. */
    readonly averageOverElapsed?: number;
  };
  readonly unions: OperationUnions;
  /** Elapsed minus the union of every closed phase interval, within the run's window. */
  readonly unattributedMs?: number;
  /** Observed-so-far time of open and incomplete intervals; inside no union. */
  readonly ambiguousMs: number;
  readonly endings: OperationEndings;
  /** The union of legacy nodes' agent intervals, labelled as such. */
  readonly legacyWorkMs: number;
  readonly chain: ObservedChain;
}

export interface OperationsInput {
  readonly run: Run;
  readonly nodes: readonly ExecutionNode[];
  readonly jobs: readonly JobContract[];
  readonly agents: readonly Agent[];
  readonly routes: readonly RoutingDecision[];
  readonly verifications: readonly Verification[];
  readonly examinations: readonly Examination[];
  readonly observations: readonly LifecycleObservation[];
  readonly asOf: IsoTimestamp;
}

type Ref = { readonly kind: string; readonly ref: string };
type Span = readonly [number, number];

const EXAMINATION_PHASES = ["examination", "answer", "arbitration", "plan_review"];
const TIE_MS = 1;
const FAILED_ENDINGS = new Set([
  "integration_conflict",
  "verification_failed",
  "deferred",
  "examination_stopped",
  "failed",
]);
const CAPACITY_KINDS = new Set(["parent_slot", "wall_clock", "budget"]);

const iso = (ms: number): IsoTimestamp => new Date(ms).toISOString() as IsoTimestamp;
const ms = (at: string): number => Date.parse(at);

/** Merged, sorted, non-overlapping spans. */
const mergeSpans = (spans: readonly Span[]): Span[] => {
  const sorted = spans.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const out: [number, number][] = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
};
const totalOf = (spans: readonly Span[]): number =>
  mergeSpans(spans).reduce((sum, [a, b]) => sum + (b - a), 0);

const blockerKey = (blockers: readonly Ref[]): string =>
  blockers
    .map((b) => `${b.kind}\u0000${b.ref}`)
    .sort()
    .join("\u0001");

interface Built {
  readonly iv: Mutable<OperationInterval>;
  readonly notes: OperationNote[];
  readonly refs: Ref[];
  readonly spans: Mutable<BlockerSpan>[];
  startMs?: number;
  endMs?: number;
  untilMs?: number;
  allOccurred: boolean;
}

const setBlockers = (b: Built, at: number, blockers: readonly Ref[]): void => {
  const last = b.spans[b.spans.length - 1];
  const open = last !== undefined && last.to === undefined;
  if (blockerKey(blockers) === (open ? blockerKey(last.blockers) : "")) return;
  if (open) last.to = iso(at);
  if (blockers.length > 0)
    b.spans.push({ from: iso(at), blockers: blockers.map((x) => ({ ...x })) });
};

const absorb = (b: Built, o: LifecycleObservation): void => {
  const iv = b.iv;
  if (iv.attempt === undefined && o.attempt !== undefined) iv.attempt = o.attempt;
  if (iv.agentId === undefined && o.agentId !== undefined) iv.agentId = o.agentId;
  if (iv.launch === undefined && o.launch !== undefined) iv.launch = o.launch;
  if (iv.parentOperationId === undefined && o.parentOperationId !== undefined) {
    iv.parentOperationId = o.parentOperationId;
  }
  for (const ref of o.refs ?? []) {
    if (!b.refs.some((r) => r.kind === ref.kind && r.ref === ref.ref)) b.refs.push({ ...ref });
  }
  if (o.occurredAt === undefined) b.allOccurred = false;
};

const buildIntervals = (observations: readonly LifecycleObservation[]): Built[] => {
  const groups = new Map<string, LifecycleObservation[]>();
  for (const o of observations) {
    const group = groups.get(o.operationId);
    if (group === undefined) groups.set(o.operationId, [o]);
    else group.push(o);
  }
  const all: Built[] = [];
  for (const [operationId, group] of groups) {
    let occurrence = 0;
    let current: Built | undefined;
    const open = (o: LifecycleObservation, state: OperationState): Built => {
      occurrence += 1;
      const notes: OperationNote[] = [];
      const refs: Ref[] = [];
      const spans: Mutable<BlockerSpan>[] = [];
      const built: Built = {
        iv: {
          operationId,
          occurrence,
          nodeId: o.executionNodeId,
          phase: o.phase,
          state,
          notes,
          refs,
          blockerSpans: spans,
          timeSource: "occurredAt",
        },
        notes,
        refs,
        spans,
        allOccurred: true,
      };
      absorb(built, o);
      all.push(built);
      return built;
    };
    for (const o of group) {
      const at = ms(o.occurredAt ?? o.receivedAt);
      if (o.transition === "start") {
        const isOpen =
          current !== undefined && current.startMs !== undefined && current.endMs === undefined;
        if (current !== undefined && isOpen && o.reason === "recovered") {
          absorb(current, o);
          current.notes.push({ at: iso(at), reason: "recovered" });
          if (o.blockers.length > 0) setBlockers(current, at, o.blockers);
          continue;
        }
        if (current !== undefined && isOpen) {
          current.iv.state = "incomplete";
          current.untilMs = at;
        }
        current = open(o, "open");
        current.startMs = at;
        if (o.reason !== undefined) current.iv.reason = o.reason;
        setBlockers(current, at, o.blockers);
      } else if (o.transition === "end") {
        const closable =
          current !== undefined && current.startMs !== undefined && current.endMs === undefined;
        if (current === undefined || !closable) {
          current = open(o, "end_only");
        } else {
          absorb(current, o);
        }
        current.endMs = at;
        const last = current.spans[current.spans.length - 1];
        if (last !== undefined && last.to === undefined) last.to = iso(at);
        if (o.reason !== undefined) current.iv.reason = o.reason;
        if (current.startMs !== undefined) current.iv.state = "closed";
      } else if (current !== undefined) {
        absorb(current, o);
        if (o.reason !== undefined) current.notes.push({ at: iso(at), reason: o.reason });
        setBlockers(current, at, o.blockers);
      }
    }
  }
  for (const b of all) {
    const iv = b.iv;
    if (b.startMs !== undefined) iv.startedAt = iso(b.startMs);
    if (b.endMs !== undefined) iv.endedAt = iso(b.endMs);
    if (iv.state === "closed" && b.startMs !== undefined && b.endMs !== undefined) {
      iv.durationMs = Math.max(0, b.endMs - b.startMs);
    }
    if (iv.state === "incomplete" && b.untilMs !== undefined) iv.observedUntil = iso(b.untilMs);
    iv.timeSource = b.allOccurred ? "occurredAt" : "receivedAt";
  }
  return all;
};

/** A closed interval's span, clamped so an end before its start is empty. */
const closedSpan = (b: Built): Span | undefined =>
  b.iv.state === "closed" && b.startMs !== undefined && b.endMs !== undefined
    ? [b.startMs, Math.max(b.startMs, b.endMs)]
    : undefined;

const closedSpans = (list: readonly Built[]): Span[] =>
  list.flatMap((b) => {
    const s = closedSpan(b);
    return s === undefined ? [] : [s];
  });

const emptyEndings = (): Mutable<OperationEndings> => ({
  integrated: 0,
  merged: 0,
  integration_conflict: 0,
  verification_failed: 0,
  deferred: 0,
  examination_stopped: 0,
  failed: 0,
  other: 0,
  examinationSkipped: 0,
});

const concurrencyOf = (work: readonly Built[]): { series: ConcurrencyPoint[]; peak: number } => {
  const deltas = new Map<number, number>();
  const bump = (at: number, d: number): void => {
    deltas.set(at, (deltas.get(at) ?? 0) + d);
  };
  for (const b of work) {
    if (b.startMs === undefined) continue;
    if (b.iv.state === "closed" && b.endMs !== undefined) {
      if (b.endMs <= b.startMs) continue;
      bump(b.startMs, 1);
      bump(b.endMs, -1);
    } else if (b.iv.state === "open") {
      bump(b.startMs, 1);
    }
  }
  const series: ConcurrencyPoint[] = [];
  let running = 0;
  let peak = 0;
  for (const at of [...deltas.keys()].sort((a, b) => a - b)) {
    running += deltas.get(at) ?? 0;
    peak = Math.max(peak, running);
    series.push({ at: iso(at), running });
  }
  return { series, peak };
};

// --- chain ---------------------------------------------------------------

interface Cand {
  readonly b: Built;
  readonly link: ChainLink;
}

const keyOf = (b: Built): string => `${b.iv.operationId}#${b.iv.occurrence}`;

const chainOf = (
  input: OperationsInput,
  all: readonly Built[],
  runStart: number,
  runEnd: number | undefined,
  elapsedMs: number | undefined,
): ObservedChain => {
  const closed = all.filter((b) => closedSpan(b) !== undefined);
  const endOf = (b: Built): number => b.endMs ?? 0;
  const startOf = (b: Built): number => b.startMs ?? 0;
  const finish = (
    steps: ChainStep[],
    ambiguous: ChainAmbiguity[],
    stoppedBecause?: string,
  ): ObservedChain => {
    const coveredMs = totalOf(steps.map((s): Span => [ms(s.from), ms(s.to)]));
    const coverage = elapsedMs !== undefined && elapsedMs > 0 ? coveredMs / elapsedMs : undefined;
    return {
      steps,
      coveredMs,
      ...(elapsedMs !== undefined ? { elapsedMs } : {}),
      ...(coverage !== undefined ? { coverage } : {}),
      incomplete: stoppedBecause !== undefined,
      ...(stoppedBecause !== undefined ? { stoppedBecause } : {}),
      ambiguous,
    };
  };

  const latest = (list: readonly Built[]): Built | undefined =>
    list.reduce<Built | undefined>(
      (best, b) => (best === undefined || endOf(b) > endOf(best) ? b : best),
      undefined,
    );
  const integrations = closed.filter((b) => b.iv.phase === "integration");
  let first = latest(integrations);
  if (first === undefined) {
    if (runEnd === undefined) return finish([], [], "no observed end");
    first = latest(closed.filter((b) => endOf(b) <= runEnd));
    if (first === undefined) return finish([], [], "no observed operation before the run's end");
  }

  const nodeOf = (ref: string): ExecutionNode | undefined =>
    input.nodes.find((n) => n.executionNodeId === ref) ??
    input.nodes.find((n) => n.jobContractId !== null && n.jobContractId === ref);
  const nodeOfStrand = (strandId: string): ExecutionNode | undefined => {
    const job = input.jobs.find((j) => j.strandId === strandId);
    return job === undefined
      ? undefined
      : input.nodes.find((n) => n.jobContractId === job.jobContractId);
  };
  const ofNode = (nodeId: string, phase: string): Built[] =>
    closed.filter((b) => b.iv.nodeId === nodeId && b.iv.phase === phase);

  const predecessors = (x: Built): { cands: Cand[]; capacity: boolean } => {
    const nodeId = x.iv.nodeId;
    const xs = startOf(x);
    const cands: Cand[] = [];
    let capacity = false;
    const retry = (): void => {
      const attempt = x.iv.attempt;
      if (attempt === undefined || attempt <= 1) return;
      for (const b of closed) {
        if (b.iv.nodeId !== nodeId || b === x) continue;
        if (b.iv.attempt !== undefined && b.iv.attempt < attempt && endOf(b) <= xs) {
          cands.push({ b, link: "retry" });
        }
      }
    };
    switch (x.iv.phase) {
      case "integration": {
        const queue = ofNode(nodeId, "queue")
          .filter((q) => endOf(q) <= xs)
          .reduce<Built | undefined>(
            (best, q) => (best === undefined || endOf(q) > endOf(best) ? q : best),
            undefined,
          );
        if (queue !== undefined) {
          for (const span of queue.spans) {
            for (const bl of span.blockers) {
              if (bl.kind !== "queue_predecessor") continue;
              const pred = nodeOf(bl.ref);
              if (pred === undefined) continue;
              for (const p of ofNode(pred.executionNodeId, "integration")) {
                if (endOf(p) >= startOf(queue) && endOf(p) <= endOf(queue) && endOf(p) <= xs) {
                  cands.push({ b: p, link: "queue_order" });
                }
              }
            }
          }
        }
        const bound = queue !== undefined ? startOf(queue) : xs;
        for (const w of ofNode(nodeId, "work")) {
          if (endOf(w) <= bound) cands.push({ b: w, link: "work" });
        }
        break;
      }
      case "work": {
        let before = ofNode(nodeId, "startup").filter((b) => endOf(b) <= xs);
        if (before.length === 0) before = ofNode(nodeId, "wait").filter((b) => endOf(b) <= xs);
        for (const b of before) cands.push({ b, link: "attempt" });
        retry();
        break;
      }
      case "startup": {
        for (const b of ofNode(nodeId, "wait"))
          if (endOf(b) <= xs) cands.push({ b, link: "attempt" });
        retry();
        break;
      }
      case "wait": {
        const xe = endOf(x);
        const finalSpan = x.spans[x.spans.length - 1];
        const finalCapacity = finalSpan?.blockers.some((b) => CAPACITY_KINDS.has(b.kind)) ?? false;
        const anyCapacity = x.spans.some((s) => s.blockers.some((b) => CAPACITY_KINDS.has(b.kind)));
        const targets: ExecutionNode[] = [];
        for (const span of x.spans) {
          for (const bl of span.blockers) {
            const node =
              bl.kind === "job"
                ? nodeOf(bl.ref)
                : bl.kind === "strand"
                  ? nodeOfStrand(bl.ref)
                  : undefined;
            if (node !== undefined && !targets.includes(node)) targets.push(node);
          }
        }
        for (const node of targets) {
          const landed = ofNode(node.executionNodeId, "integration")
            .filter(
              (b) => endOf(b) >= xs && endOf(b) <= xe && !FAILED_ENDINGS.has(b.iv.reason ?? ""),
            )
            .reduce<Built | undefined>(
              (best, b) => (best === undefined || endOf(b) > endOf(best) ? b : best),
              undefined,
            );
          if (landed === undefined) continue;
          if (finalCapacity && endOf(landed) < xe - TIE_MS) continue;
          cands.push({ b: landed, link: "dependency" });
        }
        if (anyCapacity && cands.length === 0) capacity = true;
        retry();
        break;
      }
      default:
        break;
    }
    return { cands, capacity };
  };

  const causesFor = (x: Built): readonly AttemptCause[] | undefined => {
    const attempt = x.iv.attempt;
    if (attempt === undefined) return undefined;
    return input.routes.find(
      (r) =>
        r.executionNodeId === x.iv.nodeId &&
        r.attempt === attempt &&
        r.purpose === undefined &&
        r.causes !== undefined,
    )?.causes;
  };

  const steps: ChainStep[] = [];
  const ambiguous: ChainAmbiguity[] = [];
  const seen = new Set<string>();
  let x: Built = first;
  let link: ChainLink = "end";
  let pendingCauses: readonly AttemptCause[] | undefined;
  for (;;) {
    seen.add(keyOf(x));
    const iv = x.iv;
    steps.push({
      operationId: iv.operationId,
      occurrence: iv.occurrence,
      nodeId: iv.nodeId,
      phase: iv.phase,
      from: iso(startOf(x)),
      to: iso(endOf(x)),
      link,
      ...(pendingCauses !== undefined ? { causes: pendingCauses } : {}),
    });
    pendingCauses = undefined;
    const { cands, capacity } = predecessors(x);
    const admissible: Cand[] = [];
    for (const c of cands) {
      if (seen.has(keyOf(c.b)) || admissible.some((a) => a.b === c.b)) continue;
      admissible.push(c);
    }
    const best = admissible.reduce<Cand | undefined>(
      (acc, c) => (acc === undefined || endOf(c.b) > endOf(acc.b) ? c : acc),
      undefined,
    );
    if (best === undefined) {
      // Reaching the run's start ends the chain, unless a wait there is unexplained.
      // Work is delegated some time after the run opens, so the start is also reached
      // by a wait that was never told to have a blocker: nothing held it back.
      const firstObserved = iv.phase === "wait";
      if ((startOf(x) <= runStart || firstObserved) && x.spans.length === 0) {
        return finish(steps, ambiguous);
      }
      if (capacity) return finish(steps, ambiguous, "capacity wait: unattributed");
      const unfinished = all
        .filter(
          (b) =>
            b.iv.nodeId === iv.nodeId && (b.iv.state === "open" || b.iv.state === "incomplete"),
        )
        .map(keyOf);
      return finish(
        steps,
        ambiguous,
        `no admissible predecessor of ${keyOf(x)}` +
          (unfinished.length > 0 ? ` (unfinished: ${unfinished.join(", ")})` : ""),
      );
    }
    const tied = admissible.filter((c) => endOf(best.b) - endOf(c.b) <= TIE_MS);
    if (tied.length > 1) {
      ambiguous.push({
        operationId: iv.operationId,
        occurrence: iv.occurrence,
        candidates: tied.map((c) => ({
          operationId: c.b.iv.operationId,
          occurrence: c.b.iv.occurrence,
          nodeId: c.b.iv.nodeId,
          phase: c.b.iv.phase,
          link: c.link,
        })),
      });
    }
    // A retry link carries the causes of the later attempt, the one we walk back from.
    pendingCauses = (tied[0] ?? best).link === "retry" ? causesFor(x) : undefined;
    x = tied[0]?.b ?? best.b;
    link = (tied[0] ?? best).link;
  }
};

export const operationsOf = (input: OperationsInput): OperationsReport => {
  const { run, observations, asOf } = input;
  const all = buildIntervals(observations);
  const runStart = ms(run.startedAt);
  const runEnd = run.endedAt === undefined ? undefined : ms(run.endedAt);
  const elapsedMs = runEnd === undefined ? undefined : Math.max(0, runEnd - runStart);
  const asOfMs = ms(asOf);

  const phaseList = (phases: readonly string[]): Built[] =>
    all.filter((b) => phases.includes(b.iv.phase));
  const unionOf = (phases: readonly string[]): number => totalOf(closedSpans(phaseList(phases)));

  // Blocker kinds: the union of the closed wait intervals' spans that held that kind.
  const byKind = new Map<string, Span[]>();
  for (const b of all) {
    if (b.iv.phase !== "wait" || b.iv.state !== "closed") continue;
    for (const span of b.spans) {
      if (span.to === undefined) continue;
      for (const kind of new Set(span.blockers.map((x) => x.kind))) {
        const list = byKind.get(kind) ?? [];
        list.push([ms(span.from), ms(span.to)]);
        byKind.set(kind, list);
      }
    }
  }
  const waitByBlockerKind: Record<string, number> = {};
  for (const [kind, spans] of byKind) waitByBlockerKind[kind] = totalOf(spans);

  const unions: OperationUnions = {
    work: unionOf(["work"]),
    wait: unionOf(["wait"]),
    waitByBlockerKind,
    queue: unionOf(["queue"]),
    integration: unionOf(["integration"]),
    examination: unionOf(EXAMINATION_PHASES),
    setup: unionOf(["setup"]),
    startup: unionOf(["startup"]),
    verification: totalOf(
      input.verifications.flatMap((v): Span[] =>
        v.endedAt === undefined ? [] : [[ms(v.startedAt), ms(v.endedAt)]],
      ),
    ),
  };

  let unattributedMs: number | undefined;
  if (elapsedMs !== undefined && runEnd !== undefined) {
    const clipped = mergeSpans(closedSpans(all)).flatMap(([a, b]): Span[] => {
      const lo = Math.max(a, runStart);
      const hi = Math.min(b, runEnd);
      return hi > lo ? [[lo, hi]] : [];
    });
    unattributedMs = elapsedMs - totalOf(clipped);
  }

  let ambiguousMs = 0;
  for (const b of all) {
    if (b.startMs === undefined) continue;
    if (b.iv.state === "open") ambiguousMs += Math.max(0, asOfMs - b.startMs);
    else if (b.iv.state === "incomplete" && b.untilMs !== undefined) {
      ambiguousMs += Math.max(0, b.untilMs - b.startMs);
    }
  }

  const endings = emptyEndings();
  for (const b of all) {
    if (b.iv.phase !== "integration") continue;
    if (b.endMs !== undefined) {
      const reason = b.iv.reason;
      if (
        reason !== undefined &&
        reason in endings &&
        reason !== "other" &&
        reason !== "examinationSkipped"
      ) {
        endings[reason as keyof OperationEndings] += 1;
      } else endings.other += 1;
    }
    endings.examinationSkipped += b.notes.filter((n) =>
      n.reason.startsWith("examination: skipped"),
    ).length;
  }

  const work = all.filter((b) => b.iv.phase === "work");
  const { series, peak } = concurrencyOf(work);
  const workClosedMs = closedSpans(work).reduce((sum, [a, c]) => sum + (c - a), 0);
  const averageOverElapsed =
    elapsedMs !== undefined && elapsedMs > 0 ? workClosedMs / elapsedMs : undefined;

  const observedNodes = new Set(observations.map((o) => o.executionNodeId as string));
  let legacyWorkMs = 0;
  const legacySpans: Span[] = [];
  const nodes: NodeTimeline[] = input.nodes.map((node) => {
    const nodeId = node.executionNodeId as string;
    const mine = all.filter((b) => b.iv.nodeId === nodeId);
    const base = { nodeId, kind: node.kind as string, status: node.status as string };
    if (!observedNodes.has(nodeId)) {
      const spans = input.agents.flatMap((a): Span[] =>
        a.executionNodeId === node.executionNodeId &&
        a.startedAt !== undefined &&
        a.endedAt !== undefined
          ? [[ms(a.startedAt), ms(a.endedAt)]]
          : [],
      );
      legacySpans.push(...spans);
      return {
        ...base,
        operations: [],
        byPhase: {},
        openCount: 0,
        incompleteCount: 0,
        coverage: "legacy",
        legacyWorkMs: totalOf(spans),
      };
    }
    const phases = new Set(mine.map((b) => b.iv.phase));
    const byPhase: Record<string, number> = {};
    for (const phase of phases)
      byPhase[phase] = totalOf(closedSpans(mine.filter((b) => b.iv.phase === phase)));
    const openCount = mine.filter((b) => b.iv.state === "open").length;
    const incompleteCount = mine.filter((b) => b.iv.state === "incomplete").length;
    const starts = mine.flatMap((b) => (b.startMs === undefined ? [] : [b.startMs]));
    const ends = mine.flatMap((b) =>
      b.startMs !== undefined && b.endMs !== undefined ? [b.endMs] : [],
    );
    let activeSpan: NodeTimeline["activeSpan"];
    let nodeUnattributed: number | undefined;
    if (starts.length > 0) {
      const from = Math.min(...starts);
      const finished = openCount === 0 && incompleteCount === 0 && ends.length > 0;
      const to = finished ? Math.max(...ends) : undefined;
      activeSpan = { from: iso(from), ...(to !== undefined ? { to: iso(to) } : {}) };
      if (to !== undefined) nodeUnattributed = to - from - totalOf(closedSpans(mine));
    }
    return {
      ...base,
      operations: mine.map((b) => b.iv),
      byPhase,
      ...(activeSpan !== undefined ? { activeSpan } : {}),
      ...(nodeUnattributed !== undefined ? { unattributedMs: nodeUnattributed } : {}),
      openCount,
      incompleteCount,
      coverage: "observed",
    };
  });
  legacyWorkMs = totalOf(legacySpans);

  return {
    asOf,
    startedAt: run.startedAt,
    ...(run.endedAt !== undefined ? { endedAt: run.endedAt } : {}),
    ...(elapsedMs !== undefined ? { elapsedMs } : {}),
    operations: all.map((b) => b.iv),
    nodes,
    concurrency: {
      series,
      peak,
      ...(averageOverElapsed !== undefined ? { averageOverElapsed } : {}),
    },
    unions,
    ...(unattributedMs !== undefined ? { unattributedMs } : {}),
    ambiguousMs,
    endings,
    legacyWorkMs,
    chain: chainOf(input, all, runStart, runEnd, elapsedMs),
  };
};
