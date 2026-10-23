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
      route: {
        harness: "claude",
        provider: "anthropic",
        model: "claude-sonnet-5",
      },
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
        route: {
          harness: "claude",
          provider: "anthropic",
          model: "claude-sonnet-5",
        },
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

describe("publishedSummaryFor", () => {
  it("returns the newest summary for the agent whatever order the store lists them in", async () => {
    const world = await build();
    const recorder = world.recorder();
    await recorder.startSegment({ resumedSession: false });
    const current = await world.stored();
    const older = {
      ...current,
      measurementSummaryId:
        `${current.measurementSummaryId}-older` as typeof current.measurementSummaryId,
      updatedAt: new Date(Date.parse(current.updatedAt) - 60_000).toISOString(),
    };
    const newer = {
      ...current,
      measurementSummaryId:
        `${current.measurementSummaryId}-newer` as typeof current.measurementSummaryId,
      updatedAt: new Date(Date.parse(current.updatedAt) + 60_000).toISOString(),
    };
    for (const order of [
      [older, current, newer],
      [newer, current, older],
    ]) {
      const listed = new Map(order.map((summary) => [summary.measurementSummaryId, summary]));
      const stores = {
        measurements: {
          listByNode: async () => [...listed.values()],
        },
      } as unknown as Parameters<typeof publishedSummaryFor>[0];
      const found = await publishedSummaryFor(
        stores,
        world.f.scope,
        world.f.rootNodeId,
        world.agent.agentId,
      );
      expect(found?.measurementSummaryId).toBe(newer.measurementSummaryId);
    }
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
    expect(journal.lines[0]).toMatchObject({
      kind: "opened",
      agentId: world.agent.agentId,
    });
  });

  it("takes the baseline from the previous segment's raw session snapshot, and stamps the new launch", async () => {
    const world = await build();
    const recorder = world.recorder();
    const first = await recorder.startSegment({
      sessionId: "s1",
      resumedSession: false,
    });
    recorder.sink.observe({
      ...request("snap1"),
      kind: "cumulative_snapshot",
      counterScope: "session",
      sessionId: "s1",
      counters: { inputTokens: 100 },
    } as HarnessObservation);
    await recorder.close();
    const second = await recorder.startSegment({
      sessionId: "s1",
      resumedSession: true,
    });
    expect(second.launchId).not.toBe(first.launchId);
    expect(second.segment).toBe(1);
    expect(recorder.summary().segments[1]?.baseline).toEqual({
      inputTokens: 100,
    });
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
      {
        kind: "completed",
        usage: { inputTokens: 40, outputTokens: 8 },
        observedModel: "claude-x",
      },
      {
        kind: "failed",
        exitCode: 1,
        usage: { inputTokens: 40, outputTokens: 8 },
      },
      { kind: "cancelled", usage: { inputTokens: 40, outputTokens: 8 } },
      {
        kind: "interrupted",
        signal: "SIGKILL",
        usage: { inputTokens: 40, outputTokens: 8 },
      },
    ];
    for (const exit of exits) {
      const world = await build();
      const recorder = world.recorder();
      await recorder.startSegment({ resumedSession: false });
      const { summary } = await recorder.close(exit);
      expect(summary.totals).toMatchObject({
        inputTokens: 40,
        outputTokens: 8,
      });
      expect(summary.segments[0]).toMatchObject({
        open: false,
        exitKind: exit.kind,
      });
    }
    const world = await build();
    const recorder = world.recorder();
    await recorder.startSegment({ resumedSession: false });
    recorder.sink.observe(request("r1", { inputTokens: 7, outputTokens: 3 }));
    recorder.sink.observe(request("r2", { inputTokens: 7, outputTokens: 3 }));
    const { summary } = await recorder.close({ kind: "cancelled" });
    expect(summary.totals).toMatchObject({ inputTokens: 14, outputTokens: 6 });
  });

  it("carries the exit's inclusion onto its terminal_summary observation", async () => {
    const usage = { inputTokens: 40, outputTokens: 8 };
    const cases: Array<[HarnessExit, string]> = [
      [{ kind: "completed", usage, inclusion: "includes_children" }, "includes_children"],
      [{ kind: "completed", usage }, "self"],
    ];
    for (const [exit, expected] of cases) {
      const world = await build();
      const recorder = world.recorder();
      await recorder.startSegment({ resumedSession: false });
      const { summary } = await recorder.close(exit);
      expect(summary.segments[0]?.sources.aggregateInclusion).toBe(expected);
    }
  });

  it("records the exit's full counters, reasoning included, and falls back to usage without them", async () => {
    const world = await build();
    const recorder = world.recorder();
    await recorder.startSegment({ resumedSession: false });
    const { summary } = await recorder.close({
      kind: "completed",
      usage: { inputTokens: 10, outputTokens: 5 },
      usageScope: "session",
      counters: {
        inputTokens: 10,
        outputTokens: 5,
        reasoningTokens: 3,
        inputIncludesCache: false,
      },
    });
    expect(summary.totals).toMatchObject({
      inputTokens: 10,
      outputTokens: 5,
      reasoningTokens: 3,
    });

    const plain = await build();
    const plainRecorder = plain.recorder();
    await plainRecorder.startSegment({ resumedSession: false });
    const { summary: plainSummary } = await plainRecorder.close({
      kind: "completed",
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    expect(plainSummary.totals).toMatchObject({
      inputTokens: 10,
      outputTokens: 5,
    });
    expect(plainSummary.totals.reasoningTokens).toBeUndefined();
  });

  it("takes reported dollars from the exit's counters before usage", async () => {
    const world = await build();
    const recorder = world.recorder();
    await recorder.startSegment({ resumedSession: false });
    const { summary } = await recorder.close({
      kind: "completed",
      usage: { inputTokens: 10, actualCostUsd: 9 },
      counters: { inputTokens: 10, reportedUsd: 0.5 },
    });
    expect(summary.valuation?.usd).toBe(0.5);
  });

  describe("reported dollars", () => {
    const exit = (
      inputTokens: number,
      actualCostUsd: number,
      usageScope?: "session",
    ): HarnessExit => ({
      kind: "completed",
      sessionId: "s",
      ...(usageScope === undefined ? {} : { usageScope }),
      usage: { inputTokens, actualCostUsd },
    });

    it("takes a resumed session's cumulative dollars above the baseline, not their sum", async () => {
      const world = await build();
      const recorder = world.recorder();
      await recorder.startSegment({ sessionId: "s", resumedSession: false });
      await recorder.close(exit(100, 1, "session"));
      await recorder.startSegment({ sessionId: "s", resumedSession: true });
      const { summary } = await recorder.close(exit(150, 1.5, "session"));
      expect(summary.totals.inputTokens).toBe(150);
      expect(summary.totals.reportedUsd).toBe(1.5);
      expect(summary.valuation).toMatchObject({
        source: "reported",
        usd: 1.5,
        reportedUsd: 1.5,
      });
      expect(summary.gaps).toEqual([]);
    });

    it("sums launch-scoped dollars across launches", async () => {
      const world = await build();
      const recorder = world.recorder();
      await recorder.startSegment({ sessionId: "s", resumedSession: false });
      await recorder.close(exit(100, 1));
      await recorder.startSegment({ sessionId: "s", resumedSession: true });
      const { summary } = await recorder.close(exit(150, 1.5));
      expect(summary.valuation).toMatchObject({ usd: 2.5, reportedUsd: 2.5 });
      expect(summary.totals.inputTokens).toBe(250);
    });

    it("claims no session dollars for a resumed segment with no baseline", async () => {
      const world = await build();
      const recorder = world.recorder();
      await recorder.startSegment({ sessionId: "s", resumedSession: true });
      const { summary } = await recorder.close(exit(150, 1.5, "session"));
      expect(summary.gaps.map((g) => g.reason)).toContain("baseline_unknown");
      expect(summary.totals.reportedUsd).toBeUndefined();
      expect(summary.valuation.usd).toBeUndefined();
    });

    it("recovers the same cumulative dollars from the journals", async () => {
      const world = await build();
      const recorder = crashed(world);
      await recorder.startSegment({ sessionId: "s", resumedSession: false });
      recorder.sink.observe({
        ...request("snap1"),
        kind: "cumulative_snapshot",
        counterScope: "session",
        sessionId: "s",
        counters: { inputTokens: 100, reportedUsd: 1 },
      } as HarnessObservation);
      await recorder.publish();
      await recorder.startSegment({ sessionId: "s", resumedSession: true });
      recorder.sink.observe({
        ...request("snap2"),
        kind: "cumulative_snapshot",
        counterScope: "session",
        sessionId: "s",
        counters: { inputTokens: 150, reportedUsd: 1.5 },
      } as HarnessObservation);
      await recorder.drain();
      await recoverMeasurementJournals(world.later, world.f.scope);
      const stored = await world.stored();
      expect(stored.totals).toMatchObject({
        inputTokens: 150,
        reportedUsd: 1.5,
      });
      expect(stored.valuation).toMatchObject({ usd: 1.5, reportedUsd: 1.5 });
      expect(stored.gaps.filter((g) => g.reason === "baseline_unknown")).toEqual([]);
    });
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
    expect(stored.ledger).toMatchObject({
      chunks: 1,
      observationCount: 3,
      publishedCount: 3,
    });
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
    expect(after.segments[0]).toMatchObject({
      receivedSequence: 3,
      publishedSequence: 3,
    });
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
      // 513 observations are each journaled and fsynced before they publish,
      // which takes longer than the default five-second drain on APFS and NTFS;
      // the overflow is the subject here, not the deadline (which has its own
      // tests), so the drain is given the test's whole budget.
      limits: { publishEvery: { observations: 1, ms: 3_600_000 }, drainDeadlineMs: 110_000 },
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

  it("(5b) a recorder rebuilt from a full summary indexes every rolled id, not only the ones it saw", async () => {
    const world = await build();
    const first = world.recorder({ pid: DEAD_PID });
    await first.startSegment({ resumedSession: false });
    first.sink.observe(request("a"));
    const base = await first.publish();
    const fake = Array.from({ length: 512 }, () => world.f.ids.next("art"));
    const existing: MeasurementSummary = {
      ...base,
      ledger: { ...base.ledger, artifactIds: fake },
    };
    const second = world.recorder({
      pid: DEAD_PID,
      existing,
      limits: { publishEvery: { observations: 1, ms: 3_600_000 } },
    });
    await second.startSegment({ resumedSession: true });
    second.sink.observe(request("b"));
    const summary = await second.publish();
    const indexId = summary.ledger.indexArtifactId;
    expect(indexId).toBeDefined();
    const index = MeasurementLedgerIndexSchema.parse(
      JSON.parse(world.blobs.get(indexId ?? "") ?? "null"),
    );
    expect(index.chunks).toHaveLength(513);
    const listed = new Set(index.chunks.map((c) => c.artifactId));
    for (const id of fake) expect(listed.has(id)).toBe(true);
    expect(index.chunks.filter((c) => c.segment === undefined)).toHaveLength(512);
    expect(summary.ledger.artifactIds.filter((id) => listed.has(id))).toEqual([]);
  });

  it("(5c) recovery seeds ranges from journaled publishing lines; a crash around the index upload yields one index", async () => {
    const world = await build();
    const seed = world.recorder({ pid: DEAD_PID });
    await seed.startSegment({ resumedSession: false });
    const empty = seed.summary();
    const fake = Array.from({ length: 510 }, () => world.f.ids.next("art"));
    const recorder = world.recorder({
      pid: DEAD_PID,
      existing: { ...empty, ledger: { ...empty.ledger, artifactIds: fake } },
      limits: { publishEvery: { observations: 1, ms: 3_600_000 } },
    });
    const ref = await recorder.startSegment({ resumedSession: true });
    recorder.sink.observe(request("a"));
    await recorder.publish();
    recorder.sink.observe(request("b"));
    const base = await recorder.publish();
    const real = base.ledger.artifactIds.slice(-2);
    expect(base.ledger.artifactIds).toHaveLength(512);
    // The next chunk's index is uploaded, then the summary put fails: the crash window.
    recorder.sink.observe(request("c"));
    world.faults.summaryDown = true;
    await recorder.publish();
    world.faults.summaryDown = false;
    const before = (await world.artifacts()).length;
    const crashedLines = (await readJournal(world.journalPath(ref.launchId))).lines;
    const intended = crashedLines.filter((l) => l.kind === "indexing");
    expect(intended).toHaveLength(1);
    expect(crashedLines.some((l) => l.kind === "indexed")).toBe(false);

    await recoverMeasurementJournals(world.later, world.f.scope);
    await recoverMeasurementJournals(world.later, world.f.scope);
    const stored = await world.stored();
    const indexId = stored.ledger.indexArtifactId;
    expect(indexId).toBeDefined();
    expect(stored.ledger.artifactIds).toEqual([]);
    expect(intended[0]).toMatchObject({ indexArtifactId: indexId });
    // Only the index body was new relative to the crashed state's chunk (already uploaded).
    expect((await world.artifacts()).length).toBeLessThanOrEqual(before + 1);
    const indexes = (await world.artifacts()).filter(
      (a) => JSON.parse(world.blobs.get(a.artifactId) ?? "null")?.chunks?.length === 513,
    );
    expect(indexes.map((a) => a.artifactId)).toEqual([indexId]);
    const index = MeasurementLedgerIndexSchema.parse(
      JSON.parse(world.blobs.get(indexId ?? "") ?? ""),
    );
    for (const id of real) {
      expect(index.chunks.find((c) => c.artifactId === id)?.fromSequence).toBeDefined();
    }
  });

  it("(5d) a crash after the rollover's summary put, before the markers: recovery adds nothing and writes the markers", async () => {
    const world = await build();
    const seed = world.recorder({ pid: DEAD_PID });
    await seed.startSegment({ resumedSession: false });
    const empty = seed.summary();
    const fake = Array.from({ length: 511 }, () => world.f.ids.next("art"));
    const recorder = world.recorder({
      pid: DEAD_PID,
      existing: { ...empty, ledger: { ...empty.ledger, artifactIds: fake } },
      limits: { publishEvery: { observations: 1, ms: 3_600_000 } },
    });
    const ref = await recorder.startSegment({ resumedSession: true });
    recorder.sink.observe(request("a"));
    await recorder.publish();
    world.faults.refuseMarkers = true;
    recorder.sink.observe(request("b"));
    await recorder.publish();
    const stored = await world.stored();
    expect(stored.ledger.indexArtifactId).toBeDefined();
    expect(stored.ledger.artifactIds).toEqual([]);
    const chunks = stored.ledger.chunks;
    const artifacts = await world.artifacts();
    const path = world.journalPath(ref.launchId);
    expect((await readJournal(path)).lines.filter((l) => l.kind === "published")).toHaveLength(1);

    world.faults.refuseMarkers = false;
    const result = await recoverMeasurementJournals(world.later, world.f.scope);
    expect(result.completed.length).toBeGreaterThan(0);
    const after = await world.stored();
    expect(after.ledger.chunks).toBe(chunks);
    expect(after.ledger.artifactIds).toEqual([]);
    expect(after.ledger.indexArtifactId).toBe(stored.ledger.indexArtifactId);
    expect(await world.artifacts()).toEqual(artifacts);
    const second = await recoverMeasurementJournals(world.later, world.f.scope);
    expect(second).toEqual({
      recovered: [],
      completed: [],
      lost: [],
      live: [],
      torn: [],
    });
    expect(await world.stored()).toEqual(after);
  });

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
    expect(second).toEqual({
      recovered: [],
      completed: [],
      lost: [],
      live: [],
      torn: [],
    });
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
    expect(stored.segments[0]).toMatchObject({
      open: false,
      coverage: "unknown",
    });
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

describe("per-request valuation", () => {
  const model = "claude-sonnet-5";
  const price = {
    inputPerMTok: 3,
    outputPerMTok: 15,
    source: "anthropic-list",
    version: "2026-10-01",
    tiers: [{ aboveInputTokens: 200_000, inputPerMTok: 6, outputPerMTok: 22.5 }],
  };
  const priced = (id: string, inputTokens: number, outputTokens: number): HarnessObservation =>
    ({
      ...request(id, {
        inputTokens,
        outputTokens,
        inputIncludesCache: false,
      } as never),
      model,
    }) as HarnessObservation;
  const feed = (recorder: MeasurementRecorder) => {
    recorder.sink.observe(priced("a", 100_000, 1000));
    recorder.sink.observe(priced("b", 300_000, 2000));
  };

  it("recorder and recovery produce identical components after replay", async () => {
    const live = await build();
    const liveRecorder = live.recorder({ price });
    await liveRecorder.startSegment({ resumedSession: false });
    feed(liveRecorder);
    const { summary } = await liveRecorder.close();

    const crashedWorld = await build();
    const recorder = crashedWorld.recorder({
      price,
      pid: DEAD_PID,
      limits: { publishEvery: { observations: 1000, ms: 3_600_000 } },
    });
    await recorder.startSegment({ resumedSession: false });
    feed(recorder);
    await recorder.drain();
    await recoverMeasurementJournals(crashedWorld.later, crashedWorld.f.scope, {
      price: () => price,
    });
    const recovered = await crashedWorld.stored();

    expect(summary.valuation.components).toHaveLength(4);
    expect(recovered.valuation.components).toEqual(summary.valuation.components);
    expect(recovered.valuation.completeness).toEqual(summary.valuation.completeness);
    expect(summary.valuation.estimatedUsd).toBeCloseTo(2.16, 9);
    expect(recovered.valuation.estimatedUsd).toBeCloseTo(2.16, 9);
    expect(summary.valuation.priceSource).toBe("anthropic-list");
    expect(recovered.valuation.priceVersion).toBe("2026-10-01");
  });

  it("recovery continues a stored accumulation without recounting folded requests", async () => {
    const world = await build();
    const recorder = world.recorder({
      price,
      pid: DEAD_PID,
      limits: { publishEvery: { observations: 1000, ms: 3_600_000 } },
    });
    await recorder.startSegment({ resumedSession: false });
    recorder.sink.observe(priced("a", 100_000, 1000));
    await recorder.publish();
    recorder.sink.observe(priced("b", 300_000, 2000));
    await recorder.drain();
    await recoverMeasurementJournals(world.later, world.f.scope, {
      price: () => price,
    });
    const recovered = await world.stored();
    expect(recovered.valuation.completeness).toMatchObject({
      valuedRequests: 2,
      unvaluedRequests: 0,
    });
    expect(recovered.valuation.estimatedUsd).toBeCloseTo(2.16, 9);
  });

  it("recovery leaves a replayed input-only request unvalued, with the reason", async () => {
    const world = await build();
    const recorder = world.recorder({
      price,
      pid: DEAD_PID,
      limits: { publishEvery: { observations: 1000, ms: 3_600_000 } },
    });
    await recorder.startSegment({ resumedSession: false });
    recorder.sink.observe({
      ...request("only", {
        inputTokens: 1000,
        inputIncludesCache: true,
      } as never),
      model,
    } as HarnessObservation);
    await recorder.drain();
    await recoverMeasurementJournals(world.later, world.f.scope, {
      price: () => price,
    });
    const recovered = await world.stored();
    expect(recovered.valuation.estimatedUsd).toBeUndefined();
    expect(recovered.valuation.completeness).toMatchObject({
      valuedRequests: 0,
      unvaluedRequests: 1,
      remainderValued: false,
      missing: ["output"],
    });
    expect(recovered.valuation.completeness?.reasons).toContain("request without output counter");
  });

  it("recovery keeps a request without priced cache counters an incomplete lower bound", async () => {
    const cachePrice = {
      inputPerMTok: 1,
      outputPerMTok: 10,
      cacheReadPerMTok: 0.1,
      cacheWritePerMTok: 2,
    };
    const world = await build();
    const recorder = world.recorder({
      price: cachePrice,
      pid: DEAD_PID,
      limits: { publishEvery: { observations: 1000, ms: 3_600_000 } },
    });
    await recorder.startSegment({ resumedSession: false });
    recorder.sink.observe(priced("a", 1000, 100));
    await recorder.drain();
    await recoverMeasurementJournals(world.later, world.f.scope, {
      price: () => cachePrice,
    });
    const recovered = await world.stored();
    expect(recovered.valuation.estimatedUsd).toBeCloseTo(0.002, 9);
    expect(recovered.valuation.requests?.missing).toEqual(["cacheRead", "cacheWrite"]);
    expect(recovered.valuation.completeness).toMatchObject({
      valuedRequests: 1,
      unvaluedRequests: 0,
      missing: ["cacheRead", "cacheWrite"],
    });
    expect(recovered.valuation.completeness?.reasons).toContain(
      "cache counters absent: estimate is a lower bound",
    );
  });

  it("recovery keeps each model's own price source and version", async () => {
    const prices = {
      a: { inputPerMTok: 1, outputPerMTok: 2, source: "A", version: "v1" },
      b: { inputPerMTok: 3, outputPerMTok: 4, source: "B", version: "v2" },
    };
    const world = await build();
    const recorder = world.recorder({
      pid: DEAD_PID,
      limits: { publishEvery: { observations: 1000, ms: 3_600_000 } },
    });
    await recorder.startSegment({ resumedSession: false });
    for (const [id, name] of [
      ["ma", "a"],
      ["mb", "b"],
    ] as const) {
      recorder.sink.observe({
        ...request(id, {
          inputTokens: 10,
          outputTokens: 10,
          inputIncludesCache: false,
        } as never),
        model: name,
      } as HarnessObservation);
    }
    await recorder.drain();
    await recoverMeasurementJournals(world.later, world.f.scope, { prices });
    const recovered = await world.stored();
    expect(recovered.valuation.priceBases).toEqual([
      { model: "a", source: "A", version: "v1" },
      { model: "b", source: "B", version: "v2" },
    ]);
    expect(recovered.valuation.priceSource).toBeUndefined();
  });
});
