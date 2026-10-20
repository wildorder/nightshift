import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Artifact, MeasurementSummary } from "@nightshift/contracts";
import {
  type ArtifactBodyStore,
  createFixtures,
  createSteppingClock,
  makeAgent,
  makeProgramContract,
  makeRootNode,
  makeRun,
} from "@nightshift/core";
import {
  createEngine,
  createMeasurementRecorder,
  type Engine,
  type EventOutbox,
  publishedSummaryFor,
  readJournal,
} from "@nightshift/execution";
import type { HarnessObservation } from "@nightshift/harness";
import { createInMemoryStores } from "@nightshift/persistence/memory";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "./compose.js";
import { attachRun, type OrchestratorSession } from "./session.js";

vi.mock("@nightshift/execution", async (original) => ({
  ...(await original<typeof import("@nightshift/execution")>()),
  createEngine: vi.fn(),
  repairProvisionalLine: vi.fn(async () => undefined),
}));

const directories: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

const fixture = async (remote: boolean) => {
  const f = createFixtures();
  const path = await mkdtemp(join(tmpdir(), "nightshift-attach-recovery-"));
  directories.push(path);
  const stores = createInMemoryStores();
  const program = makeProgramContract(f);
  await stores.programContracts.put(program);
  await stores.runs.put(makeRun(f));
  await stores.executionNodes.put(makeRootNode(f, { status: "running" }));
  await writeFile(join(path, "nightshift.program.json"), JSON.stringify(program));
  const journalDir = (runId: string) => join(path, "runs", runId, "measurements");
  const blobs = new Map<string, string>();
  const bodies: ArtifactBodyStore = {
    put: async (_scope, artifactId, body) => {
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
  const state: OrchestratorSession = {
    repoPath: path,
    contractFile: "nightshift.program.json",
    ...(remote ? { pinnedRun: f.scope } : {}),
    clientInfo: () => ({ name: "test-orchestrator", version: "1" }),
    workerLaunch: () => ({ name: "test", command: "test", args: [], env: {} }),
    runtime: {
      stores,
      ids: f.ids,
      clock: { now: () => Date.parse("2026-10-11T12:00:00Z") },
      bodies,
      paths: {
        spool: () => join(path, "no-spool"),
        measurementsDir: journalDir,
        measurementJournal: (runId: string, agentId: string, launchId: string) =>
          join(journalDir(runId), `${agentId}__${launchId}.ndjson`),
      },
    } as unknown as Runtime,
  };
  const recover = vi.fn(async () => {
    expect(state.current?.session.scope).toEqual(f.scope);
  });
  vi.mocked(createEngine).mockReturnValue({ recover } as unknown as Engine);
  return { state, f, recover, stores, journalDir: journalDir(f.scope.runId) };
};

describe("remote attach rebuilds the engine", () => {
  it("binds the session before adopting durable work and waits for recovery", async () => {
    const { state, f, recover } = await fixture(true);
    const attached = await attachRun(state, { model: "test", runId: f.scope.runId });
    expect(state.current).toBe(attached);
    expect(recover).toHaveBeenCalledTimes(1);
    await attached.outbox.flush(1000);
  });

  it("does not adopt work on an ordinary local attach", async () => {
    const { state, f, recover } = await fixture(false);
    const attached = await attachRun(state, { model: "test", runId: f.scope.runId });
    expect(recover).not.toHaveBeenCalled();
    await attached.outbox.flush(1000);
  });
});

const DEAD_PID = 2_000_000_000;
const request = (id: string): HarnessObservation => ({
  schemaVersion: 1,
  observationId: id,
  source: "harness",
  provenance: { adapter: "test" },
  inclusion: "self",
  kind: "request",
  counters: { inputTokens: 10, outputTokens: 5 },
});

/** A recorder of an earlier engine's agent, run a day before the attach under test. */
const earlierRecorder = (world: Awaited<ReturnType<typeof fixture>>, pid?: number) => {
  const { state, f, stores } = world;
  const rootNodeId = f.rootNodeId;
  const agent = makeAgent(f, rootNodeId);
  const recorder = createMeasurementRecorder(
    {
      stores,
      bodies: state.runtime.bodies,
      clock: createSteppingClock(Date.parse("2026-10-01T00:00:00Z"), 1),
      ids: f.ids,
      paths: state.runtime.paths,
      outbox: { emit: () => undefined } as unknown as EventOutbox,
    },
    {
      scope: f.scope,
      executionNodeId: rootNodeId,
      agent,
      route: { harness: "claude", provider: "anthropic", model: "claude-sonnet-5" },
      routingDecisionId: null,
      ...(pid === undefined ? {} : { pid }),
      limits: { publishEvery: { observations: 1000, ms: 3_600_000 } },
    },
  );
  const journalPath = (launchId: string) =>
    state.runtime.paths.measurementJournal(f.scope.runId, agent.agentId, launchId);
  const stored = async (): Promise<MeasurementSummary> => {
    const summary = await publishedSummaryFor(stores, f.scope, rootNodeId, agent.agentId);
    if (summary === undefined) throw new Error("no stored summary");
    return summary;
  };
  const artifacts = async (): Promise<Artifact[]> => [
    ...(await stores.artifacts.listByRun(f.scope, { limit: 5000 })).items,
  ];
  return { recorder, journalPath, stored, artifacts };
};

const progressMessages = async (world: Awaited<ReturnType<typeof fixture>>) =>
  (await world.stores.events.listByRun(world.f.scope, { limit: 500 })).items
    .filter((event) => event.type === "node.progress")
    .map((event) => (event.payload as { message: string }).message);

describe("attach recovers measurement journals", () => {
  it("publishes a crashed journal's observations once, and a second attach changes nothing", async () => {
    const world = await fixture(false);
    const { recorder, journalPath, stored, artifacts } = earlierRecorder(world, DEAD_PID);
    const ref = await recorder.startSegment({ resumedSession: false });
    for (const id of ["a", "b", "c"]) recorder.sink.observe(request(id));
    await recorder.drain();

    const attached = await attachRun(world.state, { model: "test", runId: world.f.scope.runId });
    await attached.outbox.flush(1000);
    const summary = await stored();
    expect(summary.ledger).toMatchObject({ observationCount: 3, publishedCount: 3 });
    expect(await artifacts()).toHaveLength(1);
    expect(summary.gaps.some((gap) => gap.reason === "stopped_before_flush")).toBe(true);
    expect(summary.segments[0]).toMatchObject({ open: false, receivedSequence: 3 });
    await expect(readFile(journalPath(ref.launchId))).rejects.toThrow();
    expect(await progressMessages(world)).toContain(
      "measurements: recovered 3 observations from 1 journals",
    );

    world.state.current = undefined;
    const again = await attachRun(world.state, { model: "test", runId: world.f.scope.runId });
    await again.outbox.flush(1000);
    expect(await stored()).toEqual(summary);
    expect(await artifacts()).toHaveLength(1);
  });

  it("marks journal_lost when the journal vanished before any publication", async () => {
    const world = await fixture(false);
    const { recorder, journalPath, stored } = earlierRecorder(world);
    const ref = await recorder.startSegment({ resumedSession: false });
    recorder.sink.observe(request("a"));
    recorder.sink.observe(request("b"));
    await recorder.drain();
    await rm(journalPath(ref.launchId));

    const attached = await attachRun(world.state, { model: "test", runId: world.f.scope.runId });
    await attached.outbox.flush(1000);
    const summary = await stored();
    expect(summary.gaps.some((gap) => gap.reason === "journal_lost")).toBe(true);
    expect(summary.segments[0]?.open).toBe(false);
    expect(summary.coverage).not.toBe("complete");
  });

  it("marks journal_lost after a publication without repeating it", async () => {
    const world = await fixture(false);
    const { recorder, journalPath, stored, artifacts } = earlierRecorder(world);
    const ref = await recorder.startSegment({ resumedSession: false });
    recorder.sink.observe(request("a"));
    await recorder.publish();
    const published = await artifacts();
    recorder.sink.observe(request("b"));
    recorder.sink.observe(request("c"));
    await recorder.drain();
    await rm(journalPath(ref.launchId));

    const attached = await attachRun(world.state, { model: "test", runId: world.f.scope.runId });
    await attached.outbox.flush(1000);
    const summary = await stored();
    expect(summary.gaps.some((gap) => gap.reason === "journal_lost")).toBe(true);
    expect(summary.segments[0]?.open).toBe(false);
    expect(summary.coverage).not.toBe("complete");
    expect(await artifacts()).toEqual(published);
  });

  it("leaves a live owner's journal intact", async () => {
    const world = await fixture(false);
    const { recorder, journalPath, stored } = earlierRecorder(world);
    const ref = await recorder.startSegment({ resumedSession: false });
    recorder.sink.observe(request("a"));
    await recorder.drain();
    const before = await readFile(journalPath(ref.launchId));

    const attached = await attachRun(world.state, { model: "test", runId: world.f.scope.runId });
    await attached.outbox.flush(1000);
    expect(await readFile(journalPath(ref.launchId))).toEqual(before);
    expect((await readJournal(journalPath(ref.launchId))).lines.length).toBeGreaterThan(0);
    expect((await stored()).segments[0]?.open).toBe(true);
    expect(await progressMessages(world)).toContain("measurements: 1 live");
  });

  it("attaches anyway when recovery fails, and says so", async () => {
    const world = await fixture(false);
    // A file where the measurements directory should be: readdir fails with ENOTDIR.
    await mkdir(dirname(world.journalDir), { recursive: true });
    await writeFile(world.journalDir, "");
    const attached = await attachRun(world.state, { model: "test", runId: world.f.scope.runId });
    await attached.outbox.flush(1000);
    expect(world.state.current).toBe(attached);
    expect(
      (await progressMessages(world)).some((m) => m.startsWith("measurements: recovery failed")),
    ).toBe(true);
  });
});
