/**
 * The measurement recorder (P20): one per agent, spanning its launches.
 *
 * **`observe` is not a receipt.** It stamps, validates and enqueues
 * synchronously, and never throws or blocks. Receipt is the journal's
 * write-and-fsync, done by one background writer; only after it does the
 * observation reach the in-memory summary, so memory never reflects anything the
 * journal does not hold. Publication to the control plane is separate and
 * crash-safe (see `publication.ts`); the journal stays on disk until every
 * observation is published, and `recoverMeasurementJournals` finishes whatever
 * a crash interrupted.
 */
import { rm } from "node:fs/promises";
import type {
  Agent,
  ExecutionNodeId,
  LaunchRef,
  MeasurementCounters,
  MeasurementObservation,
  MeasurementSummary,
  ModelPrice,
  RouteTarget,
  RoutingDecisionId,
} from "@nightshift/contracts";
import { MeasurementObservationSchema } from "@nightshift/contracts";
import type { RunScope } from "@nightshift/core";
import {
  baselineFor,
  closeSegment,
  countersFromRouteUsage,
  emptySummary,
  foldExit,
  foldObservation,
  markGap,
  nowIso,
  startSegment as startCoreSegment,
  valueCounters,
} from "@nightshift/core";
import type { HarnessExit, HarnessObservation, MeasurementSink } from "@nightshift/harness";
import { coverageOfExit, usageOfExit, usageScopeOfExit } from "@nightshift/harness";
import type { ExecutionEnvironment } from "../environment.js";
import {
  type Journal,
  type JournalFs,
  nodeJournalFs,
  openJournal,
  readJournal,
} from "./journal.js";
import {
  type ChunkIntent,
  type IndexEntry,
  type PublicationHost,
  publishSegment,
  segmentKey,
  writePublishedMarkers,
} from "./publication.js";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** What the engine supplies for a lifecycle observation: an adapter's fields, minus `source`. */
export type EngineObservation = DistributiveOmit<HarnessObservation, "source">;

export interface MeasurementRecorderLimits {
  readonly maxPending?: number;
  readonly publishEvery?: { readonly observations?: number; readonly ms?: number };
  readonly chunkBytes?: number;
  readonly drainDeadlineMs?: number;
}

export interface MeasurementRecorderInput {
  readonly scope: RunScope;
  readonly executionNodeId: ExecutionNodeId;
  readonly agent: Agent;
  readonly route: RouteTarget;
  readonly routingDecisionId: RoutingDecisionId | null;
  readonly price?: ModelPrice;
  readonly limits?: MeasurementRecorderLimits;
  /** An agent's stored summary, to resume it (after a restart, or after recovery). */
  readonly existing?: MeasurementSummary;
  /** The write/fsync the journals use. Tests inject a facade; absent, the real file system. */
  readonly journalFs?: JournalFs<import("node:fs/promises").FileHandle>;
  /** The process id journals record as their owner. Absent, this process. */
  readonly pid?: number;
}

export interface StartSegmentOptions {
  readonly launchId?: string;
  readonly sessionId?: string;
  readonly resumedSession: boolean;
  readonly baseline?: MeasurementCounters;
}

export interface MeasurementRecorder {
  startSegment(options: StartSegmentOptions): Promise<LaunchRef>;
  readonly sink: MeasurementSink;
  lifecycle(observation: EngineObservation): void;
  recordExit(exit: HarnessExit): void;
  drain(): Promise<{ undrained: number }>;
  publish(): Promise<MeasurementSummary>;
  close(exit?: HarnessExit): Promise<{ summary: MeasurementSummary; pending: number }>;
  summary(): MeasurementSummary;
}

export const DEFAULT_MAX_PENDING = 10_000;
export const DEFAULT_PUBLISH_OBSERVATIONS = 1000;
export const DEFAULT_PUBLISH_MS = 60_000;
export const DEFAULT_CHUNK_BYTES = 1024 * 1024;
export const DEFAULT_DRAIN_DEADLINE_MS = 5000;
const RECENT_OBSERVATION_IDS = 10_000;

/** The summary an agent has on the control plane, if any. */
export const publishedSummaryFor = async (
  stores: ExecutionEnvironment["stores"],
  scope: RunScope,
  nodeId: ExecutionNodeId,
  agentId: string,
): Promise<MeasurementSummary | undefined> =>
  (await stores.measurements.listByNode(scope, nodeId)).find(
    (summary) => summary.agentId === agentId,
  );

/** The dollars a harness reported for observations: a terminal's figure supersedes the requests'. */
export interface ReportedCost {
  requests?: number;
  terminal?: number;
}

export const addReportedCost = (cost: ReportedCost, observation: MeasurementObservation): void => {
  if (observation.kind === "request" && observation.reportedCostUsd !== undefined) {
    cost.requests = (cost.requests ?? 0) + observation.reportedCostUsd;
  } else if (observation.kind === "terminal_summary" && observation.reportedCostUsd !== undefined) {
    cost.terminal = Math.max(cost.terminal ?? 0, observation.reportedCostUsd);
  }
};

export const reportedOf = (cost: ReportedCost): number | undefined =>
  cost.requests === undefined && cost.terminal === undefined
    ? undefined
    : Math.max(cost.requests ?? 0, cost.terminal ?? 0);

/** The summary with its valuation recomputed. `carried` is dollars reported before these costs. */
export const valuedSummary = (
  summary: MeasurementSummary,
  price: ModelPrice | undefined,
  reportedUsd: number | undefined,
  at: string,
): MeasurementSummary => ({
  ...summary,
  valuation: valueCounters(summary.totals, price, reportedUsd),
  updatedAt: at,
});

interface SegmentRuntime {
  readonly ref: LaunchRef;
  journal: Promise<Journal | undefined>;
  nextSequence: number;
  readonly cost: ReportedCost;
}

interface QueueItem {
  readonly runtime: SegmentRuntime;
  readonly observation: MeasurementObservation;
  readonly sequence: number;
}

const randomLaunchSuffix = (value: string): string => value.slice(value.indexOf("_") + 1);

export const createMeasurementRecorder = (
  environment: Pick<
    ExecutionEnvironment,
    "stores" | "bodies" | "clock" | "ids" | "paths" | "outbox"
  >,
  input: MeasurementRecorderInput,
): MeasurementRecorder => {
  const { scope, executionNodeId, agent } = input;
  const maxPending = input.limits?.maxPending ?? DEFAULT_MAX_PENDING;
  const everyObservations =
    input.limits?.publishEvery?.observations ?? DEFAULT_PUBLISH_OBSERVATIONS;
  const everyMs = input.limits?.publishEvery?.ms ?? DEFAULT_PUBLISH_MS;
  const chunkBytes = input.limits?.chunkBytes ?? DEFAULT_CHUNK_BYTES;
  const drainDeadlineMs = input.limits?.drainDeadlineMs ?? DEFAULT_DRAIN_DEADLINE_MS;
  const journalFs = input.journalFs ?? nodeJournalFs;
  const pid = input.pid ?? process.pid;
  const now = () => nowIso(environment.clock);

  let current: MeasurementSummary =
    input.existing ??
    emptySummary({
      measurementSummaryId: environment.ids.next("meas"),
      scope: { ...scope, schemaVersion: 1 },
      executionNodeId,
      agent,
      route: input.route,
      routingDecisionId: input.routingDecisionId,
      at: now(),
    });
  // Dollars reported by earlier recorders for this summary; this one adds to them.
  const carriedUsd = input.existing?.valuation.reportedUsd;
  let version = 0;
  let storedVersion = 0;

  const runtimes = new Map<string, SegmentRuntime>();
  let active: SegmentRuntime | undefined;
  const queue: QueueItem[] = [];
  let inFlight: QueueItem | undefined;
  let abandoned: QueueItem | undefined;
  let writing: Promise<void> | undefined;
  const recentIds = new Set<string>();
  const losses = new Map<string, number>();

  let sinceLastPublish = 0;
  let lastPublishMs = environment.clock.now();
  let publishing: Promise<unknown> = Promise.resolve();
  let timer: ReturnType<typeof setInterval> | undefined;

  const update: PublicationHost["update"] = (change) => {
    const next = change(current);
    if (next !== current) {
      current = next;
      version += 1;
    }
  };

  const reportedUsd = (): number | undefined => {
    let total: number | undefined = carriedUsd;
    for (const runtime of runtimes.values()) {
      const reported = reportedOf(runtime.cost);
      if (reported !== undefined) total = (total ?? 0) + reported;
    }
    return total;
  };

  const lose = (detail: string, count = 1) => {
    losses.set(detail, (losses.get(detail) ?? 0) + count);
  };
  const settleLosses = () => {
    if (losses.size === 0) return;
    const at = now();
    for (const [detail, count] of losses) {
      update((summary) =>
        markGap(summary, { reason: "receipt_lost", detail, from: at, to: at, count }, at),
      );
    }
    losses.clear();
  };

  const host: PublicationHost = {
    environment,
    scope,
    nodeId: executionNodeId,
    limits: { observations: everyObservations, chunkBytes },
    intents: new Map<string, ChunkIntent>(),
    chunkLog: new Map<string, IndexEntry>(),
    summary: () => current,
    update,
    dirty: () => version !== storedVersion,
    putSummary: async () => {
      settleLosses();
      const at = now();
      const captured = version;
      const valued = valuedSummary(current, input.price, reportedUsd(), at);
      await environment.stores.measurements.put(valued);
      // Only what was captured is stored: later changes keep the summary dirty.
      if (version === captured) {
        current = valued;
        storedVersion = version;
      } else {
        storedVersion = Math.min(storedVersion, captured);
      }
      lastPublishMs = environment.clock.now();
      sinceLastPublish = 0;
    },
    lines: async (segment) => {
      const runtime = runtimes.get(segmentKey(segment));
      const journal = runtime === undefined ? undefined : await runtime.journal;
      if (journal === undefined) throw new Error("no journal for the segment");
      return (await readJournal(journal.path)).lines;
    },
    append: async (segment, line) => {
      const runtime = runtimes.get(segmentKey(segment));
      const journal = runtime === undefined ? undefined : await runtime.journal;
      if (journal === undefined) throw new Error("no journal for the segment");
      await journal.append(line);
    },
  };

  /** Puts the summary when it is dirty, retrying once; failures record `delivery_failed`. */
  const publishInner = async (): Promise<void> => {
    settleLosses();
    let ok = true;
    for (const runtime of runtimes.values()) {
      if (!(await publishSegment(host, runtime.ref))) ok = false;
    }
    if (ok && host.dirty()) {
      try {
        await retryPut();
      } catch (error) {
        const at = now();
        update((summary) =>
          markGap(
            summary,
            {
              reason: "delivery_failed",
              detail: `summary put: ${(error as Error).message}`.slice(0, 200),
              from: at,
              to: at,
            },
            at,
          ),
        );
        ok = false;
      }
    }
    if (ok) await writePublishedMarkers(host);
    lastPublishMs = environment.clock.now();
    sinceLastPublish = 0;
  };

  const retryPut = async () => {
    try {
      await host.putSummary();
    } catch {
      await host.putSummary();
    }
  };

  const serialized = <T>(work: () => Promise<T>): Promise<T> => {
    const run = publishing.then(work, work);
    publishing = run.catch(() => {});
    return run;
  };

  const heartbeat = async () => {
    const journal = active === undefined ? undefined : await active.journal;
    await journal?.append({ kind: "heartbeat", at: now() }).catch(() => {});
  };

  const due = (): boolean =>
    sinceLastPublish >= everyObservations || environment.clock.now() - lastPublishMs >= everyMs;

  const tick = async () => {
    await heartbeat();
    await serialized(publishInner);
  };

  /** Folds a journaled observation into memory. */
  const fold = (item: QueueItem) => {
    const at = now();
    const { observation, sequence, runtime } = item;
    addReportedCost(runtime.cost, observation);
    update((summary) =>
      observation.kind === "terminal_summary"
        ? foldExit(summary, runtime.ref, observation, sequence, at)
        : foldObservation(summary, observation, sequence, at),
    );
    sinceLastPublish += 1;
  };

  const writeOne = async (item: QueueItem) => {
    inFlight = item;
    try {
      const journal = await item.runtime.journal;
      if (journal === undefined) {
        lose("observation dropped: the journal could not be opened");
        return;
      }
      await journal.append({
        kind: "observation",
        sequence: item.sequence,
        observation: item.observation,
      });
      if (abandoned === item) return;
      fold(item);
    } catch {
      if (abandoned !== item) lose("observation dropped: the journal append failed");
    } finally {
      inFlight = undefined;
    }
  };

  const pump = (): Promise<void> => {
    if (writing !== undefined) return writing;
    writing = (async () => {
      try {
        for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
          await writeOne(item);
          if (due()) await tick().catch(() => {});
        }
      } finally {
        writing = undefined;
        if (queue.length > 0) void pump();
      }
    })();
    return writing;
  };

  const enqueue = (observation: Record<string, unknown>) => {
    try {
      const runtime = active;
      if (runtime === undefined) {
        lose("observation dropped: no launch segment is open");
        return;
      }
      const stamped = {
        ...observation,
        projectId: scope.projectId,
        programId: scope.programId,
        runId: scope.runId,
        schemaVersion: 1,
        executionNodeId,
        agentId: agent.agentId,
        launch: runtime.ref,
        receivedAt: now(),
      };
      const parsed = MeasurementObservationSchema.safeParse(stamped);
      if (!parsed.success) {
        lose("observation dropped: invalid or oversize");
        return;
      }
      const key = `${runtime.ref.launchId}:${parsed.data.observationId}`;
      if (recentIds.has(key)) return;
      if (queue.length >= maxPending) {
        lose("observation dropped: the pending queue was full");
        return;
      }
      recentIds.add(key);
      if (recentIds.size > RECENT_OBSERVATION_IDS) {
        const oldest = recentIds.values().next().value;
        if (oldest !== undefined) recentIds.delete(oldest);
      }
      runtime.nextSequence += 1;
      queue.push({ runtime, observation: parsed.data, sequence: runtime.nextSequence });
      void pump();
    } catch {
      lose("observation dropped: the recorder failed to accept it");
    }
  };

  const drain = async (): Promise<{ undrained: number }> => {
    const settled = (async () => {
      while (writing !== undefined || queue.length > 0) await pump();
      return true;
    })();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<false>((resolve) => {
      timeout = setTimeout(() => resolve(false), drainDeadlineMs);
    });
    const finished = await Promise.race([settled, expired]);
    clearTimeout(timeout);
    if (finished) {
      settleLosses();
      return { undrained: 0 };
    }
    const undrained = queue.length + (inFlight === undefined ? 0 : 1);
    queue.length = 0;
    abandoned = inFlight;
    if (undrained > 0) lose("observations not journaled before the drain deadline", undrained);
    settleLosses();
    return { undrained };
  };

  const startSegment = async (options: StartSegmentOptions): Promise<LaunchRef> => {
    const launchId =
      options.launchId ?? `launch_${randomLaunchSuffix(environment.ids.next("meas"))}`;
    const segment = current.segments.reduce((max, s) => Math.max(max, s.segment), -1) + 1;
    const ref: LaunchRef = { agentId: agent.agentId, launchId, segment };
    const at = now();
    const baseline =
      options.baseline ??
      (options.resumedSession && options.sessionId !== undefined
        ? baselineFor(current, options.sessionId)
        : undefined);
    update((summary) =>
      startCoreSegment(summary, ref, {
        ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
        resumedSession: options.resumedSession,
        ...(baseline === undefined ? {} : { baseline }),
        at,
      }),
    );
    const runtime: SegmentRuntime = {
      ref,
      journal: Promise.resolve(undefined),
      nextSequence: 0,
      cost: {},
    };
    runtime.journal = openJournal(
      environment.paths.measurementJournal(scope.runId, agent.agentId, launchId),
      {
        pid,
        startedAt: at,
        agentId: agent.agentId,
        launchId,
        context: {
          measurementSummaryId: current.measurementSummaryId,
          executionNodeId,
          role: agent.role,
          route: input.route,
          routingDecisionId: input.routingDecisionId,
          createdAt: current.createdAt,
          segment: ref,
          ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
          resumedSession: options.resumedSession,
          ...(baseline === undefined ? {} : { baseline }),
        },
      },
      journalFs,
    ).catch(() => {
      lose("the measurement journal could not be opened");
      return undefined;
    });
    await runtime.journal;
    runtimes.set(segmentKey(ref), runtime);
    active = runtime;
    startTimer();
    await serialized(publishInner);
    return ref;
  };

  const startTimer = () => {
    if (timer !== undefined) return;
    timer = setInterval(
      () => {
        if (environment.clock.now() - lastPublishMs >= everyMs) void tick().catch(() => {});
      },
      Math.max(1000, Math.min(everyMs, 30_000)),
    );
    timer.unref();
  };

  const exitObservation = (exit: HarnessExit) => {
    const usage = usageOfExit(exit);
    const launchId = active?.ref.launchId ?? "none";
    return {
      observationId: `exit:${launchId}`,
      source: "engine",
      provenance: { adapter: "execution", note: "the harness exit" },
      inclusion: "self",
      kind: "terminal_summary",
      counters: usage === undefined ? {} : countersFromRouteUsage(usage),
      counterScope: usageScopeOfExit(exit),
      exitKind: exit.kind,
      coverage: coverageOfExit(exit),
      ...(exit.observedModel === undefined ? {} : { model: exit.observedModel }),
      ...(usage?.actualCostUsd === undefined ? {} : { reportedCostUsd: usage.actualCostUsd }),
      ...(usage?.wallClockMs === undefined ? {} : { durationMs: usage.wallClockMs }),
    };
  };

  const close = async (exit?: HarnessExit) => {
    if (exit !== undefined) enqueue(exitObservation(exit));
    await drain();
    for (const runtime of runtimes.values()) {
      update((summary) => closeSegment(summary, runtime.ref, now()));
    }
    await serialized(publishInner);
    const settled = !host.dirty() && host.intents.size === 0;
    const state = current;
    let pending = 0;
    for (const runtime of runtimes.values()) {
      const segment = state.segments.find(
        (s) => s.launchId === runtime.ref.launchId && s.segment === runtime.ref.segment,
      );
      const outstanding =
        segment === undefined
          ? 0
          : Math.max(0, segment.receivedSequence - segment.publishedSequence);
      pending += outstanding;
      const journal = await runtime.journal;
      if (journal === undefined) continue;
      if (settled && outstanding === 0) {
        await journal.append({ kind: "closed", at: now() }).catch(() => {});
        await journal.close().catch(() => {});
        await rm(journal.path, { force: true }).catch(() => {});
        runtimes.delete(segmentKey(runtime.ref));
      } else {
        await journal.close().catch(() => {});
      }
    }
    if (!settled && pending === 0) pending = 1;
    if (runtimes.size === 0 && timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
    active = undefined;
    return { summary: current, pending };
  };

  return {
    startSegment,
    sink: { observe: (observation) => enqueue({ ...observation }) },
    lifecycle: (observation) => enqueue({ ...observation, source: "engine" }),
    recordExit: (exit) => enqueue(exitObservation(exit)),
    drain,
    publish: async () => {
      await drain();
      await serialized(publishInner);
      return current;
    },
    close,
    summary: () => {
      settleLosses();
      return current;
    },
  };
};
