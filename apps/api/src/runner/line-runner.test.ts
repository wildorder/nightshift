/**
 * The reconciler's line work over fakes (Pipkin M1b): a line with queued work
 * and no live run gets a run of its line program, and the publisher is asked
 * about what a run or a line still owes.
 */
import { generateKeyPairSync, sign as signWith } from "node:crypto";
import type { OrgId, ProjectId } from "@nightshift/contracts";
import {
  DEFAULT_COMPUTE_CEILINGS,
  DEFAULT_EXAMINATION_POLICY,
  DEFAULT_ROUTING_POLICY,
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
  lineProgramId,
  makeDispatch,
  makeLineRecord,
  makeProgramContract,
  makeProject,
  makeRun,
} from "@nightshift/core";
import { createInMemoryStores, type InMemoryStores } from "@nightshift/persistence/memory";
import { describe, expect, it } from "vitest";
import type { ProvisionDeps } from "./provision.js";
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
  /** The runs the line's plane was asked to provision. */
  readonly provisioned: string[];
  deps(): ProvisionDeps;
  reconcile(): Promise<Record<string, number>>;
  /** Another project of the same org with a line carrying queued work. */
  addLine(options?: { work?: boolean }): Promise<Fixtures>;
}

const world = async (ceiling?: number): Promise<World> => {
  const stores = createInMemoryStores();
  const compute = fakeCompute();
  const tokens = fakeTokens();
  const clock = { at: START, now: () => clock.at };
  const orgId = createFixtures().ids.next("org") as OrgId;
  const asked: PublisherRequest[] = [];
  const provisioned: string[] = [];
  const lineFixtures: Fixtures[] = [];
  await stores.orgConfigs.put({
    schemaVersion: 1,
    orgId,
    routingPolicy: DEFAULT_ROUTING_POLICY,
    examinationPolicy: DEFAULT_EXAMINATION_POLICY,
    installations: [
      {
        installationId: 1,
        account: "wildorder",
        repositories: ["wildorder/fixture"],
        recordedAt: new Date(START).toISOString(),
      },
    ],
    ...(ceiling === undefined
      ? {}
      : { compute: { ...DEFAULT_COMPUTE_CEILINGS, maxConcurrentRuns: ceiling } }),
    version: 1,
    updatedAt: new Date(START).toISOString(),
  });
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
    provisioned,
    reconcile: () =>
      reconcile({
        provision: deps(),
        plane: {
          stores,
          clock,
          ids,
          github: {
            branchHead: async () => FIXTURE_COMMIT,
          } as never,
          dispatcher: {
            provision: async (scope: { runId: string }) => void provisioned.push(scope.runId),
          } as never,
        },
        askPublisher: async (r) => void asked.push(r),
      }),
    addLine: async ({ work = true } = {}) => {
      const f = createFixtures();
      lineFixtures.push(f);
      await stores.projects.put(makeProject(f, { orgId }));
      await stores.programContracts.put(
        makeProgramContract(f, {
          repository: {
            url: "https://github.com/wildorder/fixture",
            baseBranch: "main",
            programBranch: "program/fixture",
          },
          line: { branch: BRANCH },
        }),
      );
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
      return f;
    },
  };
};

describe("reconcile: lines with work and the publisher", () => {
  const lineRunsOf = async (w: World, f: Fixtures) =>
    (
      await w.stores.runs.listByProgram({
        projectId: f.scope.projectId,
        programId: lineProgramId(f.scope.projectId, BRANCH),
      })
    ).items;

  it("gives a line with queued entries and no live run a run of its line program", async () => {
    const w = await world();
    const f = await w.addLine();
    expect(await lineRunsOf(w, f)).toHaveLength(0);
    const counts = await w.reconcile();
    expect(counts["line-admit:started"]).toBe(1);
    const runs = await lineRunsOf(w, f);
    expect(runs).toHaveLength(1);
    expect(w.provisioned).toEqual([runs[0]?.runId]);
    const dispatch = await w.stores.dispatches.get({
      projectId: f.scope.projectId,
      programId: lineProgramId(f.scope.projectId, BRANCH),
      runId: runs[0]?.runId as never,
    });
    expect(dispatch).toMatchObject({ generation: 1, status: "requested" });
    // The next pass finds it live and starts nothing more.
    const again = await w.reconcile();
    expect(again["line-admit:live"]).toBe(1);
    expect(await lineRunsOf(w, f)).toHaveLength(1);
    expect(w.provisioned).toHaveLength(1);
  });

  it("does not start a run for a line whose queue is empty", async () => {
    const w = await world();
    const f = await w.addLine({ work: false });
    await w.reconcile();
    expect(await lineRunsOf(w, f)).toHaveLength(0);
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
    const f = await w.addLine({ work: false });
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

describe("reconcile: sweeping machines no live dispatch owns (2026-11-05)", () => {
  it("terminates a machine whose run is over, unknown, or moved to another machine, and spares the rest", async () => {
    const w = await world();
    const f = createFixtures();
    await w.stores.projects.put(makeProject(f, { orgId: w.orgId }));
    const liveProgram = f.ids.next("prog");
    const tagsOf = (runId: string, stage = "dev", programId: string = f.scope.programId) => ({
      "nightshift:managed": "true",
      "nightshift-stage": stage,
      "nightshift-project": f.scope.projectId,
      "nightshift-program": programId,
      "nightshift-run": runId,
    });
    // A run whose dispatch has stopped, and one whose dispatch is live on i-live.
    const stopped = f.scope.runId;
    await w.stores.runs.put(makeRun(f, { status: "pending", location: "remote" }));
    await w.stores.dispatches.put(
      makeDispatch(f, { status: "stopped", cleanup: { volumeDeleted: true, failures: [] } }),
    );
    const liveRun = f.ids.next("run");
    await w.stores.runs.put(
      makeRun(f, { programId: liveProgram, runId: liveRun, status: "pending", location: "remote" }),
    );
    await w.stores.dispatches.put(
      makeDispatch(f, {
        programId: liveProgram,
        runId: liveRun,
        status: "running",
        instanceId: "i-live",
      }),
    );
    // A run that stopped a moment ago: its machine gets time to shut down by itself.
    const justProgram = f.ids.next("prog");
    const justRun = f.ids.next("run");
    await w.stores.runs.put(
      makeRun(f, { programId: justProgram, runId: justRun, status: "pending", location: "remote" }),
    );
    await w.stores.dispatches.put(
      makeDispatch(f, {
        programId: justProgram,
        runId: justRun,
        status: "stopped",
        cleanup: { volumeDeleted: true, failures: [] },
        updatedAt: new Date(START - 60_000).toISOString(),
      }),
    );
    const old = new Date(START - 60 * 60_000).toISOString();
    const fresh = new Date(START - 60_000).toISOString();
    w.compute.listManaged = async () => [
      {
        instanceId: "i-just-stopped",
        state: "running",
        launchedAt: old,
        tags: tagsOf(justRun, "dev", justProgram),
      },
      { instanceId: "i-stopped", state: "running", launchedAt: old, tags: tagsOf(stopped) },
      {
        instanceId: "i-unknown",
        state: "running",
        launchedAt: old,
        tags: tagsOf(f.ids.next("run")),
      },
      {
        instanceId: "i-replaced",
        state: "running",
        launchedAt: old,
        tags: tagsOf(liveRun, "dev", liveProgram),
      },
      {
        instanceId: "i-live",
        state: "running",
        launchedAt: old,
        tags: tagsOf(liveRun, "dev", liveProgram),
      },
      {
        instanceId: "i-launching",
        state: "pending",
        launchedAt: fresh,
        tags: tagsOf(f.ids.next("run")),
      },
      {
        instanceId: "i-other-stage",
        state: "running",
        launchedAt: old,
        tags: tagsOf(stopped, "prod"),
      },
    ];
    const counts = await w.reconcile();
    expect([...w.compute.terminated].sort()).toEqual(["i-replaced", "i-stopped", "i-unknown"]);
    expect(counts["sweep:terminated"]).toBe(3);
  });
});

describe("reconcile: a program run that follows its dispatch", () => {
  it("interrupts a pending program run whose machine ended before it started, with the machine's reason (2026-11-06)", async () => {
    const w = await world();
    const f = createFixtures();
    await w.stores.projects.put(makeProject(f, { orgId: w.orgId }));
    await w.stores.programContracts.put(makeProgramContract(f));
    await w.stores.runs.put(makeRun(f, { status: "pending", location: "remote" }));
    await w.stores.dispatches.put(
      makeDispatch(f, {
        status: "failed",
        cleanup: { volumeDeleted: true, failures: [] },
        failure: {
          code: "setup_failed",
          message: "the workspace could not be prepared: a branch is used by a worktree",
        },
      }),
    );
    const counts = await w.reconcile();
    expect(counts["run:never-started"]).toBe(1);
    const run = await w.stores.runs.get(f.scope, f.scope.runId);
    expect(run?.status).toBe("interrupted");
    expect(run?.outcomeReason).toContain(
      "The run never started: the workspace could not be prepared",
    );
    expect(run?.outcomeReason).toContain("nightshift run");
    const again = await w.reconcile();
    expect(again["run:never-started"]).toBeUndefined();
  });

  it("ends a cancelled run once its machine has stopped, and keeps a paused one", async () => {
    const w = await world();
    const f = createFixtures();
    await w.stores.projects.put(makeProject(f, { orgId: w.orgId }));
    await w.stores.programContracts.put(makeProgramContract(f));
    await w.stores.runs.put(makeRun(f, { status: "pending", location: "remote" }));
    const stopped = (code: "cancelled" | "paused", message: string) =>
      makeDispatch(f, {
        status: "stopped",
        cleanup: { volumeDeleted: true, failures: [] },
        failure: { code, message },
      });

    await w.stores.dispatches.put(stopped("paused", "paused by the operator"));
    await w.stores.runs.put(makeRun(f, { status: "running", location: "remote" }));
    expect((await w.reconcile())["run:cancelled"]).toBeUndefined();
    expect((await w.stores.runs.get(f.scope, f.scope.runId))?.status).toBe("running");

    await w.stores.dispatches.put(stopped("cancelled", "Cancelled by the operator."));
    expect((await w.reconcile())["run:cancelled"]).toBe(1);
    expect(await w.stores.runs.get(f.scope, f.scope.runId)).toMatchObject({
      status: "cancelled",
      outcomeReason: "Cancelled by the operator.",
    });
    expect((await w.reconcile())["run:cancelled"]).toBeUndefined();
  });
});
