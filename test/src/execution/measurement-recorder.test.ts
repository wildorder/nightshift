/**
 * The measurement recorder's acceptance (P20 S-01): the receipt boundary, the
 * segment seams, and the publication protocol under a crash at every window.
 *
 * A "crash" is a recorder that is abandoned after a fault-injecting store or
 * body wrapper made it stop short; recovery then runs with the owner's pid
 * dead and the clock a day later, exactly as a new server would find it.
 */
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Artifact,
  type ArtifactId,
  type MeasurementLedgerChunk,
  MeasurementLedgerChunkSchema,
  MeasurementLedgerIndexSchema,
  type MeasurementSummary,
} from "@nightshift/contracts";
import {
  type ArtifactBodyStore,
  createFixedClock,
  createFixtures,
  createSteppingClock,
  type LocalPaths,
  makeAgent,
  type ProjectStores,
} from "@nightshift/core";
import {
  createMeasurementRecorder,
  durableAppend,
  type EventOutbox,
  type JournalFs,
  type MeasurementRecorder,
  nodeJournalFs,
  publishedSummaryFor,
  readJournal,
  recoverMeasurementJournals,
} from "@nightshift/execution";
import type { HarnessExit, HarnessObservation } from "@nightshift/harness";
import { createInMemoryStores } from "@nightshift/persistence/memory";
import { afterEach, describe, expect, it } from "vitest";

const START = Date.parse("2026-10-01T00:00:00.000Z");
const DEAD_PID = 2_000_000_000;
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const request = (
  id: string,
  counters = { inputTokens: 10, outputTokens: 5 },
): HarnessObservation => ({
  schemaVersion: 1,
  observationId: id,
  source: "harness",
  provenance: { adapter: "test" },
  inclusion: "self",
  kind: "request",
  counters,
});

const never = <T>() => new Promise<T>(() => {});

interface Faults {
  bodiesDown: boolean;
  summaryDown: boolean;
  summaryHangs: boolean;
  stallWrites: boolean;
  refuseMarkers: boolean;
}

const build = async (options: { stepMs?: number } = {}) => {
  const root = await mkdtemp(join(tmpdir(), "ns-measure-"));
  roots.push(root);
  const f = createFixtures();
  const nodeId = f.rootNodeId;
  const agent = makeAgent(f, nodeId);
  const memory = createInMemoryStores();
  const faults: Faults = {
    bodiesDown: false,
    summaryDown: false,
    summaryHangs: false,
    stallWrites: false,
    refuseMarkers: false,
  };
  const stores: ProjectStores = {
    ...memory,
    measurements: {
      ...memory.measurements,
      put: async (summary) => {
        if (faults.summaryDown) throw new Error("control plane unreachable");
        if (faults.summaryHangs) return never<void>();
        return memory.measurements.put(summary);
      },
    },
  };
  const blobs = new Map<string, string>();
  const bodies: ArtifactBodyStore = {
    put: async (_scope, artifactId, body) => {
      if (faults.bodiesDown) throw new Error("storage unreachable");
      const text = typeof body === "string" ? body : new TextDecoder().decode(body);
      blobs.set(artifactId, text);
      return {
        uri: `s3://bucket/${artifactId}`,
        key: artifactId,
        sizeBytes: text.length,
        sha256: "0".repeat(64),
      };
    },
    get: async (_scope, artifactId) => {
      const text = blobs.get(artifactId);
      return text === undefined ? undefined : new TextEncoder().encode(text);
    },
  };
  const journalDir = (runId: string) => join(root, "runs", runId, "measurements");
  const paths = {
    measurementsDir: journalDir,
    measurementJournal: (runId: string, agentId: string, launchId: string) =>
      join(journalDir(runId), `${agentId}__${launchId}.ndjson`),
  } as unknown as LocalPaths;
  const clock = createSteppingClock(START, options.stepMs ?? 1);
  const environment = {
    stores,
    bodies,
    clock,
    ids: f.ids,
    paths,
    outbox: { emit: () => undefined } as unknown as EventOutbox,
  };
  const journalFs: JournalFs<import("node:fs/promises").FileHandle> = {
    write: async (handle, data) => {
      if (faults.stallWrites) return never<number>();
      if (faults.refuseMarkers && new TextDecoder().decode(data).includes('"kind":"published"')) {
        throw new Error("crashed before the marker");
      }
      return nodeJournalFs.write(handle, data);
    },
    fsync: (handle) => nodeJournalFs.fsync(handle),
  };
  const recorder = (extra: Record<string, unknown> = {}): MeasurementRecorder =>
    createMeasurementRecorder(environment, {
      scope: f.scope,
      executionNodeId: nodeId,
      agent,
      route: { harness: "claude", provider: "anthropic", model: "claude-sonnet-5" },
      routingDecisionId: null,
      journalFs,
      ...extra,
    });
  /** Recovery as a new server finds it: a day later. */
  const later = {
    ...environment,
    stores: memory,
    clock: createFixedClock(START + 86_400_000),
  };
  const stored = async (): Promise<MeasurementSummary> => {
    const summary = await publishedSummaryFor(memory, f.scope, nodeId, agent.agentId);
    if (summary === undefined) throw new Error("no stored summary");
    return summary;
  };
  const artifacts = async (): Promise<Artifact[]> => [
    ...(await memory.artifacts.listByRun(f.scope, { limit: 5000 })).items,
  ];
  const journalPath = (launchId: string) =>
    paths.measurementJournal(f.scope.runId, agent.agentId, launchId);
  return {
    f,
    agent,
    memory,
    faults,
    bodies,
    blobs,
    recorder,
    later,
    stored,
    artifacts,
    journalPath,
    environment,
    journalDir: journalDir(f.scope.runId),
  };
};

const chunkOf = async (
  world: Awaited<ReturnType<typeof build>>,
  artifactId: ArtifactId,
): Promise<MeasurementLedgerChunk> =>
  MeasurementLedgerChunkSchema.parse(JSON.parse(world.blobs.get(artifactId) ?? "null"));

describe("durableAppend", () => {
  it("resolves only after the descriptor was fsynced", async () => {
    const log: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fs: JournalFs<number> = {
      write: async (_fd, data) => {
        log.push("write");
        return data.length;
      },
      fsync: async () => {
        log.push("fsync-start");
        await gate;
        log.push("fsync-done");
      },
    };
    const done = durableAppend(fs, 3, "x\n").then(() => log.push("resolved"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(log).toEqual(["write", "fsync-start"]);
    release();
    await done;
    expect(log).toEqual(["write", "fsync-start", "fsync-done", "resolved"]);
  });

  it("finishes a partial write before the fsync", async () => {
    const log: string[] = [];
    const fs: JournalFs<number> = {
      write: async (_fd, data) => {
        log.push(`write ${data.length}`);
        return Math.min(2, data.length);
      },
      fsync: async () => void log.push("fsync"),
    };
    await durableAppend(fs, 1, "abcde");
    expect(log).toEqual(["write 5", "write 3", "write 1", "fsync"]);
  });
});

describe("the receipt boundary", () => {
  it("observe returns synchronously even when the summary put never resolves", async () => {
    const world = await build();
    const recorder = world.recorder();
    await recorder.startSegment({ resumedSession: false });
    world.faults.summaryHangs = true;
    const results = [recorder.sink.observe(request("a")), recorder.sink.observe(request("b"))];
    expect(results).toEqual([undefined, undefined]);
    expect(await recorder.drain()).toEqual({ undrained: 0 });
    expect(recorder.summary().segments[0]?.receivedSequence).toBe(2);
  });

  it("drops beyond maxPending with a receipt_lost gap carrying the count", async () => {
    const world = await build();
    const recorder = world.recorder({ limits: { maxPending: 2 } });
    await recorder.startSegment({ resumedSession: false });
    for (let i = 0; i < 5; i += 1) recorder.sink.observe(request(`o${i}`));
    await recorder.drain();
    const lost = recorder.summary().gaps.find((gap) => gap.reason === "receipt_lost");
    expect(lost?.count).toBe(2);
    expect(recorder.summary().segments[0]?.receivedSequence).toBe(3);
  });

  it("drops an invalid or oversize observation with a gap, never throwing", async () => {
    const world = await build();
    const recorder = world.recorder();
    await recorder.startSegment({ resumedSession: false });
    const invalid = {
      ...request("bad"),
      counters: { inputTokens: -1 },
    } as HarnessObservation;
    expect(() => recorder.sink.observe(invalid)).not.toThrow();
    await recorder.drain();
    expect(recorder.summary().gaps.some((gap) => gap.reason === "receipt_lost")).toBe(true);
    expect(recorder.summary().segments[0]?.receivedSequence).toBe(0);
  });

  it("drops an adapter duplicate by observationId", async () => {
    const world = await build();
    const recorder = world.recorder();
    await recorder.startSegment({ resumedSession: false });
    recorder.sink.observe(request("same"));
    recorder.sink.observe(request("same"));
    await recorder.drain();
    expect(recorder.summary().segments[0]?.receivedSequence).toBe(1);
    expect(recorder.summary().gaps).toEqual([]);
  });

  it("records receipt_lost for an unwritable journal path and never throws", async () => {
    const world = await build();
    const blocker = join(world.journalDir, "..", "blocker");
    await mkdir(join(world.journalDir, ".."), { recursive: true });
    await writeFile(blocker, "a file where a directory should be");
    const recorder = createMeasurementRecorder(
      {
        ...world.environment,
        paths: {
          measurementsDir: () => blocker,
          measurementJournal: () => join(blocker, "x__y.ndjson"),
        } as unknown as LocalPaths,
      },
      {
        scope: world.f.scope,
        executionNodeId: world.f.rootNodeId,
        agent: world.agent,
        route: { harness: "claude", provider: "anthropic", model: "claude-sonnet-5" },
        routingDecisionId: null,
      },
    );
    await expect(recorder.startSegment({ resumedSession: false })).resolves.toBeDefined();
    recorder.sink.observe(request("a"));
    await expect(recorder.drain()).resolves.toEqual({ undrained: 0 });
    expect(recorder.summary().gaps.some((gap) => gap.reason === "receipt_lost")).toBe(true);
    await expect(recorder.close()).resolves.toBeDefined();
  });

  it("reports undrained observations past the deadline and records the gap", async () => {
    const world = await build();
    const recorder = world.recorder({ limits: { drainDeadlineMs: 40 } });
    await recorder.startSegment({ resumedSession: false });
    world.faults.stallWrites = true;
    recorder.sink.observe(request("a"));
    recorder.sink.observe(request("b"));
    const { undrained } = await recorder.drain();
    expect(undrained).toBe(2);
    const lost = recorder.summary().gaps.find((gap) => gap.reason === "receipt_lost");
    expect(lost?.count).toBe(2);
    expect(recorder.summary().segments[0]?.receivedSequence).toBe(0);
  });
});

describe("segments and seams", () => {
  it("publishes an open segment at receivedSequence 0 before any observation", async () => {
    const world = await build();
    const recorder = world.recorder();
    const ref = await recorder.startSegment({ resumedSession: false });
    const stored = await world.stored();
    expect(stored.segments).toHaveLength(1);
    expect(stored.segments[0]).toMatchObject({
      launchId: ref.launchId,
      open: true,
      receivedSequence: 0,
    });
    const journal = await readJournal(world.journalPath(ref.launchId));
    expect(journal.lines[0]).toMatchObject({ kind: "opened", agentId: world.agent.agentId });
  });

  it("takes the baseline from the previous segment's raw session snapshot, and stamps the new launch", async () => {
    const world = await build();
    const recorder = world.recorder();
    const first = await recorder.startSegment({ sessionId: "s1", resumedSession: false });
    recorder.sink.observe({
      ...request("snap1"),
      kind: "cumulative_snapshot",
      counterScope: "session",
      sessionId: "s1",
      counters: { inputTokens: 100 },
    } as HarnessObservation);
    await recorder.close();
    const second = await recorder.startSegment({ sessionId: "s1", resumedSession: true });
    expect(second.launchId).not.toBe(first.launchId);
    expect(second.segment).toBe(1);
    expect(recorder.summary().segments[1]?.baseline).toEqual({ inputTokens: 100 });
    recorder.sink.observe({
      ...request("snap2"),
      kind: "cumulative_snapshot",
      counterScope: "session",
      sessionId: "s1",
      counters: { inputTokens: 150 },
    } as HarnessObservation);
    await recorder.drain();
    const summary = recorder.summary();
    expect(summary.segments[1]?.counters.inputTokens).toBe(50);
    expect(summary.totals.inputTokens).toBe(150);
    const journal = await readJournal(world.journalPath(second.launchId));
    const stamped = journal.lines.find((line) => line.kind === "observation");
    expect(stamped).toMatchObject({
      observation: {
        launch: { launchId: second.launchId, segment: 1 },
        agentId: world.agent.agentId,
      },
    });
  });

  it("retains usage for each exit variant and keeps request totals when a cancel reports none", async () => {
    const exits: HarnessExit[] = [
      { kind: "completed", usage: { inputTokens: 40, outputTokens: 8 }, observedModel: "claude-x" },
      { kind: "failed", exitCode: 1, usage: { inputTokens: 40, outputTokens: 8 } },
      { kind: "cancelled", usage: { inputTokens: 40, outputTokens: 8 } },
      { kind: "interrupted", signal: "SIGKILL", usage: { inputTokens: 40, outputTokens: 8 } },
    ];
    for (const exit of exits) {
      const world = await build();
      const recorder = world.recorder();
      await recorder.startSegment({ resumedSession: false });
      const { summary } = await recorder.close(exit);
      expect(summary.totals).toMatchObject({ inputTokens: 40, outputTokens: 8 });
      expect(summary.segments[0]).toMatchObject({ open: false, exitKind: exit.kind });
    }
    const world = await build();
    const recorder = world.recorder();
    await recorder.startSegment({ resumedSession: false });
    recorder.sink.observe(request("r1", { inputTokens: 7, outputTokens: 3 }));
    recorder.sink.observe(request("r2", { inputTokens: 7, outputTokens: 3 }));
    const { summary } = await recorder.close({ kind: "cancelled" });
    expect(summary.totals).toMatchObject({ inputTokens: 14, outputTokens: 6 });
  });

  it("lands observedModel in observedModels, distinct from the route's model", async () => {
    const world = await build();
    const recorder = world.recorder();
    await recorder.startSegment({ resumedSession: false });
    const { summary } = await recorder.close({
      kind: "completed",
      usage: { inputTokens: 1 },
      observedModel: "claude-sonnet-5-20261001",
    });
    expect(summary.observedModels).toEqual(["claude-sonnet-5-20261001"]);
    expect(summary.route.model).toBe("claude-sonnet-5");
  });

  it("reconciles repeated launch snapshots to the latest", async () => {
    const world = await build();
    const recorder = world.recorder();
    await recorder.startSegment({ resumedSession: false });
    for (const [i, tokens] of [10, 30, 25].entries()) {
      recorder.sink.observe({
        ...request(`s${i}`),
        kind: "cumulative_snapshot",
        counterScope: "launch",
        occurredAt: new Date(START + (i + 1) * 1000).toISOString(),
        counters: { inputTokens: tokens },
      } as HarnessObservation);
    }
    await recorder.drain();
    expect(recorder.summary().totals.inputTokens).toBe(25);
  });

  it("accepts and publishes a lifecycle observation with blockers and a parent", async () => {
    const world = await build();
    const recorder = world.recorder();
    await recorder.startSegment({ resumedSession: false });
    recorder.lifecycle({
      schemaVersion: 1,
      observationId: "life1",
      provenance: { adapter: "engine" },
      inclusion: "self",
      kind: "lifecycle",
      operationId: "op-1",
      parentOperationId: "op-0",
      phase: "verification",
      transition: "start",
      blockers: [{ kind: "prerequisite", ref: "pre-1" }],
    });
    const summary = await recorder.publish();
    expect(summary.segments[0]?.publishedSequence).toBe(1);
    const id = summary.ledger.artifactIds[0];
    expect(id).toBeDefined();
    const chunk = await chunkOf(world, id as ArtifactId);
    expect(chunk.observations[0]).toMatchObject({
      kind: "lifecycle",
      operationId: "op-1",
      source: "engine",
      parentOperationId: "op-0",
    });
  });

  it("publishes incrementally after publishEvery.observations", async () => {
    const world = await build();
    const recorder = world.recorder({
      limits: { publishEvery: { observations: 3, ms: 3_600_000 } },
    });
    await recorder.startSegment({ resumedSession: false });
    for (let i = 0; i < 7; i += 1) recorder.sink.observe(request(`o${i}`));
    await recorder.drain();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const stored = await world.stored();
    expect(stored.ledger.chunks).toBe(2);
    expect(stored.segments[0]?.publishedSequence).toBe(6);
    const lines = (await readJournal(world.journalPath(stored.segments[0]?.launchId ?? ""))).lines;
    expect(lines.some((line) => line.kind === "heartbeat")).toBe(true);
  });

  it("publishes after publishEvery.ms by the clock and writes a heartbeat", async () => {
    const world = await build({ stepMs: 10_000 });
    const recorder = world.recorder({
      limits: { publishEvery: { observations: 1000, ms: 25_000 } },
    });
    const ref = await recorder.startSegment({ resumedSession: false });
    recorder.sink.observe(request("a"));
    await recorder.drain();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await world.stored()).ledger.chunks).toBe(1);
    const lines = (await readJournal(world.journalPath(ref.launchId))).lines;
    expect(lines.filter((line) => line.kind === "heartbeat").length).toBeGreaterThan(0);
  });

  it("removes a fully published journal on close", async () => {
    const world = await build();
    const recorder = world.recorder();
    const ref = await recorder.startSegment({ resumedSession: false });
    recorder.sink.observe(request("a"));
    const { summary, pending } = await recorder.close({ kind: "completed" });
    expect(pending).toBe(0);
    expect(summary.segments[0]?.publishedSequence).toBe(summary.segments[0]?.receivedSequence);
    await expect(readFile(world.journalPath(ref.launchId))).rejects.toThrow();
    expect((await world.stored()).segments[0]?.open).toBe(false);
  });
});

/** Makes the journal's owner dead and returns the launch's journal path. */
const crashed = (world: Awaited<ReturnType<typeof build>>) =>
  world.recorder({
    pid: DEAD_PID,
    limits: { publishEvery: { observations: 1000, ms: 3_600_000 } },
  });

describe("the publication protocol under a crash", () => {
  it("(1) a crash after the intent, before bodies.put: recovery uploads under the same id", async () => {
    const world = await build();
    const recorder = crashed(world);
    const ref = await recorder.startSegment({ resumedSession: false });
    for (const id of ["a", "b", "c"]) recorder.sink.observe(request(id));
    world.faults.bodiesDown = true;
    await recorder.publish();
    world.faults.bodiesDown = false;
    const lines = (await readJournal(world.journalPath(ref.launchId))).lines;
    const intent = lines.find((line) => line.kind === "publishing");
    expect(intent).toBeDefined();
    expect(lines.some((line) => line.kind === "published")).toBe(false);
    expect(await world.artifacts()).toHaveLength(0);

    const result = await recoverMeasurementJournals(world.later, world.f.scope);
    expect(result.recovered).toEqual([
      { agentId: world.agent.agentId, launchId: ref.launchId, observations: 3 },
    ]);
    const artifacts = await world.artifacts();
    expect(artifacts.map((a) => a.artifactId)).toEqual([
      intent?.kind === "publishing" ? intent.artifactId : "",
    ]);
    const stored = await world.stored();
    expect(stored.ledger.artifactIds).toHaveLength(1);
    expect(stored.segments[0]).toMatchObject({
      open: false,
      receivedSequence: 3,
      publishedSequence: 3,
    });
    expect(stored.totals).toMatchObject({ inputTokens: 30, outputTokens: 15 });
    await expect(readFile(world.journalPath(ref.launchId))).rejects.toThrow();
  });

  it("(2) a crash after bodies.put and artifacts.put, before the summary put", async () => {
    const world = await build();
    const recorder = crashed(world);
    const ref = await recorder.startSegment({ resumedSession: false });
    for (const id of ["a", "b", "c"]) recorder.sink.observe(request(id));
    world.faults.summaryDown = true;
    await recorder.publish();
    world.faults.summaryDown = false;
    const before = await world.artifacts();
    expect(before).toHaveLength(1);
    expect((await world.stored()).ledger.chunks).toBe(0);

    await recoverMeasurementJournals(world.later, world.f.scope);
    const after = await world.artifacts();
    expect(after.map((a) => a.artifactId)).toEqual(before.map((a) => a.artifactId));
    const stored = await world.stored();
    expect(stored.ledger.artifactIds).toEqual([before[0]?.artifactId]);
    expect(stored.ledger).toMatchObject({ chunks: 1, observationCount: 3, publishedCount: 3 });
    expect(stored.segments[0]?.launchId).toBe(ref.launchId);
  });

  it("(3) a crash after the summary put, before the published marker: only the marker is owed", async () => {
    const world = await build();
    const recorder = crashed(world);
    const ref = await recorder.startSegment({ resumedSession: false });
    for (const id of ["a", "b", "c"]) recorder.sink.observe(request(id));
    world.faults.refuseMarkers = true;
    await recorder.publish();
    const stored = await world.stored();
    const artifacts = await world.artifacts();
    expect(stored.ledger.chunks).toBe(1);
    const lines = (await readJournal(world.journalPath(ref.launchId))).lines;
    expect(lines.some((line) => line.kind === "published")).toBe(false);

    const result = await recoverMeasurementJournals(world.later, world.f.scope);
    expect(result.completed).toHaveLength(1);
    expect(await world.artifacts()).toEqual(artifacts);
    const after = await world.stored();
    expect(after.ledger).toEqual(stored.ledger);
    expect(after.totals).toEqual(stored.totals);
    expect(after.valuation).toEqual(stored.valuation);
    expect(after.segments[0]).toMatchObject({ receivedSequence: 3, publishedSequence: 3 });
  });

  it("(4) a persistent summary put failure during close keeps the journal; recovery publishes once", async () => {
    const world = await build();
    const recorder = crashed(world);
    const ref = await recorder.startSegment({ resumedSession: false });
    for (const id of ["a", "b", "c"]) recorder.sink.observe(request(id));
    world.faults.summaryDown = true;
    const { summary, pending } = await recorder.close({
      kind: "completed",
      usage: { inputTokens: 5 },
    });
    expect(pending).toBeGreaterThan(0);
    expect(summary.gaps.some((gap) => gap.reason === "delivery_failed")).toBe(true);
    expect((await readJournal(world.journalPath(ref.launchId))).lines.length).toBeGreaterThan(3);
    world.faults.summaryDown = false;

    await recoverMeasurementJournals(world.later, world.f.scope);
    const stored = await world.stored();
    expect(stored.ledger.chunks).toBe(1);
    expect(await world.artifacts()).toHaveLength(1);
    expect(stored.segments[0]).toMatchObject({
      open: false,
      receivedSequence: 4,
      publishedSequence: 4,
    });
    expect(stored.totals.inputTokens).toBe(30);
  });

  it("(5) a ledger overflow writes an index artifact and rolls the id list", async () => {
    const world = await build();
    const recorder = world.recorder({
      pid: DEAD_PID,
      limits: { publishEvery: { observations: 1, ms: 3_600_000 } },
    });
    await recorder.startSegment({ resumedSession: false });
    for (let i = 0; i < 513; i += 1)
      recorder.sink.observe(request(`o${i}`, { inputTokens: 1, outputTokens: 0 }));
    const summary = await recorder.publish();
    expect(summary.ledger.indexArtifactId).toBeDefined();
    expect(summary.ledger.artifactIds.length).toBeLessThan(512);
    expect(summary.ledger.chunks).toBe(513);
    const index = MeasurementLedgerIndexSchema.parse(
      JSON.parse(world.blobs.get(summary.ledger.indexArtifactId ?? "") ?? "null"),
    );
    expect(index.chunks).toHaveLength(513);
    expect((await world.stored()).ledger.indexArtifactId).toBe(summary.ledger.indexArtifactId);
  }, 120_000);

  it("(6) running recovery again is deep-equal and writes no artifact", async () => {
    const world = await build();
    const recorder = crashed(world);
    await recorder.startSegment({ resumedSession: false });
    for (const id of ["a", "b"]) recorder.sink.observe(request(id));
    world.faults.summaryDown = true;
    await recorder.publish();
    world.faults.summaryDown = false;

    await recoverMeasurementJournals(world.later, world.f.scope);
    const first = await world.stored();
    const artifacts = await world.artifacts();
    const second = await recoverMeasurementJournals(world.later, world.f.scope);
    expect(second).toEqual({ recovered: [], completed: [], lost: [], live: [], torn: [] });
    expect(await world.stored()).toEqual(first);
    expect(await world.artifacts()).toEqual(artifacts);
  });
});

describe("liveness and loss", () => {
  it("reports a journal whose owner is this process as live and leaves it byte-for-byte intact", async () => {
    const world = await build();
    const recorder = world.recorder();
    const ref = await recorder.startSegment({ resumedSession: false });
    recorder.sink.observe(request("a"));
    await recorder.drain();
    const before = await readFile(world.journalPath(ref.launchId));
    const result = await recoverMeasurementJournals(world.later, world.f.scope);
    expect(result.live).toEqual([{ agentId: world.agent.agentId, launchId: ref.launchId }]);
    expect(result.recovered).toEqual([]);
    expect(await readFile(world.journalPath(ref.launchId))).toEqual(before);
    expect((await world.stored()).segments[0]?.open).toBe(true);
  });

  it("reports a journal with a fresh heartbeat as live even when its pid is dead", async () => {
    const world = await build();
    const recorder = world.recorder({ pid: DEAD_PID });
    await recorder.startSegment({ resumedSession: false });
    const result = await recoverMeasurementJournals(
      { ...world.later, clock: createFixedClock(START + 30_000) },
      world.f.scope,
    );
    expect(result.live).toHaveLength(1);
  });

  it("marks journal_lost when the journal is deleted before any publication", async () => {
    const world = await build();
    const recorder = world.recorder();
    const ref = await recorder.startSegment({ resumedSession: false });
    for (const id of ["a", "b", "c"]) recorder.sink.observe(request(id));
    await recorder.drain();
    await rm(world.journalPath(ref.launchId));
    expect((await world.stored()).segments[0]?.receivedSequence).toBe(0);

    const result = await recoverMeasurementJournals(world.later, world.f.scope);
    expect(result.lost).toEqual([{ agentId: world.agent.agentId, launchId: ref.launchId }]);
    const stored = await world.stored();
    expect(stored.gaps.some((gap) => gap.reason === "journal_lost")).toBe(true);
    expect(stored.segments[0]).toMatchObject({ open: false, coverage: "unknown" });
    expect(stored.coverage).not.toBe("complete");
  });

  it("marks journal_lost after a publication followed by more observations", async () => {
    const world = await build();
    const recorder = world.recorder();
    const ref = await recorder.startSegment({ resumedSession: false });
    recorder.sink.observe(request("a"));
    recorder.sink.observe(request("b"));
    await recorder.publish();
    recorder.sink.observe(request("c"));
    await recorder.drain();
    await rm(world.journalPath(ref.launchId));

    await recoverMeasurementJournals(world.later, world.f.scope);
    const stored = await world.stored();
    expect(stored.segments[0]).toMatchObject({
      open: false,
      coverage: "partial",
      receivedSequence: 2,
    });
    expect(stored.gaps.find((gap) => gap.reason === "journal_lost")?.detail).toContain(
      "sequence 2",
    );
    expect(stored.coverage).not.toBe("complete");
  });

  it("reports a torn last line and recovers the complete lines", async () => {
    const world = await build();
    const recorder = crashed(world);
    const ref = await recorder.startSegment({ resumedSession: false });
    for (const id of ["a", "b", "c"]) recorder.sink.observe(request(id));
    await recorder.drain();
    await appendFile(world.journalPath(ref.launchId), '{"kind":"observation","sequence":4,"obs');
    const read = await readJournal(world.journalPath(ref.launchId));
    expect(read.torn).toBe(true);
    expect(read.lines.filter((line) => line.kind === "observation")).toHaveLength(3);

    const result = await recoverMeasurementJournals(world.later, world.f.scope);
    expect(result.torn).toEqual([{ agentId: world.agent.agentId, launchId: ref.launchId }]);
    expect(result.recovered[0]?.observations).toBe(3);
    const stored = await world.stored();
    expect(stored.segments[0]).toMatchObject({
      receivedSequence: 3,
      publishedSequence: 3,
      open: false,
    });
    expect(stored.gaps.some((gap) => gap.reason === "stopped_before_flush")).toBe(true);
  });
});
