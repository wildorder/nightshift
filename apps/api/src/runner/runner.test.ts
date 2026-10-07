/**
 * Provisioning and cleanup over fakes (P10, T3): what the dispatch Lambda and
 * the reconciler do, held to the record they leave.
 */
import { generateKeyPairSync, sign as signWith } from "node:crypto";
import type { Dispatch, ProgramContract } from "@nightshift/contracts";
import type { ComputeControl, FirstTokenStore, InstanceDescription } from "@nightshift/core";
import {
  createFixedClock,
  createFixtures,
  type Fixtures,
  makeComputeUtilization,
  makeDispatch,
  makeProgramContract,
  makeProject,
  makeRun,
  makeWarmCache,
} from "@nightshift/core";
import { createInMemoryStores, type InMemoryStores } from "@nightshift/persistence/memory";
import { describe, expect, it } from "vitest";
import { cleanupStopped, enforceStop } from "./cleanup.js";
import { machineTags, provisionDispatch, subnetFor, subnetsFor } from "./provision.js";
import { recoverLostLease } from "./recover.js";

const NOW = Date.parse("2026-10-01T12:00:00.000Z");
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const signer = {
  sign: async (input: Uint8Array) => signWith("sha256", input, keys.privateKey),
};

interface FakeCompute extends ComputeControl {
  readonly launches: Parameters<ComputeControl["launch"]>[0][];
  readonly terminated: string[];
  readonly attached: { volumeId: string; instanceId: string; device: string }[];
  /** Attach refusals left before one succeeds: a volume the old machine still holds. */
  attachRefusals: number;
  readonly snapshots: Map<string, "pending" | "completed" | "error">;
  readonly deletedVolumes: string[];
  readonly deletedSnapshots: string[];
  instances: Map<string, InstanceDescription>;
  image: string | undefined;
  failLaunch: boolean;
  /** Subnets EC2 has no room in, and an error that is not about room. */
  noCapacityIn: Set<string>;
  launchError: string | undefined;
}

const fakeCompute = (): FakeCompute => {
  const compute: FakeCompute = {
    launches: [],
    terminated: [],
    attached: [],
    attachRefusals: 0,
    snapshots: new Map(),
    deletedVolumes: [],
    deletedSnapshots: [],
    instances: new Map(),
    image: "ami-1",
    failLaunch: false,
    noCapacityIn: new Set(),
    launchError: undefined,
    latestImage: async () => compute.image,
    launch: async (request) => {
      if (compute.failLaunch) throw new Error("InsufficientInstanceCapacity");
      if (compute.launchError !== undefined) throw new Error(compute.launchError);
      if (compute.noCapacityIn.has(request.subnetId)) {
        throw Object.assign(
          new Error(
            `We currently do not have sufficient ${request.instanceType} capacity in the Availability Zone you requested.`,
          ),
          { name: "InsufficientInstanceCapacity" },
        );
      }
      compute.launches.push(request);
      const instanceId = `i-${compute.launches.length}`;
      compute.instances.set(instanceId, {
        instanceId,
        state: "running",
        availabilityZone: "us-west-2a",
        // A replacement launches with no volume; its own is attached after.
        ...(request.volume === undefined
          ? {}
          : { workspaceVolumeId: `vol-${compute.launches.length}` }),
      });
      return { instanceId };
    },
    describe: async (instanceId) => compute.instances.get(instanceId),
    attachVolume: async ({ volumeId, instanceId, device }) => {
      if (compute.attachRefusals > 0) {
        compute.attachRefusals -= 1;
        throw new Error("VolumeInUse");
      }
      compute.attached.push({ volumeId, instanceId, device });
      const current = compute.instances.get(instanceId);
      if (current !== undefined)
        compute.instances.set(instanceId, { ...current, workspaceVolumeId: volumeId });
    },
    terminate: async (instanceId) => {
      compute.terminated.push(instanceId);
      const current = compute.instances.get(instanceId);
      if (current !== undefined)
        compute.instances.set(instanceId, { ...current, state: "terminated" });
    },
    snapshot: async ({ volumeId }) => {
      const snapshotId = `snap-${volumeId}`;
      compute.snapshots.set(snapshotId, "pending");
      return { snapshotId };
    },
    describeSnapshot: async (snapshotId) => {
      const state = compute.snapshots.get(snapshotId);
      return state === undefined ? undefined : { snapshotId, state };
    },
    deleteVolume: async (volumeId) => {
      compute.deletedVolumes.push(volumeId);
    },
    deleteSnapshot: async (snapshotId) => {
      compute.deletedSnapshots.push(snapshotId);
    },
  };
  return compute;
};

const fakeTokens = () => {
  const parameters = new Map<string, string>();
  const store: FirstTokenStore = {
    put: async (name, token) => {
      parameters.set(name, token);
    },
    delete: async (name) => {
      parameters.delete(name);
    },
  };
  return { store, parameters };
};

interface World {
  readonly stores: InMemoryStores;
  readonly f: Fixtures;
  readonly compute: FakeCompute;
  readonly tokens: ReturnType<typeof fakeTokens>;
  readonly program: ProgramContract;
  deps(): Parameters<typeof provisionDispatch>[0];
  cleanup(): Parameters<typeof cleanupStopped>[0];
  recover(): Parameters<typeof recoverLostLease>[0];
}

const world = async (dispatch: Partial<Dispatch> = {}): Promise<World> => {
  const stores = createInMemoryStores();
  const f = createFixtures();
  const program = makeProgramContract(f);
  await stores.projects.put(makeProject(f));
  await stores.programContracts.put(program);
  await stores.runs.put(makeRun(f, { status: "pending", location: "remote" }));
  await stores.dispatches.put(makeDispatch(f, dispatch));
  const compute = fakeCompute();
  const tokens = fakeTokens();
  const clock = createFixedClock(NOW);
  return {
    stores,
    f,
    compute,
    tokens,
    program,
    deps: () => ({
      stores,
      compute,
      tokens: tokens.store,
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
    }),
    recover: () => ({ stores, compute, clock }),
    cleanup: () => ({ stores, compute, clock, stage: "dev" }),
  };
};

describe("provisionDispatch (D-P10-18, D-P10-15, D-P10-20)", () => {
  it("parks a first token, launches from the image with an empty volume, and records the machine", async () => {
    const w = await world();
    const outcome = await provisionDispatch(w.deps(), w.f.scope);
    expect(outcome.kind).toBe("provisioned");
    const dispatch = await w.stores.dispatches.get(w.f.scope);
    expect(dispatch).toMatchObject({
      status: "provisioning",
      instanceId: "i-1",
      volumeId: "vol-1",
      availabilityZone: "us-west-2a",
      amiVersion: "1.0.5",
    });
    expect(dispatch?.attempts[0]?.instanceId).toBe("i-1");
    expect([...w.tokens.parameters.keys()]).toEqual([
      `/nightshift/dev/dispatch/${w.f.scope.runId}/1`,
    ]);
    const launch = w.compute.launches[0];
    expect(launch).toMatchObject({
      imageId: "ami-1",
      instanceType: "c8id.2xlarge",
      volume: { device: "/dev/xvdf", sizeGiB: 100 },
    });
    expect(launch?.volume?.fromSnapshotId).toBeUndefined();
    expect(launch?.tags).toMatchObject({
      "nightshift:managed": "true",
      "nightshift-run": w.f.scope.runId,
      "nightshift-generation": "1",
      "nightshift-stage": "dev",
    });
    expect(["subnet-a", "subnet-b"]).toContain(launch?.subnetId);
  });

  it("starts cold and forgets the cache when the warm snapshot no longer exists", async () => {
    const w = await world();
    await w.stores.warmCaches.put(
      makeWarmCache(w.f, {
        current: {
          snapshotId: "snap-deleted-by-hand",
          amiVersion: "1.0.4",
          lockfileHashes: {},
          fromRunId: w.f.scope.runId,
          takenAt: "2026-10-01T11:00:00.000Z",
        },
      }),
    );
    // The fake knows no such snapshot: describeSnapshot answers undefined.
    const outcome = await provisionDispatch(w.deps(), w.f.scope);
    expect(outcome.kind).toBe("provisioned");
    expect(w.compute.launches[0]?.volume?.fromSnapshotId).toBeUndefined();
    expect(await w.stores.warmCaches.get(w.f.scope.projectId, "x86_64")).toBeUndefined();
  });

  it("starts the volume from the project's warm snapshot when there is one", async () => {
    const w = await world();
    w.compute.snapshots.set("snap-warm", "completed");
    await w.stores.warmCaches.put(
      makeWarmCache(w.f, {
        current: {
          snapshotId: "snap-warm",
          amiVersion: "1.0.4",
          lockfileHashes: {},
          fromRunId: w.f.scope.runId,
          takenAt: "2026-10-01T11:00:00.000Z",
        },
      }),
    );
    await provisionDispatch(w.deps(), w.f.scope);
    expect(w.compute.launches[0]?.volume?.fromSnapshotId).toBe("snap-warm");
  });

  it("records a failure and removes the parked token when the launch fails", async () => {
    const w = await world();
    w.compute.failLaunch = true;
    const outcome = await provisionDispatch(w.deps(), w.f.scope);
    expect(outcome.kind).toBe("failed");
    expect((await w.stores.dispatches.get(w.f.scope))?.failure).toMatchObject({
      code: "provisioning_failed",
      message: expect.stringContaining("InsufficientInstanceCapacity"),
    });
    expect(w.tokens.parameters.size).toBe(0);
  });

  it("launches a first machine in another zone when the run's zone has no capacity", async () => {
    const w = await world();
    const [first, second] = subnetsFor(w.f.scope.runId, ["subnet-a", "subnet-b"]);
    w.compute.noCapacityIn.add(first as string);
    const outcome = await provisionDispatch(w.deps(), w.f.scope);
    expect(outcome.kind).toBe("provisioned");
    expect(w.compute.launches.map((launch) => launch.subnetId)).toEqual([second]);
  });

  it("fails, naming every zone, when none has capacity, and at once on any other error", async () => {
    const w = await world();
    w.compute.noCapacityIn = new Set(["subnet-a", "subnet-b"]);
    expect((await provisionDispatch(w.deps(), w.f.scope)).kind).toBe("failed");
    const failure = (await w.stores.dispatches.get(w.f.scope))?.failure?.message ?? "";
    expect(failure).toContain("no zone had capacity");
    expect(failure).toContain("us-west-2a");
    expect(failure).toContain("us-west-2b");

    const other = await world();
    other.compute.launchError = "UnauthorizedOperation";
    expect((await provisionDispatch(other.deps(), other.f.scope)).kind).toBe("failed");
    expect(other.compute.launches).toEqual([]);
    expect((await other.stores.dispatches.get(other.f.scope))?.failure?.message).toContain(
      "UnauthorizedOperation",
    );
  });

  it("fails plainly without an image for the version, and skips a dispatch with a machine", async () => {
    const w = await world();
    w.compute.image = undefined;
    expect((await provisionDispatch(w.deps(), w.f.scope)).kind).toBe("failed");
    const done = await world({ status: "running", instanceId: "i-9" });
    expect((await provisionDispatch(done.deps(), done.f.scope)).kind).toBe("skipped");
  });

  it("spreads runs across subnets and always picks the same one for a run", () => {
    const f = createFixtures();
    const ids = Array.from({ length: 20 }, () => f.ids.next("run"));
    const chosen = new Set(ids.map((id) => subnetFor(id, ["a", "b", "c"])));
    expect(chosen.size).toBeGreaterThan(1);
    expect(subnetFor(ids[0] as never, ["a", "b", "c"])).toBe(
      subnetFor(ids[0] as never, ["a", "b", "c"]),
    );
    expect(subnetFor(ids[0] as never, [])).toBeUndefined();
  });

  it("tags the machine with what the runner reads", async () => {
    const w = await world();
    const dispatch = await w.stores.dispatches.get(w.f.scope);
    const tags = machineTags(dispatch as Dispatch, "dev", "https://api");
    expect(Object.keys(tags).sort()).toEqual(
      [
        "Name",
        "nightshift-api",
        "nightshift-generation",
        "nightshift-program",
        "nightshift-project",
        "nightshift-run",
        "nightshift-stage",
        "nightshift:managed",
      ].sort(),
    );
  });
});

describe("cleanup (D-P10-15, D-P10-18)", () => {
  it("terminates a stopping machine that went quiet for two heartbeats", async () => {
    const w = await world({
      status: "stopping",
      instanceId: "i-1",
      updatedAt: new Date(NOW - 60_000).toISOString(),
    });
    expect(
      await enforceStop(w.cleanup(), (await w.stores.dispatches.get(w.f.scope)) as Dispatch),
    ).toBe("terminated");
    expect(w.compute.terminated).toEqual(["i-1"]);
    expect((await w.stores.dispatches.get(w.f.scope))?.status).toBe("stopped");
    const fresh = await world({
      status: "stopping",
      instanceId: "i-2",
      updatedAt: new Date(NOW - 10_000).toISOString(),
    });
    expect(
      await enforceStop(
        fresh.cleanup(),
        (await fresh.stores.dispatches.get(fresh.f.scope)) as Dispatch,
      ),
    ).toBe("waiting");
  });

  it("snapshots a stopped run's volume into the warm cache, then deletes the volume, over three ticks", async () => {
    const w = await world({
      status: "stopped",
      instanceId: "i-1",
      volumeId: "vol-1",
      lockfileHashes: { "package-lock.json": "abc" },
    });
    w.compute.instances.set("i-1", { instanceId: "i-1", state: "terminated" });
    await w.stores.computeUtilizations.put(makeComputeUtilization(w.f, { setupSeconds: 40 }));
    const dispatch = () => w.stores.dispatches.get(w.f.scope) as Promise<Dispatch>;

    expect(await cleanupStopped(w.cleanup(), await dispatch())).toBe("snapshot_started");
    expect((await dispatch()).cleanup.snapshotId).toBe("snap-vol-1");
    expect(await cleanupStopped(w.cleanup(), await dispatch())).toBe("snapshot_pending");

    w.compute.snapshots.set("snap-vol-1", "completed");
    expect(await cleanupStopped(w.cleanup(), await dispatch())).toBe("cache_updated");
    const cache = await w.stores.warmCaches.get(w.f.scope.projectId, "x86_64");
    expect(cache?.current).toMatchObject({
      snapshotId: "snap-vol-1",
      fromRunId: w.f.scope.runId,
      lockfileHashes: { "package-lock.json": "abc" },
    });
    expect(await cleanupStopped(w.cleanup(), await dispatch())).toBe("volume_deleted");
    expect(w.compute.deletedVolumes).toEqual(["vol-1"]);
    expect((await dispatch()).cleanup.volumeDeleted).toBe(true);
    expect(await cleanupStopped(w.cleanup(), await dispatch())).toBe("done");
  });

  it("keeps three superseded snapshots and deletes the fourth", async () => {
    const w = await world({ status: "stopped", volumeId: "vol-1" });
    await w.stores.computeUtilizations.put(makeComputeUtilization(w.f, { setupSeconds: 1 }));
    const older = (n: number) => ({
      snapshotId: `snap-old-${n}`,
      amiVersion: "1.0.0",
      lockfileHashes: {},
      fromRunId: w.f.scope.runId,
      takenAt: "2026-10-01T10:00:00.000Z",
    });
    await w.stores.warmCaches.put(
      makeWarmCache(w.f, { current: older(1), history: [older(2), older(3), older(4)] }),
    );
    const dispatch = () => w.stores.dispatches.get(w.f.scope) as Promise<Dispatch>;
    await cleanupStopped(w.cleanup(), await dispatch());
    w.compute.snapshots.set("snap-vol-1", "completed");
    await cleanupStopped(w.cleanup(), await dispatch());
    const cache = await w.stores.warmCaches.get(w.f.scope.projectId, "x86_64");
    expect(cache?.history.map((snapshot) => snapshot.snapshotId)).toEqual([
      "snap-old-1",
      "snap-old-2",
      "snap-old-3",
    ]);
    expect(w.compute.deletedSnapshots).toEqual(["snap-old-4"]);
  });

  it("deletes the volume without a snapshot when setup never passed", async () => {
    const w = await world({ status: "failed", volumeId: "vol-1" });
    const dispatch = (await w.stores.dispatches.get(w.f.scope)) as Dispatch;
    expect(await cleanupStopped(w.cleanup(), dispatch)).toBe("volume_deleted");
    expect(w.compute.snapshots.size).toBe(0);
    expect(await w.stores.warmCaches.get(w.f.scope.projectId, "x86_64")).toBeUndefined();
  });

  it("records a failure and tries again next tick when EC2 refuses", async () => {
    const w = await world({ status: "stopped", volumeId: "vol-1" });
    w.compute.deleteVolume = async () => {
      throw new Error("VolumeInUse");
    };
    const dispatch = (await w.stores.dispatches.get(w.f.scope)) as Dispatch;
    expect(await cleanupStopped(w.cleanup(), dispatch)).toBe("waiting");
    expect((await w.stores.dispatches.get(w.f.scope))?.cleanup.failures[0]).toContain(
      "VolumeInUse",
    );
  });
});

describe("recovery of a lapsed lease (T6, D-P10-18, D-P10-05)", () => {
  const lapsed = new Date(NOW - 1_000).toISOString();
  const live = new Date(NOW + 30_000).toISOString();

  it("leaves a live lease alone", async () => {
    const w = await world({
      status: "running",
      instanceId: "i-old",
      volumeId: "vol-run",
      availabilityZone: "us-west-2b",
      leaseExpiresAt: live,
    });
    expect(
      await recoverLostLease(w.recover(), (await w.stores.dispatches.get(w.f.scope)) as Dispatch),
    ).toBe("alive");
    expect(w.compute.terminated).toEqual([]);
  });

  it("terminates the quiet machine, moves the generation, and provisions a replacement in the volume's zone with the volume attached", async () => {
    const w = await world({
      status: "running",
      instanceId: "i-old",
      volumeId: "vol-run",
      availabilityZone: "us-west-2b",
      leaseExpiresAt: lapsed,
      generation: 1,
      attempts: [
        {
          generation: 1,
          reason: "dispatch",
          startedAt: "2026-10-01T11:00:00.000Z",
          instanceId: "i-old",
        },
      ],
    });
    w.compute.instances.set("i-old", {
      instanceId: "i-old",
      state: "running",
      availabilityZone: "us-west-2b",
      workspaceVolumeId: "vol-run",
    });
    const dispatch = () => w.stores.dispatches.get(w.f.scope) as Promise<Dispatch>;
    expect(await recoverLostLease(w.recover(), await dispatch())).toBe("replacing");
    expect(w.compute.terminated).toEqual(["i-old"]);
    const replacing = await dispatch();
    expect(replacing).toMatchObject({ status: "provisioning", generation: 2, volumeId: "vol-run" });
    expect(replacing.instanceId).toBeUndefined();
    expect(replacing.attempts).toHaveLength(2);
    expect(replacing.attempts[0]?.endedAt).toBeDefined();
    expect(replacing.attempts[1]).toMatchObject({ generation: 2, reason: "lease_lost" });

    // The old machine still holds the volume for a moment; the attach is retried.
    w.compute.attachRefusals = 2;
    const outcome = await provisionDispatch(w.deps(), w.f.scope);
    expect(outcome.kind).toBe("provisioned");
    const launch = w.compute.launches[0];
    expect(launch?.subnetId).toBe("subnet-b");
    expect(launch?.volume).toBeUndefined();
    expect(w.compute.attached).toEqual([
      { volumeId: "vol-run", instanceId: "i-1", device: "/dev/xvdf" },
    ]);
    const provisioned = await dispatch();
    expect(provisioned).toMatchObject({
      status: "provisioning",
      instanceId: "i-1",
      volumeId: "vol-run",
      generation: 2,
    });
    // The first token waits under the new generation.
    expect([...w.tokens.parameters.keys()]).toEqual([
      `/nightshift/dev/dispatch/${w.f.scope.runId}/2`,
    ]);
  });

  it("fails the dispatch as recovery_exhausted when no attempt remains", async () => {
    const w = await world({
      status: "running",
      instanceId: "i-3",
      volumeId: "vol-run",
      leaseExpiresAt: lapsed,
      generation: 3,
      attempts: [
        {
          generation: 1,
          reason: "dispatch",
          startedAt: "2026-10-01T10:00:00.000Z",
          endedAt: "2026-10-01T10:30:00.000Z",
        },
        {
          generation: 2,
          reason: "lease_lost",
          startedAt: "2026-10-01T10:30:00.000Z",
          endedAt: "2026-10-01T11:00:00.000Z",
        },
        { generation: 3, reason: "lease_lost", startedAt: "2026-10-01T11:00:00.000Z" },
      ],
    });
    const dispatch = () => w.stores.dispatches.get(w.f.scope) as Promise<Dispatch>;
    expect(await recoverLostLease(w.recover(), await dispatch())).toBe("exhausted");
    expect(w.compute.terminated).toEqual(["i-3"]);
    expect(await dispatch()).toMatchObject({
      status: "failed",
      failure: { code: "recovery_exhausted" },
    });
  });

  it("gives up a replacement whose volume never attaches, and terminates the machine it made", async () => {
    const w = await world({
      status: "provisioning",
      volumeId: "vol-run",
      availabilityZone: "us-west-2a",
      generation: 2,
      attempts: [
        {
          generation: 1,
          reason: "dispatch",
          startedAt: "2026-10-01T10:00:00.000Z",
          endedAt: "2026-10-01T11:00:00.000Z",
        },
        { generation: 2, reason: "lease_lost", startedAt: "2026-10-01T11:00:00.000Z" },
      ],
    });
    w.compute.attachRefusals = 1000;
    const outcome = await provisionDispatch(w.deps(), w.f.scope);
    expect(outcome.kind).toBe("failed");
    expect(w.compute.terminated).toEqual(["i-1"]);
    expect((await w.stores.dispatches.get(w.f.scope))?.failure?.code).toBe("provisioning_failed");
  });
});
