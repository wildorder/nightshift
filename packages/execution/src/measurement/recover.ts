/**
 * Journal recovery (P20): finishes what a crash interrupted.
 *
 * Run at attach, and safe to run again: sequence cursors make folding exact
 * whether the crash fell before or after the summary put, every upload repeats
 * under the SAME artifact id, and a finished journal is removed, so a second
 * run finds nothing to do.
 */
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type {
  ArtifactId,
  LaunchRef,
  MeasurementSummary,
  ModelPrice,
  RouteTarget,
  Segment,
} from "@nightshift/contracts";
import type { RunScope } from "@nightshift/core";
import {
  closeSegment,
  emptySummary,
  foldExit,
  foldObservationPriced,
  markGap,
  nowIso,
  type PriceTable,
  priceTableFor,
  startSegment,
  valuationOf,
} from "@nightshift/core";
import type { ExecutionEnvironment } from "../environment.js";
import {
  appendJournalLine,
  type JournalContext,
  type JournalLine,
  readJournal,
} from "./journal.js";
import {
  type ChunkIntent,
  completeIntent,
  type IndexEntry,
  observationLines,
  type PublicationHost,
  publishSegment,
  retried,
  seedChunkLog,
  segmentKey,
  writePublishedMarkers,
} from "./publication.js";

/** How recently a heartbeat proves the owner is still writing: twice the publish interval. */
export const LIVE_WINDOW_MS = 2 * 60_000;

export interface RecoveryResult {
  recovered: { agentId: string; launchId: string; observations: number }[];
  completed: {
    agentId: string;
    launchId: string;
    chunk: number;
    artifactId: string;
    note?: string;
  }[];
  lost: { agentId: string; launchId: string }[];
  live: { agentId: string; launchId: string }[];
  /** Journals whose last line was cut short; their complete lines were recovered. */
  torn: { agentId: string; launchId: string }[];
}

export interface RecoveryOptions {
  /** The price of a route, to value a summary recovery changed. */
  readonly price?: (route: RouteTarget) => ModelPrice | undefined;
  /** Prices by model, for requests that name a model other than the route's. */
  readonly prices?: Readonly<Record<string, ModelPrice>>;
}

const pricesFor = (options: RecoveryOptions, route: RouteTarget): PriceTable =>
  priceTableFor(options.prices, route, options.price?.(route));

const processAlive = (pid: number): boolean => {
  if (pid === 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

const parseName = (file: string): { agentId: string; launchId: string } | undefined => {
  if (!file.endsWith(".ndjson")) return undefined;
  const stem = file.slice(0, -".ndjson".length);
  const at = stem.indexOf("__");
  if (at <= 0 || at + 2 >= stem.length) return undefined;
  return { agentId: stem.slice(0, at), launchId: stem.slice(at + 2) };
};

const lastActivityMs = (lines: readonly JournalLine[]): number => {
  let latest = 0;
  for (const line of lines) {
    const at =
      line.kind === "opened"
        ? line.startedAt
        : line.kind === "heartbeat" || line.kind === "closed"
          ? line.at
          : undefined;
    if (at !== undefined) latest = Math.max(latest, Date.parse(at));
  }
  return latest;
};

const listAll = async (
  environment: Pick<ExecutionEnvironment, "stores">,
  scope: RunScope,
): Promise<MeasurementSummary[]> => {
  const out: MeasurementSummary[] = [];
  let cursor: string | undefined;
  do {
    const page = await environment.stores.measurements.listByRun(
      scope,
      cursor === undefined ? { limit: 100 } : { limit: 100, cursor },
    );
    out.push(...page.items);
    cursor = page.cursor;
  } while (cursor !== undefined);
  return out;
};

const rebuild = (
  environment: Pick<ExecutionEnvironment, "clock">,
  scope: RunScope,
  agentId: string,
  context: JournalContext,
): MeasurementSummary => {
  const at = nowIso(environment.clock);
  const empty = emptySummary({
    measurementSummaryId: context.measurementSummaryId,
    scope: { ...scope, schemaVersion: 1 },
    executionNodeId: context.executionNodeId,
    agent: { agentId: agentId as LaunchRef["agentId"], role: context.role },
    route: context.route,
    routingDecisionId: context.routingDecisionId,
    at: context.createdAt,
  });
  return startSegment(empty, context.segment, {
    ...(context.sessionId === undefined ? {} : { sessionId: context.sessionId }),
    resumedSession: context.resumedSession,
    ...(context.baseline === undefined ? {} : { baseline: context.baseline }),
    at,
  });
};

export const recoverMeasurementJournals = async (
  environment: Pick<ExecutionEnvironment, "stores" | "bodies" | "clock" | "ids" | "paths">,
  scope: RunScope,
  options: RecoveryOptions = {},
): Promise<RecoveryResult> => {
  const result: RecoveryResult = {
    recovered: [],
    completed: [],
    lost: [],
    live: [],
    torn: [],
  };
  const dir = environment.paths.measurementsDir(scope.runId);
  let files: string[];
  try {
    files = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    files = [];
  }

  const summaries = new Map<string, MeasurementSummary>();
  for (const summary of await listAll(environment, scope)) summaries.set(summary.agentId, summary);
  // Journals that remain on disk after this pass, so their segments are not "lost".
  const present = new Set<string>();

  for (const file of files.sort()) {
    const name = parseName(file);
    if (name === undefined) continue;
    const { agentId, launchId } = name;
    const path = join(dir, file);
    const journal = await readJournal(path).catch(() => undefined);
    if (journal === undefined) {
      present.add(`${agentId}__${launchId}`);
      result.lost.push({ agentId, launchId });
      continue;
    }
    const { lines } = journal;
    if (journal.torn) result.torn.push({ agentId, launchId });
    const opened = lines.find((line) => line.kind === "opened");
    const nowMs = environment.clock.now();
    if (
      opened !== undefined &&
      (processAlive(opened.pid) || nowMs - lastActivityMs(lines) < LIVE_WINDOW_MS)
    ) {
      present.add(`${agentId}__${launchId}`);
      result.live.push({ agentId, launchId });
      continue;
    }
    if (lines.some((line) => line.kind === "closed")) {
      await rm(path, { force: true });
      continue;
    }

    // Recover: the stored summary (or one rebuilt from the `opened` line), then the journal.
    let summary = summaries.get(agentId);
    const context = opened?.context;
    if (summary === undefined) {
      if (context === undefined) {
        present.add(`${agentId}__${launchId}`);
        result.lost.push({ agentId, launchId });
        continue;
      }
      summary = rebuild(environment, scope, agentId, context);
    } else if (!summary.segments.some((s) => s.launchId === launchId)) {
      if (context === undefined) {
        present.add(`${agentId}__${launchId}`);
        result.lost.push({ agentId, launchId });
        continue;
      }
      summary = startSegment(summary, context.segment, {
        ...(context.sessionId === undefined ? {} : { sessionId: context.sessionId }),
        resumedSession: context.resumedSession,
        ...(context.baseline === undefined ? {} : { baseline: context.baseline }),
        at: nowIso(environment.clock),
      });
    }
    const found = summary.segments.find((s) => s.launchId === launchId);
    if (found === undefined) continue;
    const ref: LaunchRef = {
      agentId: summary.agentId,
      launchId,
      segment: found.segment,
    };

    const all = observationLines(lines);

    let state = summary;
    let version = 1;
    let storedVersion = summaries.has(agentId) && state === summaries.get(agentId) ? 1 : 0;
    const host: PublicationHost = {
      environment,
      scope,
      nodeId: summary.executionNodeId,
      limits: { observations: 1000, chunkBytes: 1024 * 1024 },
      intents: new Map<string, ChunkIntent>(),
      chunkLog: new Map<string, IndexEntry>(),
      summary: () => state,
      update: (change) => {
        const next = change(state);
        if (next !== state) {
          state = next;
          version += 1;
        }
      },
      dirty: () => version !== storedVersion,
      putSummary: async () => {
        const captured = version;
        const at = nowIso(environment.clock);
        const valuation = valuationOf(state, pricesFor(options, state.route));
        const valued = { ...state, valuation, updatedAt: at };
        await retried(() => environment.stores.measurements.put(valued));
        if (version === captured) state = valued;
        storedVersion = captured;
      },
      lines: async () => (await readJournal(path)).lines,
      append: (_segment, line) => appendJournalLine(path, line),
    };

    // 1. Fold what the stored summary has not seen (cursors make this exact).
    const at = nowIso(environment.clock);
    let folded = 0;
    for (const entry of all) {
      if (
        entry.sequence <=
        (state.segments.find((s) => s.launchId === launchId)?.receivedSequence ?? 0)
      ) {
        continue;
      }
      const observation = entry.observation;
      host.update((current) =>
        observation.kind === "terminal_summary"
          ? foldExit(current, ref, observation, entry.sequence, at)
          : foldObservationPriced(
              current,
              observation,
              entry.sequence,
              at,
              pricesFor(options, current.route),
            ),
      );
      folded += 1;
    }

    seedChunkLog(host, lines);

    // 2. Finish every publication whose intent has no marker, with the same artifact id.
    const markers = new Set(
      lines
        .filter((l) => l.kind === "published")
        .map((l) => (l as { artifactId: ArtifactId }).artifactId),
    );
    let ok = true;
    for (const line of lines) {
      if (line.kind !== "publishing" || markers.has(line.artifactId)) continue;
      const intent: ChunkIntent = {
        chunk: line.chunk,
        artifactId: line.artifactId,
        segment: line.segment,
        fromSequence: line.fromSequence,
        toSequence: line.toSequence,
      };
      const cursor = host
        .summary()
        .segments.find((s) => s.launchId === launchId)?.publishedSequence;
      if (cursor !== undefined && cursor >= line.toSequence) {
        // The stored summary already records this range: only the markers are missing.
        const indexing = lines.find(
          (l) =>
            l.kind === "indexing" &&
            l.indexArtifactId === host.summary().ledger.indexArtifactId &&
            !lines.some((o) => o.kind === "indexed" && o.indexArtifactId === l.indexArtifactId),
        );
        try {
          if (indexing !== undefined && indexing.kind === "indexing") {
            await appendJournalLine(path, {
              kind: "indexed",
              indexArtifactId: indexing.indexArtifactId,
            });
          }
          await appendJournalLine(path, {
            kind: "published",
            chunk: line.chunk,
            artifactId: line.artifactId,
          });
          result.completed.push({
            agentId,
            launchId,
            chunk: line.chunk,
            artifactId: line.artifactId,
            note: "already recorded in the stored summary; marker written",
          });
        } catch {
          ok = false;
        }
        continue;
      }
      if (await completeIntent(host, intent)) {
        result.completed.push({
          agentId,
          launchId,
          chunk: line.chunk,
          artifactId: line.artifactId,
        });
      } else ok = false;
    }

    // 3. The owner is gone: say what that may have cost, and close the segment.
    const segmentNow = host.summary().segments.find((s) => s.launchId === launchId);
    if (segmentNow !== undefined && (segmentNow.open || folded > 0)) {
      const gapAt = nowIso(environment.clock);
      host.update((current) =>
        markGap(
          current,
          {
            reason: "stopped_before_flush",
            detail:
              "the process stopped before its observations were published; recovered from the journal",
            from: gapAt,
            to: gapAt,
          },
          gapAt,
        ),
      );
      host.update((current) => closeSegment(current, ref, gapAt));
    }

    // 4. Publish the rest, store the summary, and retire the journal.
    if (!(await publishSegment(host, ref))) ok = false;
    if (ok && host.dirty()) {
      try {
        await host.putSummary();
      } catch {
        ok = false;
      }
    }
    if (ok) await writePublishedMarkers(host);
    summaries.set(agentId, host.summary());
    result.recovered.push({ agentId, launchId, observations: folded });
    const finalSegment = host.summary().segments.find((s) => s.launchId === launchId);
    if (
      ok &&
      finalSegment !== undefined &&
      finalSegment.publishedSequence >= finalSegment.receivedSequence
    ) {
      await appendJournalLine(path, {
        kind: "closed",
        at: nowIso(environment.clock),
      }).catch(() => {});
      await rm(path, { force: true });
    } else {
      present.add(`${agentId}__${launchId}`);
    }
    void segmentKey;
  }

  // Open segments whose journal is gone: observations after the stored cursor may be lost.
  for (const summary of [...summaries.values()]) {
    let state = summary;
    const lostHere: Segment[] = [];
    for (const segment of summary.segments) {
      if (!segment.open || present.has(`${summary.agentId}__${segment.launchId}`)) continue;
      lostHere.push(segment);
    }
    if (lostHere.length === 0) continue;
    const at = nowIso(environment.clock);
    for (const segment of lostHere) {
      state = {
        ...state,
        segments: state.segments.map((s) =>
          s === segment
            ? {
                ...s,
                open: false,
                coverage: s.receivedSequence > 0 ? "partial" : "unknown",
              }
            : s,
        ),
      };
      state = markGap(
        state,
        {
          reason: "journal_lost",
          detail: `observations after sequence ${segment.receivedSequence}, if any, were lost before upload`,
          from: at,
          to: at,
        },
        at,
      );
      result.lost.push({
        agentId: summary.agentId,
        launchId: segment.launchId,
      });
    }
    const valued = {
      ...state,
      valuation: valuationOf(state, pricesFor(options, state.route)),
    };
    try {
      await retried(() => environment.stores.measurements.put(valued));
      summaries.set(summary.agentId, valued);
    } catch {
      // The loss is detected again on the next recovery; nothing is thrown.
    }
  }
  return result;
};
