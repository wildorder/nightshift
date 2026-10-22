/**
 * The crash-safe publication protocol (P20), shared by the live recorder and
 * by recovery so they cannot disagree.
 *
 * One chunk, in order:
 *   1. journal `publishing` (intent: artifact id, segment, sequence range);
 *   2. `bodies.put` the chunk;  3. `stores.artifacts.put` its reference;
 *   4. core `markPublished` and `stores.measurements.put` the summary;
 *   5. journal `published`.
 * Every step is idempotent on the artifact id, so a crash between any two is
 * finished by replaying the intent with the SAME id. Nothing here throws: a
 * step that fails twice records `delivery_failed` and leaves the chunk
 * unpublished with its intent intact.
 */
import type {
  ArtifactId,
  ExecutionNodeId,
  LaunchRef,
  MeasurementLedgerChunk,
  MeasurementLedgerIndex,
  MeasurementObservation,
  MeasurementSummary,
} from "@nightshift/contracts";
import type {
  ArtifactBodyStore,
  Clock,
  IdGenerator,
  ProjectStores,
  RunScope,
} from "@nightshift/core";
import { markGap, markPublished, nowIso, rollLedgerIndex } from "@nightshift/core";
import type { JournalLine } from "./journal.js";

export interface PublicationEnvironment {
  readonly stores: ProjectStores;
  readonly bodies: ArtifactBodyStore;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/** A chunk the journal has an intent for. */
export interface ChunkIntent {
  readonly chunk: number;
  readonly artifactId: ArtifactId;
  readonly segment: LaunchRef;
  readonly fromSequence: number;
  readonly toSequence: number;
  /** The summary in memory records the chunk; the `published` line is owed once it is stored. */
  marked?: boolean;
  /** The index artifact this chunk's rollover wrote; its `indexed` line is owed with `published`. */
  rolledIndex?: ArtifactId;
}

export type IndexEntry = MeasurementLedgerIndex["chunks"][number];

export interface PublicationHost {
  readonly environment: PublicationEnvironment;
  readonly scope: RunScope;
  readonly nodeId: ExecutionNodeId;
  readonly limits: { observations: number; chunkBytes: number };
  /** Intents not yet recorded in a stored summary, by segment key. */
  readonly intents: Map<string, ChunkIntent>;
  /** Chunk metadata since the last index roll, for an index artifact. */
  readonly chunkLog: Map<string, IndexEntry>;
  summary(): MeasurementSummary;
  update(change: (summary: MeasurementSummary) => MeasurementSummary): void;
  /** Whether the summary in memory differs from the one last stored. */
  dirty(): boolean;
  /** Stores the summary as it is now, with its valuation. Throws on failure. */
  putSummary(): Promise<void>;
  /** The segment's journaled lines, journal being authoritative. */
  lines(segment: LaunchRef): Promise<readonly JournalLine[]>;
  /** Appends to the segment's journal. Throws when there is none or it fails. */
  append(segment: LaunchRef, line: JournalLine): Promise<void>;
}

/** Chunk metadata the journal's `publishing` lines give, by artifact id. */
export const seedChunkLog = (host: PublicationHost, lines: readonly JournalLine[]): void => {
  for (const line of lines) {
    if (line.kind !== "publishing") continue;
    host.chunkLog.set(line.artifactId, {
      chunk: line.chunk,
      artifactId: line.artifactId,
      segment: line.segment,
      fromSequence: line.fromSequence,
      toSequence: line.toSequence,
    });
  }
};

/**
 * The index artifact id for rolling exactly `listed`: the one an earlier
 * attempt journaled and did not finish, else a new one, journaled first.
 */
const indexIdFor = async (
  host: PublicationHost,
  segment: LaunchRef,
  listed: ReadonlySet<ArtifactId>,
): Promise<ArtifactId> => {
  const lines = await host.lines(segment);
  const done = new Set<string>();
  for (const line of lines) if (line.kind === "indexed") done.add(line.indexArtifactId);
  for (const line of [...lines].reverse()) {
    if (line.kind !== "indexing" || done.has(line.indexArtifactId)) continue;
    if (line.artifactIds.length === listed.size && line.artifactIds.every((id) => listed.has(id))) {
      return line.indexArtifactId;
    }
  }
  const indexArtifactId = host.environment.ids.next("art");
  await host.append(segment, { kind: "indexing", indexArtifactId, artifactIds: [...listed] });
  return indexArtifactId;
};

export const segmentKey = (segment: Pick<LaunchRef, "launchId" | "segment">): string =>
  `${segment.launchId}#${segment.segment}`;

/** Runs `step`, once more when it throws; throws the second error. */
export const retried = async <T>(step: () => Promise<T>): Promise<T> => {
  try {
    return await step();
  } catch {
    return step();
  }
};

const message = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).slice(0, 200);

const markFailure = (host: PublicationHost, what: string, error: unknown): void => {
  const at = nowIso(host.environment.clock);
  host.update((summary) =>
    markGap(
      summary,
      { reason: "delivery_failed", detail: `${what}: ${message(error)}`, from: at, to: at },
      at,
    ),
  );
};

/** Uploads a ledger body and records its reference, unless the reference is already there. */
export const uploadArtifact = async (
  host: PublicationHost,
  artifactId: ArtifactId,
  body: MeasurementLedgerChunk | MeasurementLedgerIndex,
): Promise<void> => {
  const { stores, bodies, clock } = host.environment;
  if ((await retried(() => stores.artifacts.get(host.scope, artifactId))) !== undefined) return;
  const text = JSON.stringify(body);
  const stored = await retried(() => bodies.put(host.scope, artifactId, text, "application/json"));
  await retried(() =>
    stores.artifacts.put({
      schemaVersion: 1,
      ...host.scope,
      artifactId,
      executionNodeId: host.nodeId,
      kind: "measurement-ledger",
      uri: stored.uri,
      sizeBytes: stored.sizeBytes,
      contentType: "application/json",
      sha256: stored.sha256,
      createdAt: nowIso(clock),
    }),
  );
};

export const observationLines = (
  lines: readonly JournalLine[],
): { sequence: number; observation: MeasurementObservation }[] => {
  const bySequence = new Map<number, MeasurementObservation>();
  for (const line of lines) {
    if (line.kind === "observation" && !bySequence.has(line.sequence)) {
      bySequence.set(line.sequence, line.observation);
    }
  }
  return [...bySequence]
    .map(([sequence, observation]) => ({ sequence, observation }))
    .sort((a, b) => a.sequence - b.sequence);
};

const bytesOf = (observation: MeasurementObservation): number =>
  new TextEncoder().encode(JSON.stringify(observation)).length;

/**
 * Carries one chunk from "intent journaled" to "summary stored". True when the
 * summary now records it (stored or not is `host.putSummary`'s outcome, below).
 */
const completeChunk = async (
  host: PublicationHost,
  intent: ChunkIntent,
  observations: readonly { sequence: number; observation: MeasurementObservation }[],
): Promise<boolean> => {
  const { clock } = host.environment;
  const body: MeasurementLedgerChunk = {
    schemaVersion: 1,
    chunk: intent.chunk,
    segment: intent.segment,
    fromSequence: intent.fromSequence,
    toSequence: intent.toSequence,
    observations: observations.map((entry) => entry.observation),
  };
  try {
    await uploadArtifact(host, intent.artifactId, body);
  } catch (error) {
    markFailure(host, "chunk upload", error);
    return false;
  }
  if (!intent.marked) {
    const at = nowIso(clock);
    const record = (summary: MeasurementSummary) =>
      markPublished(
        summary,
        {
          segment: intent.segment,
          artifactId: intent.artifactId,
          toSequence: intent.toSequence,
          observations: observations.length,
        },
        at,
      );
    const probe = record(host.summary());
    let rolled: ArtifactId | undefined;
    let rolledSet: ReadonlySet<ArtifactId> = new Set();
    if (probe.overflow) {
      // The id list is over the schema's bound: roll EVERY listed id into an index artifact first.
      const listed = new Set(probe.summary.ledger.artifactIds);
      const entry: IndexEntry = {
        chunk: intent.chunk,
        artifactId: intent.artifactId,
        segment: intent.segment,
        fromSequence: intent.fromSequence,
        toSequence: intent.toSequence,
      };
      const previous = host.summary().ledger.indexArtifactId;
      const index: MeasurementLedgerIndex = {
        schemaVersion: 1,
        ...(previous === undefined ? {} : { previousIndexArtifactId: previous }),
        chunks: [...listed].map(
          (id) => (id === intent.artifactId ? entry : host.chunkLog.get(id)) ?? { artifactId: id },
        ),
      };
      rolledSet = listed;
      const indexed = new Set(index.chunks.map((c) => c.artifactId));
      if (indexed.size !== listed.size || [...listed].some((id) => !indexed.has(id))) {
        markFailure(host, "ledger index", new Error("index does not list every rolled id"));
        return false;
      }
      try {
        rolled = intent.rolledIndex ?? (await indexIdFor(host, intent.segment, listed));
        await uploadArtifact(host, rolled, index);
      } catch (error) {
        markFailure(host, "ledger index upload", error);
        return false;
      }
      intent.rolledIndex = rolled;
      host.chunkLog.clear();
    } else {
      host.chunkLog.set(intent.artifactId, {
        chunk: intent.chunk,
        artifactId: intent.artifactId,
        segment: intent.segment,
        fromSequence: intent.fromSequence,
        toSequence: intent.toSequence,
      });
    }
    // Re-applied to the live summary: observations may have been folded meanwhile.
    try {
      host.update((summary) => {
        const applied = record(summary).summary;
        if (rolled !== undefined && applied.ledger.artifactIds.some((id) => !rolledSet.has(id))) {
          throw new Error("refusing to clear artifact ids the index does not list");
        }
        return rolled === undefined ? applied : rollLedgerIndex(applied, rolled, at);
      });
    } catch (error) {
      markFailure(host, "ledger index", error);
      return false;
    }
    intent.marked = true;
  }
  if (host.dirty()) {
    try {
      await host.putSummary();
    } catch (error) {
      markFailure(host, "summary put", error);
      return false;
    }
  }
  await writePublishedMarkers(host);
  return true;
};

/** Journals `published` for every chunk the stored summary now records. */
export const writePublishedMarkers = async (host: PublicationHost): Promise<void> => {
  for (const [key, intent] of host.intents) {
    if (intent.marked !== true) continue;
    host.intents.delete(key);
    if (intent.rolledIndex !== undefined) {
      await host
        .append(intent.segment, { kind: "indexed", indexArtifactId: intent.rolledIndex })
        .catch(() => {});
    }
    await host
      .append(intent.segment, {
        kind: "published",
        chunk: intent.chunk,
        artifactId: intent.artifactId,
      })
      .catch(() => {});
  }
};

/**
 * Completes an intent found in a journal (recovery): the observations of its
 * range are read back, the upload repeated with the SAME artifact id.
 */
export const completeIntent = async (
  host: PublicationHost,
  intent: ChunkIntent,
): Promise<boolean> => {
  let observations: ReturnType<typeof rangeOf>;
  try {
    observations = rangeOf(await host.lines(intent.segment), intent);
  } catch (error) {
    markFailure(host, "journal read", error);
    return false;
  }
  host.intents.set(segmentKey(intent.segment), intent);
  return completeChunk(host, intent, observations);
};

/**
 * Publishes every folded-but-unpublished observation of one segment, chunk by
 * chunk. False when a chunk could not be published (a gap says why).
 */
export const publishSegment = async (
  host: PublicationHost,
  segment: LaunchRef,
): Promise<boolean> => {
  const key = segmentKey(segment);
  for (;;) {
    const current = host
      .summary()
      .segments.find((s) => s.launchId === segment.launchId && s.segment === segment.segment);
    if (current === undefined) return true;
    let intent = host.intents.get(key);
    if (intent?.marked !== true && current.publishedSequence >= current.receivedSequence) {
      return true;
    }
    let lines: readonly JournalLine[];
    try {
      lines = await host.lines(segment);
    } catch (error) {
      markFailure(host, "journal read", error);
      return false;
    }
    if (intent?.marked === true) {
      // Recorded in memory, awaiting its stored summary: finish that before anything new.
      if (!(await completeChunk(host, intent, rangeOf(lines, intent)))) return false;
      continue;
    }
    if (intent === undefined || intent.fromSequence !== current.publishedSequence + 1) {
      const pending = observationLines(lines).filter(
        (entry) =>
          entry.sequence > current.publishedSequence && entry.sequence <= current.receivedSequence,
      );
      const taken: typeof pending = [];
      let size = 0;
      for (const entry of pending) {
        const next = size + bytesOf(entry.observation);
        if (
          taken.length > 0 &&
          (taken.length >= host.limits.observations || next > host.limits.chunkBytes)
        ) {
          break;
        }
        taken.push(entry);
        size = next;
      }
      const last = taken.at(-1);
      if (last === undefined) return true;
      intent = {
        chunk: host.summary().ledger.chunks,
        artifactId: host.environment.ids.next("art"),
        segment,
        fromSequence: current.publishedSequence + 1,
        toSequence: last.sequence,
      };
      try {
        await host.append(segment, {
          kind: "publishing",
          chunk: intent.chunk,
          artifactId: intent.artifactId,
          segment,
          fromSequence: intent.fromSequence,
          toSequence: intent.toSequence,
        });
      } catch (error) {
        markFailure(host, "journal intent", error);
        return false;
      }
      host.intents.set(key, intent);
    }
    if (!(await completeChunk(host, intent, rangeOf(lines, intent)))) return false;
  }
};

const rangeOf = (lines: readonly JournalLine[], intent: ChunkIntent) =>
  observationLines(lines).filter(
    (entry) => entry.sequence >= intent.fromSequence && entry.sequence <= intent.toSequence,
  );
