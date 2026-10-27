/**
 * The line machine's lifecycle over fakes (Pipkin M1b, J5): provisioning, the
 * reconciler and cleanup, held to the records they leave.
 */
import { generateKeyPairSync, sign as signWith } from "node:crypto";
import type { LineDispatch, OrgId, ProjectId } from "@nightshift/contracts";
import {
  calendarMonthOf,
  DEFAULT_COMPUTE_CEILINGS,
  DEFAULT_EXAMINATION_POLICY,
  DEFAULT_ROUTING_POLICY,
  emptyComputeUsage,
} from "@nightshift/contracts";
import type {
  Clock,
  ComputeControl,
  FirstTokenStore,
  InstanceDescription,
  LaunchRequest,
} from "@nightshift/core";
import {
  createFixtures,
  FIXTURE_COMMIT,
  type Fixtures,
  firstTokenParameterName,
  makeDispatch,
  makeLineDispatch,
  makeLineRecord,
  makeProject,
  makeRun,
  makeWarmCache,
  meterProjectUsage,
} from "@nightshift/core";
import { createInMemoryStores, type InMemoryStores } from "@nightshift/persistence/memory";
import { describe, expect, it } from "vitest";
import { cleanupLineDispatch } from "./line-cleanup.js";
import { provisionLineDispatch } from "./provision-line.js";
import { type PublisherRequest, reconcile } from "./reconcile.js";

const START = Date.parse("2026-10-15T12:00:00.000Z");
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const signer = { sign: async (input: Uint8Array) => signWith("sha256", input, keys.privateKey) };
const BRANCH = "nightshift/develop";

interface FakeCompute extends ComputeControl {
  readonly launches: LaunchRequest[];
  readonly terminated: string[];
  readonly snapshots: string[];
  readonly deletedVolumes: string[];
  readonly instances: Map<string, InstanceDescription>;
  /** The instance a ClientToken already made. */
  readonly byToken: Map<string, string>;
  /** Instances not yet terminated. */
  running(): number;
}

const fakeCompute = (): FakeCompute => {
  const compute: FakeCompute = {
    launches: [],
    terminated: [],
    snapshots: [],
    deletedVolumes: [],
    instances: new Map(),
    byToken: new Map(),
    running: () => [...compute.instances.values()].filter((i) => i.state !== "terminated").length,
    latestImage: async () => "ami-1",
    launch: async (request) => {
      const known =
        request.clientToken === undefined ? undefined : compute.byToken.get(request.clientToken);
      if (known !== undefined) return { instanceId: known };
      compute.launches.push(request);
      const instanceId = `i-${compute.launches.length}`;
      if (request.clientToken !== undefined) compute.byToken.set(request.clientToken, instanceId);
      compute.instances.set(instanceId, {
        instanceId,
        state: "running",
        availabilityZone: "us-west-2a",
        ...(request.volume === undefined
          ? {}
          : { workspaceVolumeId: `vol-${compute.launches.length}` }),
      });
      return { instanceId };
    },
    describe: async (instanceId) => compute.instances.get(instanceId),
    attachVolume: async () => undefined,
    terminate: async (instanceId) => {
      compute.terminated.push(instanceId);
      const current = compute.instances.get(instanceId);
      if (current !== undefined)
        compute.instances.set(instanceId, { ...current, state: "terminated" });
    },
    snapshot: async ({ volumeId }) => {
      compute.snapshots.push(volumeId);
      return { snapshotId: `snap-${volumeId}` };
    },
    describeSnapshot: async (snapshotId) => ({ snapshotId, state: "completed" }),
    deleteVolume: async (volumeId) => {
      compute.deletedVolumes.push(volumeId);
    },
    deleteSnapshot: async () => undefined,
  };
  return compute;
};

interface Tokens extends FirstTokenStore {
  readonly parameters: Map<string, string>;
}
const fakeTokens = (): Tokens => {
  const parameters = new Map<string, string>();
  return {
    parameters,
    put: async (name, token) => {
      parameters.set(name, token);
    },
    delete: async (name) => {
      parameters.delete(name);
    },
  };
};

interface World {
  readonly stores: InMemoryStores;
  readonly compute: FakeCompute;
  readonly tokens: Tokens;
  readonly clock: Clock & { at: number };
  readonly orgId: OrgId;
  readonly asked: PublisherRequest[];
  readonly lineFixtures: Fixtures[];
  deps(): Parameters<typeof provisionLineDispatch>[0];
  reconcile(): Promise<Record<string, number>>;
  /** Another project of the same org with a line carrying queued work. */
  addLine(options?: { work?: boolean; dispatched?: boolean }): Promise<Fixtures>;
}

const world = async (ceiling?: number): Promise<World> => {
  const stores = createInMemoryStores();
  const compute = fakeCompute();
  const tokens = fakeTokens();
  const clock = { at: START, now: () => clock.at };
  const orgId = createFixtures().ids.next("org") as OrgId;
  const asked: PublisherRequest[] = [];
  const lineFixtures: Fixtures[] = [];
  if (ceiling !== undefined) {
    await stores.orgConfigs.put({
      schemaVersion: 1,
      orgId,
      routingPolicy: DEFAULT_ROUTING_POLICY,
      examinationPolicy: DEFAULT_EXAMINATION_POLICY,
      installations: [],
      compute: { ...DEFAULT_COMPUTE_CEILINGS, maxConcurrentRuns: ceiling },
      version: 1,
      updatedAt: new Date(START).toISOString(),
    });
  }
  const deps = () => ({
    stores,
    compute,
    tokens,
    signer,
    clock,
    stage: "dev",
    apiEndpoint: "https://api.dev.nightshift.invalid",
    issuer: "https://api.dev.nightshift.invalid",
    imageVersion: "1.0.5",
    subnetIds: ["subnet-a", "subnet-b"],
    subnetZones: { "subnet-a": "us-west-2a", "subnet-b": "us-west-2b" },
    describeAttempts: 1,
    sleep: async () => undefined,
  });
  const ids = createFixtures().ids;
  return {
    stores,
    compute,
    tokens,
    clock,
    orgId,
    asked,
    lineFixtures,
    deps,
    reconcile: () =>
      reconcile({ provision: deps(), ids, askPublisher: async (r) => void asked.push(r) }),
    addLine: async ({ work = true, dispatched = true } = {}) => {
      const f = createFixtures();
      lineFixtures.push(f);
      await stores.projects.put(makeProject(f, { orgId }));
      await stores.lines.update(f.scope.projectId, BRANCH, () =>
        makeLineRecord(f, {
          queue: work
            ? [
                {
                  program: f.scope.programId,
                  upTo: FIXTURE_COMMIT,
                  enqueuedAt: new Date(START).toISOString(),
                },
              ]
            : [],
        }),
      );
      if (dispatched) {
        await stores.lineDispatches.start(
          makeLineDispatch(f, { updatedAt: new Date(START - 10 * 60_000).toISOString() }),
        );
      }
      return f;
    },
  };
};

const lineOf = (f: Fixtures) => ({ projectId: f.scope.projectId, branch: BRANCH });
const dispatchOf = async (w: World, f: Fixtures) =>
  (await w.stores.lineDispatches.get(f.scope.projectId, BRANCH)) as LineDispatch;

describe("provisionLineDispatch", () => {
  it("launches the image with the project's warm snapshot, the line tags and a first token", async () => {
    const w = await world();
    const f = await w.addLine();
    await w.stores.warmCaches.put(makeWarmCache(f));
    const outcome = await provisionLineDispatch(w.deps(), lineOf(f));
    expect(outcome.kind).toBe("provisioned");
    const dispatch = await dispatchOf(w, f);
    expect(dispatch).toMatchObject({
      status: "provisioning",
      instanceId: "i-1",
      volumeId: "vol-1",
      amiVersion: "1.0.5",
      instanceType: "c8id.2xlarge",
    });
    expect(dispatch.attempts[0]?.instanceId).toBe("i-1");
    const launch = w.compute.launches[0];
    expect(launch).toMatchObject({
      imageId: "ami-1",
      volume: { device: "/dev/xvdf", sizeGiB: 100, fromSnapshotId: "snap-fixture" },
      clientToken: `${dispatch.engineAgentId}-1`,
      tags: {
        "nightshift:managed": "true",
        "nightshift-kind": "line",
        "nightshift-project": f.scope.projectId,
        "nightshift-line": BRANCH,
        "nightshift-agent": dispatch.engineAgentId,
        "nightshift-generation": "1",
        "nightshift-stage": "dev",
        "nightshift-api": "https://api.dev.nightshift.invalid",
      },
    });
    expect(launch?.tags.Name).toContain("line");
    expect([...w.tokens.parameters.keys()]).toEqual([
      firstTokenParameterName("dev", dispatch.engineAgentId, 1),
    ]);
  });

  it("launches one machine for two concurrent calls; the loser is skipped", async () => {
    const w = await world();
    const f = await w.addLine();
    const outcomes = await Promise.all([
      provisionLineDispatch(w.deps(), lineOf(f)),
      provisionLineDispatch(w.deps(), lineOf(f)),
    ]);
    expect(outcomes.map((o) => o.kind).sort()).toEqual(["provisioned", "skipped"]);
    expect(w.compute.launches).toHaveLength(1);
    expect(w.compute.launches[0]?.clientToken).toMatch(/-1$/);
    // A later duplicate delivery finds the machine already named.
    expect((await provisionLineDispatch(w.deps(), lineOf(f))).kind).toBe("skipped");
    expect(w.compute.launches).toHaveLength(1);
  });

  it("does not launch when the project's cap was reached while it waited", async () => {
    const w = await world();
    const f = await w.addLine();
    const month = calendarMonthOf(new Date(w.clock.now()).toISOString());
    await w.stores.projectSelfStartedUsage.update(f.scope.projectId, month, (current) =>
      meterProjectUsage(
        current,
        { projectId: f.scope.projectId, month, deltaUsd: 30, capUsd: 25 },
        new Date(w.clock.now()).toISOString(),
      ),
    );
    const outcome = await provisionLineDispatch(w.deps(), lineOf(f));
    expect(outcome.kind).toBe("failed");
    expect(w.compute.launches).toHaveLength(0);
    const dispatch = await dispatchOf(w, f);
    expect(dispatch).toMatchObject({ status: "failed", failure: { code: "line_cap" } });
    expect(dispatch.cleanup.settledAt).toBeDefined();
    const line = await w.stores.lines.get(f.scope.projectId, BRANCH);
    expect(line?.waiting?.reason).toBe("monthly_cap");
    expect(line?.queue).toHaveLength(1);
  });

  it("does not launch when the org's month is spent", async () => {
    const w = await world();
    const f = await w.addLine();
    const month = calendarMonthOf(new Date(w.clock.now()).toISOString());
    await w.stores.computeLedger.put({
      ...emptyComputeUsage(w.orgId, month, new Date(w.clock.now()).toISOString()),
      meteredUsd: DEFAULT_COMPUTE_CEILINGS.maxUsdPerMonth,
    });
    await provisionLineDispatch(w.deps(), lineOf(f));
    expect(w.compute.launches).toHaveLength(0);
    expect(await dispatchOf(w, f)).toMatchObject({
      status: "failed",
      failure: { code: "org_month" },
    });
    expect((await w.stores.lines.get(f.scope.projectId, BRANCH))?.waiting?.reason).toBe(
      "org_month_ceiling",
    );
  });

  it("stays requested with org_concurrency at the ceiling, and a waiting request holds no slot", async () => {
    const w = await world(1);
    const f = await w.addLine();
    // A live run of the org holds the one slot.
    const run = createFixtures();
    await w.stores.projects.put(makeProject(run, { orgId: w.orgId }));
    await w.stores.runs.put(makeRun(run, { status: "pending", location: "remote" }));
    await w.stores.dispatches.put(makeDispatch(run, { status: "running" }));
    const outcome = await provisionLineDispatch(w.deps(), lineOf(f));
    expect(outcome).toEqual({ kind: "waiting", reason: "org_concurrency" });
    expect(w.compute.launches).toHaveLength(0);
    expect((await dispatchOf(w, f)).status).toBe("requested");
    expect((await w.stores.lines.get(f.scope.projectId, BRANCH))?.waiting?.reason).toBe(
      "org_concurrency",
    );
    // The slot frees: the same request now launches and the waiting is cleared.
    await w.stores.dispatches.put(makeDispatch(run, { status: "failed" }));
    expect((await provisionLineDispatch(w.deps(), lineOf(f))).kind).toBe("provisioned");
    expect((await w.stores.lines.get(f.scope.projectId, BRANCH))?.waiting).toBeUndefined();
  });
});

describe("reconcile: line dispatches", () => {
  const live = (f: Fixtures, over: Partial<LineDispatch> = {}) =>
    makeLineDispatch(f, {
      status: "running",
      instanceId: "i-old",
      volumeId: "vol-old",
      engineAgentId: f.ids.next("agent"),
      leaseExpiresAt: new Date(START - 60_000).toISOString(),
      attempts: [
        {
          generation: 1,
          reason: "dispatch",
          startedAt: "2026-10-15T11:00:00.000Z",
          instanceId: "i-old",
        },
      ],
      ...over,
    });
  const install = async (w: World, f: Fixtures, dispatch: LineDispatch) => {
    await w.stores.lineDispatches.update(f.scope.projectId, BRANCH, () => dispatch);
    w.compute.instances.set("i-old", {
      instanceId: "i-old",
      state: "running",
      availabilityZone: "us-west-2a",
    });
  };

  it("provisions a stale requested dispatch", async () => {
    const w = await world();
    const f = await w.addLine();
    const counts = await w.reconcile();
    expect(counts["line-provision:provisioned"]).toBe(1);
    expect((await dispatchOf(w, f)).status).toBe("provisioning");
    expect(w.compute.launches).toHaveLength(1);
  });

  it("replaces a lost lease with a higher generation", async () => {
    const w = await world();
    const f = await w.addLine({ dispatched: false });
    await w.stores.lineDispatches.start(makeLineDispatch(f));
    await install(w, f, live(f));
    const counts = await w.reconcile();
    expect(counts["line-lease:replacing"]).toBe(1);
    expect(w.compute.terminated).toContain("i-old");
    const dispatch = await dispatchOf(w, f);
    expect(dispatch).toMatchObject({ generation: 2, status: "provisioning" });
    expect(dispatch.instanceId).not.toBe("i-old");
    expect(w.compute.launches[0]?.tags["nightshift-generation"]).toBe("2");
    expect(w.compute.launches[0]?.clientToken).toBe(`${dispatch.engineAgentId}-2`);
  });

  it("ends the dispatch failed once the attempts are exhausted", async () => {
    const w = await world();
    const f = await w.addLine({ dispatched: false });
    await w.stores.lineDispatches.start(makeLineDispatch(f));
    const attempts = [1, 2, 3].map((generation) => ({
      generation,
      reason: generation === 1 ? ("dispatch" as const) : ("lease_lost" as const),
      startedAt: "2026-10-15T11:00:00.000Z",
    }));
    await install(w, f, live(f, { generation: 3, attempts }));
    const counts = await w.reconcile();
    expect(counts["line-lease:exhausted"]).toBe(1);
    expect(await dispatchOf(w, f)).toMatchObject({
      status: "failed",
      failure: { code: "recovery_exhausted" },
    });
    expect(w.compute.launches).toHaveLength(0);
  });

  it("does not replace a lost lease once the cap is reached; it ends failed and waits", async () => {
    const w = await world();
    const f = await w.addLine({ dispatched: false });
    await w.stores.lineDispatches.start(makeLineDispatch(f));
    await install(w, f, live(f));
    const month = calendarMonthOf(new Date(START).toISOString());
    await w.stores.projectSelfStartedUsage.update(f.scope.projectId, month, (current) =>
      meterProjectUsage(
        current,
        { projectId: f.scope.projectId, month, deltaUsd: 25, capUsd: 25 },
        new Date(START).toISOString(),
      ),
    );
    const counts = await w.reconcile();
    expect(counts["line-lease:refused"]).toBe(1);
    expect(w.compute.launches).toHaveLength(0);
    expect(await dispatchOf(w, f)).toMatchObject({
      status: "failed",
      generation: 1,
      failure: { code: "line_cap" },
    });
    const line = await w.stores.lines.get(f.scope.projectId, BRANCH);
    expect(line?.waiting?.reason).toBe("monthly_cap");
    expect(line?.queue).toHaveLength(1);
  });

  it("leaves a live dispatch with a held lease alone", async () => {
    const w = await world();
    const f = await w.addLine({ dispatched: false });
    await w.stores.lineDispatches.start(makeLineDispatch(f));
    await install(w, f, live(f, { leaseExpiresAt: new Date(START + 60_000).toISOString() }));
    const counts = await w.reconcile();
    expect(counts["line-lease:alive"]).toBe(1);
    expect(w.compute.terminated).toEqual([]);
  });

  it("cleans up a failed dispatch without a snapshot, settles it, then starts exactly one new dispatch", async () => {
    const w = await world();
    const f = await w.addLine({ dispatched: false });
    await w.stores.lineDispatches.start(makeLineDispatch(f));
    await install(
      w,
      f,
      live(f, { status: "failed", failure: { code: "wall_clock", message: "late" } }),
    );
    const started: string[] = [];
    const cleanupDeps = {
      stores: w.stores,
      compute: w.compute,
      clock: w.clock,
      ids: createFixtures().ids,
      startMachine: async (line: { branch: string }) => void started.push(line.branch),
    };
    const dispatchNow = () => dispatchOf(w, f);
    // First pass asks the instance to go (here it is gone at once); the next sees it.
    await cleanupLineDispatch(cleanupDeps, await dispatchNow());
    expect(w.compute.terminated).toEqual(["i-old"]);
    expect((await dispatchNow()).cleanup.settledAt).toBeUndefined();
    await cleanupLineDispatch(cleanupDeps, await dispatchNow());
    expect(w.compute.deletedVolumes).toEqual(["vol-old"]);
    expect(w.compute.snapshots).toEqual([]);
    const settled = await dispatchNow();
    // The new dispatch is stored in the same pass once settled and the queue is non-empty.
    expect(started).toEqual([BRANCH]);
    expect(settled).toMatchObject({ status: "requested", generation: 2 });
    // Another pass finds a live dispatch and starts nothing.
    await cleanupLineDispatch(cleanupDeps, await dispatchNow());
    expect(started).toEqual([BRANCH]);
    const previous = await w.stores.lineDispatches.get(f.scope.projectId, BRANCH);
    expect(previous?.generation).toBe(2);
  });

  it("settles at once a dispatch that never launched anything", async () => {
    const w = await world();
    const f = await w.addLine({ work: false, dispatched: false });
    await w.stores.lineDispatches.start(makeLineDispatch(f));
    await w.stores.lineDispatches.update(f.scope.projectId, BRANCH, (d) => ({
      ...d,
      status: "failed",
      failure: { code: "line_cap", message: "capped" },
    }));
    await cleanupLineDispatch(
      {
        stores: w.stores,
        compute: w.compute,
        clock: w.clock,
        ids: createFixtures().ids,
        startMachine: async () => undefined,
      },
      await dispatchOf(w, f),
    );
    expect((await dispatchOf(w, f)).cleanup.settledAt).toBeDefined();
    expect(w.compute.terminated).toEqual([]);
    expect(w.compute.deletedVolumes).toEqual([]);
  });

  it("launches three waiting lines one at a time under a ceiling of one, with no deadlock", async () => {
    const w = await world(1);
    const lines = [await w.addLine(), await w.addLine(), await w.addLine()];
    const launched = new Set<string>();
    for (let tick = 0; tick < 12 && launched.size < 3; tick += 1) {
      await w.reconcile();
      expect(w.compute.running()).toBeLessThanOrEqual(1);
      for (const f of lines) {
        const d = await dispatchOf(w, f);
        if (d.instanceId === undefined || launched.has(f.scope.projectId)) continue;
        launched.add(f.scope.projectId);
        // The owner catches up and exits: the queue empties and the dispatch ends.
        await w.stores.lines.update(f.scope.projectId, BRANCH, (row) =>
          row === undefined ? undefined : { ...row, queue: [] },
        );
        await w.stores.lineDispatches.update(f.scope.projectId, BRANCH, (row) => ({
          ...row,
          status: "stopped",
        }));
      }
    }
    expect(launched.size).toBe(3);
    expect(w.compute.launches).toHaveLength(3);
  });
});

describe("reconcile: lines with work and the publisher", () => {
  it("gives a line with queued entries and no dispatch a dispatch", async () => {
    const w = await world();
    const f = await w.addLine({ dispatched: false });
    expect(await w.stores.lineDispatches.get(f.scope.projectId, BRANCH)).toBeUndefined();
    const counts = await w.reconcile();
    expect(counts["line-admit:started"]).toBe(1);
    expect(await dispatchOf(w, f)).toMatchObject({ generation: 1, status: "provisioning" });
    expect(w.compute.launches).toHaveLength(1);
    // The next pass finds it live and starts nothing more.
    await w.reconcile();
    expect(w.compute.launches).toHaveLength(1);
  });

  it("does not admit a line whose queue is empty", async () => {
    const w = await world();
    const f = await w.addLine({ work: false, dispatched: false });
    await w.reconcile();
    expect(await w.stores.lineDispatches.get(f.scope.projectId, BRANCH)).toBeUndefined();
  });

  it("asks the publisher about a run that owes the line a range, with no pending intent", async () => {
    const w = await world();
    const f = createFixtures();
    await w.stores.projects.put(makeProject(f, { orgId: w.orgId }));
    await w.stores.runs.put(makeRun(f, { status: "pending", location: "remote" }));
    await w.stores.dispatches.put(
      makeDispatch(f, {
        status: "stopped",
        cleanup: { volumeDeleted: true, failures: [] },
        publication: { intents: [], lineOwed: true, head: FIXTURE_COMMIT },
      }),
    );
    await w.reconcile();
    expect(w.asked).toEqual([
      { projectId: f.scope.projectId, programId: f.scope.programId, runId: f.scope.runId },
    ]);
    // Once that head is queued, it is not asked again.
    w.asked.length = 0;
    await w.stores.dispatches.put(
      makeDispatch(f, {
        status: "stopped",
        cleanup: { volumeDeleted: true, failures: [] },
        publication: {
          intents: [],
          lineOwed: true,
          head: FIXTURE_COMMIT,
          lineQueuedUpTo: FIXTURE_COMMIT,
        },
      }),
    );
    await w.reconcile();
    expect(w.asked).toEqual([]);
  });

  it("asks the publisher, with a line event, about a line whose push is pending", async () => {
    const w = await world();
    const f = await w.addLine({ work: false, dispatched: false });
    await w.stores.lines.update(f.scope.projectId, BRANCH, (row) =>
      row === undefined
        ? undefined
        : {
            ...row,
            push: {
              head: FIXTURE_COMMIT,
              expectedPredecessor: FIXTURE_COMMIT,
              bundleKey: "bundles/x",
              generation: 1,
              status: "pending",
              requestedAt: new Date(START).toISOString(),
            },
          },
    );
    await w.reconcile();
    expect(w.asked).toContainEqual({
      kind: "line",
      projectId: f.scope.projectId as ProjectId,
      branch: BRANCH,
    });
  });
});
