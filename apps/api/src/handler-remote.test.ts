/**
 * The remote runner's routes (P10, T1): a run's dispatch, its heartbeat, its
 * publication intents, the compute records, an org's credentials and its
 * GitHub installation, all through the real handler over the memory stores.
 */
import { generateKeyPairSync, sign as signWith } from "node:crypto";
import type { Dispatch, OrgId, ProgramContract } from "@nightshift/contracts";
import {
  COMPUTE_TIERS,
  DEFAULT_COMPUTE_CEILINGS,
  DEFAULT_EXAMINATION_POLICY,
  DEFAULT_ROUTING_POLICY,
} from "@nightshift/contracts";
import type { GitHubAppClient } from "@nightshift/core";
import {
  createFixedClock,
  createFixtures,
  type Fixtures,
  LEASE_SECONDS,
  makeComputeUtilization,
  makeMembership,
  makeProgramContract,
  makeProject,
  makeRootNode,
  makeRun,
  makeWarmCache,
  nextUserId,
} from "@nightshift/core";
import { createInMemoryStores, type InMemoryStores } from "@nightshift/persistence/memory";
import { describe, expect, it, vi } from "vitest";
import type { RequestPrincipal } from "./auth/principal.js";
import { createLocalEnvelope, generateMasterKey } from "./envelope.js";
import { handleRequest } from "./handler.js";
import type { ApiDeps, ApiResponse } from "./http.js";
import { verifyExecutionToken } from "./tokens/verify.js";

const NOW = "2026-10-01T12:00:00.000Z";
const SHA = "a".repeat(40);
const SHA_B = "b".repeat(40);
const PLAN_HASH = "0".repeat(64);

const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const ISSUER = "https://api.test.nightshift.invalid";

const github: GitHubAppClient = {
  app: async () => ({
    slug: "nightshift-publisher",
    installUrl: "https://github.com/apps/nightshift-publisher/installations/new",
  }),
  installation: async (id) =>
    id === 166952409
      ? { account: "wildorder", repositories: ["wildorder/nightshift", "wildorder/fixture"] }
      : undefined,
};

interface World {
  readonly stores: InMemoryStores;
  readonly deps: ApiDeps;
  readonly f: Fixtures;
  readonly orgId: OrgId;
  readonly principal: RequestPrincipal;
  readonly paths: { readonly project: string; readonly program: string; readonly run: string };
}

/** A world with every optional dependency wired; `omitting` takes one away. */
const setup = async (): Promise<World> => {
  const stores = createInMemoryStores();
  const f = createFixtures();
  const subject = nextUserId(f);
  const orgId = f.ids.next("org");
  await stores.memberships.put(makeMembership(subject, orgId));
  const project = `/projects/${f.scope.projectId}`;
  const program = `${project}/programs/${f.scope.programId}`;
  const run = `${program}/runs/${f.scope.runId}`;
  return {
    stores,
    f,
    orgId,
    principal: { kind: "user", userId: subject },
    paths: { project, program, run },
    deps: {
      stores,
      clock: createFixedClock(Date.parse(NOW)),
      envelope: createLocalEnvelope(generateMasterKey()),
      github,
      tokens: {
        issuer: ISSUER,
        signer: { sign: async (input) => signWith("sha256", input, keys.privateKey) },
      },
    },
  };
};

const omitting = (w: World, ...names: readonly ("envelope" | "github")[]): World => {
  const deps: Record<string, unknown> = { ...w.deps };
  for (const name of names) delete deps[name];
  return { ...w, deps: deps as unknown as ApiDeps };
};

const call = (
  w: World,
  method: string,
  path: string,
  body?: unknown,
  principal: RequestPrincipal = w.principal,
): Promise<ApiResponse> => handleRequest(w.deps, { method, path, query: {}, body, principal });

const code = (response: ApiResponse): string =>
  (response.body as { error: { code: string } }).error.code;

/** A ratified planned program, a pending remote run and its root. */
const ratified = (f: Fixtures, overrides: Record<string, unknown> = {}): ProgramContract =>
  makeProgramContract(f, {
    status: "ratified",
    planHash: PLAN_HASH,
    planDocument: { uri: "s3://plans/fixture.md", sha256: PLAN_HASH, sizeBytes: 12 },
    strands: [
      {
        id: "S-01",
        name: "The strand",
        scope: { summary: "The source", includes: ["src/**"], excludes: [] },
        acceptance: ["it works"],
        successCriteria: ["SC-01"],
        dependsOn: [],
        prerequisites: [],
      },
    ],
    ...overrides,
  });

const seed = async (w: World, program: ProgramContract = ratified(w.f)) => {
  await w.stores.projects.put(makeProject(w.f, { orgId: w.orgId }));
  await w.stores.programContracts.put(program);
  await w.stores.runs.put(makeRun(w.f, { status: "pending", location: "remote" }));
  await w.stores.executionNodes.put(makeRootNode(w.f, { status: "validated" }));
};

const dispatchBody = (tier = "good", key = "key-1") => ({
  tier,
  idempotencyKey: key,
  input: {
    repositoryUrl: "https://github.com/wildorder/fixture",
    branch: "program/fixture",
    baseSha: SHA,
    planHash: PLAN_HASH,
  },
});

const dispatched = async (w: World, tier = "good"): Promise<Dispatch> => {
  await seed(w);
  const response = await call(w, "POST", `${w.paths.run}/dispatch`, dispatchBody(tier));
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body as Dispatch;
};

/** The runner, having been launched: the record as the dispatch Lambda leaves it (T3). */
const provisioned = async (w: World, dispatch: Dispatch): Promise<Dispatch> => {
  const next: Dispatch = {
    ...dispatch,
    status: "provisioning",
    instanceId: "i-1",
    volumeId: "vol-1",
    availabilityZone: "us-west-2a",
  };
  await w.stores.dispatches.put(next);
  return next;
};

const engine = (
  w: World,
  dispatch: Dispatch,
  generation = dispatch.generation,
): RequestPrincipal => ({
  kind: "execution",
  ...w.f.scope,
  nodeId: w.f.rootNodeId,
  agentId: dispatch.engineAgentId,
  role: "engine",
  generation,
});

const heartbeatBody = (generation: number, extra: Record<string, unknown> = {}) => ({
  generation,
  meteredSeconds: 60,
  samples: [{ memoryPct: 20, cpuPct: 30, diskPct: 10, swapUsed: false, oomKills: 0 }],
  ...extra,
});

describe("dispatching a run (D-P10-18, D-P10-19, SC-P10-02, SC-P10-03)", () => {
  it("records a requested dispatch with the tier's class and price, and the org's live run", async () => {
    const w = await setup();
    const dispatch = await dispatched(w, "better");
    expect(dispatch).toMatchObject({
      status: "requested",
      tier: "better",
      instanceType: COMPUTE_TIERS.better.instanceType,
      usdPerHour: COMPUTE_TIERS.better.usdPerHour,
      generation: 1,
      attempts: [{ generation: 1, reason: "dispatch" }],
    });
    expect(dispatch.spend.estimatedUsd).toBeGreaterThan(0);
    expect(dispatch.engineAgentId).toMatch(/^agent_/);
    const usage = await w.stores.computeLedger.get(w.orgId, "2026-10");
    expect(usage?.liveRuns).toEqual([w.f.scope.runId]);
    expect((await call(w, "GET", `${w.paths.run}/dispatch`)).body).toEqual(dispatch);
  });

  it("is idempotent under its key, and refuses a second dispatch under another", async () => {
    const w = await setup();
    const first = await dispatched(w);
    const again = await call(w, "POST", `${w.paths.run}/dispatch`, dispatchBody("good", "key-1"));
    expect(again.status).toBe(200);
    expect(again.body).toEqual(first);
    const other = await call(w, "POST", `${w.paths.run}/dispatch`, dispatchBody("good", "key-2"));
    expect(other.status).toBe(409);
  });

  it("refuses a local run, a run already started, an unratified plan and a changed plan", async () => {
    const w = await setup();
    await seed(w);
    await w.stores.runs.put(makeRun(w.f, { status: "pending", location: "local" }));
    expect(code(await call(w, "POST", `${w.paths.run}/dispatch`, dispatchBody()))).toBe(
      "run_not_remote",
    );
    await w.stores.runs.put(makeRun(w.f, { status: "running", location: "remote" }));
    expect(code(await call(w, "POST", `${w.paths.run}/dispatch`, dispatchBody()))).toBe(
      "run_not_pending",
    );
    await w.stores.runs.put(makeRun(w.f, { status: "pending", location: "remote" }));
    await w.stores.programContracts.put(makeProgramContract(w.f));
    expect(code(await call(w, "POST", `${w.paths.run}/dispatch`, dispatchBody()))).toBe(
      "plan_not_ratified",
    );
    await w.stores.programContracts.put(ratified(w.f, { planHash: "1".repeat(64) }));
    expect(code(await call(w, "POST", `${w.paths.run}/dispatch`, dispatchBody()))).toBe(
      "plan_changed",
    );
  });

  it("refuses a tier over the org's ceiling, and a month over its cap", async () => {
    const w = await setup();
    await seed(w);
    await w.stores.orgConfigs.put({
      schemaVersion: 1,
      orgId: w.orgId,
      routingPolicy: DEFAULT_ROUTING_POLICY,
      examinationPolicy: DEFAULT_EXAMINATION_POLICY,
      compute: { ...DEFAULT_COMPUTE_CEILINGS, maxTier: "better", maxUsdPerMonth: 10 },
      version: 1,
      updatedAt: NOW,
    });
    expect(code(await call(w, "POST", `${w.paths.run}/dispatch`, dispatchBody("best")))).toBe(
      "tier_over_ceiling",
    );
    await w.stores.computeLedger.put({
      schemaVersion: 1,
      orgId: w.orgId,
      month: "2026-10",
      meteredUsd: 9.5,
      liveRuns: [],
      updatedAt: NOW,
    });
    expect(code(await call(w, "POST", `${w.paths.run}/dispatch`, dispatchBody("better")))).toBe(
      "month_over_cap",
    );
  });

  it("refuses an execution token the operation outright, whatever its role", async () => {
    const w = await setup();
    const dispatch = await dispatched(w);
    const response = await call(
      w,
      "POST",
      `${w.paths.run}/dispatch/cancel`,
      undefined,
      engine(w, dispatch),
    );
    expect(response.status).toBe(403);
  });
});

describe("the heartbeat (D-P10-18, D-P10-20, D-P10-23)", () => {
  it("extends the lease, moves the dispatch as the runner reports, folds the use, renews the token", async () => {
    const w = await setup();
    const dispatch = await provisioned(w, await dispatched(w));
    const ready = await call(
      w,
      "POST",
      `${w.paths.run}/dispatch/heartbeat`,
      heartbeatBody(1, { report: "ready", setupSeconds: 12 }),
      engine(w, dispatch),
    );
    expect(ready.status, JSON.stringify(ready.body)).toBe(200);
    expect(ready.body).toMatchObject({ generation: 1, status: "ready", stop: false });
    const lease = (ready.body as { leaseExpiresAt: string }).leaseExpiresAt;
    expect(Date.parse(lease) - Date.parse(NOW)).toBe(LEASE_SECONDS * 1000);
    const token = (ready.body as { token?: string }).token;
    expect(token).toBeDefined();
    const verified = verifyExecutionToken(token as string, {
      publicKey: keys.publicKey,
      issuer: ISSUER,
      now: Date.parse(NOW),
    });
    expect(verified.ok && verified.principal.role).toBe("engine");
    expect(verified.ok && verified.principal.generation).toBe(1);

    const running = await call(
      w,
      "POST",
      `${w.paths.run}/dispatch/heartbeat`,
      heartbeatBody(1, { report: "running", meteredSeconds: 120 }),
      engine(w, dispatch),
    );
    expect(running.body).toMatchObject({ status: "running", stop: false });
    const stored = await w.stores.dispatches.get(w.f.scope);
    expect(stored?.spend.meteredSeconds).toBe(120);
    expect(stored?.spend.meteredUsd).toBeGreaterThan(0);
    const utilization = await w.stores.computeUtilizations.get(w.f.scope);
    expect(utilization).toMatchObject({ samples: 2, setupSeconds: 12, wallClockSeconds: 120 });
    expect((await w.stores.computeLedger.get(w.orgId, "2026-10"))?.meteredUsd).toBeCloseTo(
      stored?.spend.meteredUsd ?? -1,
      10,
    );
  });

  it("carries the org's keys to a running engine, opened, and to nothing else", async () => {
    const w = await setup();
    await call(w, "PUT", `/orgs/${w.orgId}/credentials/anthropic`, {
      key: "sk-ant-secret-key-1234",
    });
    const dispatch = await provisioned(w, await dispatched(w));
    const before = await call(
      w,
      "POST",
      `${w.paths.run}/dispatch/heartbeat`,
      heartbeatBody(1, { report: "ready" }),
      engine(w, dispatch),
    );
    expect((before.body as { credentials?: unknown }).credentials).toBeUndefined();
    const running = await call(
      w,
      "POST",
      `${w.paths.run}/dispatch/heartbeat`,
      heartbeatBody(1, { report: "running" }),
      engine(w, dispatch),
    );
    expect((running.body as { credentials?: unknown }).credentials).toEqual({
      anthropic: "sk-ant-secret-key-1234",
    });
    // No read route answers more than presence, date and last four.
    const listed = await call(w, "GET", `/orgs/${w.orgId}/credentials`);
    expect(JSON.stringify(listed.body)).not.toContain("secret");
    expect(listed.body).toEqual({
      items: [{ provider: "anthropic", lastFour: "1234", setAt: NOW }],
    });
  });

  it("refuses a stale generation at the gate, and a human's stale heartbeat in the body", async () => {
    const w = await setup();
    const dispatch = await provisioned(w, await dispatched(w));
    await w.stores.dispatches.put({ ...dispatch, generation: 2 });
    const stale = await call(
      w,
      "POST",
      `${w.paths.run}/dispatch/heartbeat`,
      heartbeatBody(1),
      engine(w, dispatch, 1),
    );
    expect(stale.status).toBe(403);
    expect(code(stale)).toBe("stale_generation");
    const human = await call(w, "POST", `${w.paths.run}/dispatch/heartbeat`, heartbeatBody(1));
    expect(human.status).toBe(409);
    expect(code(human)).toBe("stale_generation");
  });

  it("fences every engine write, and lets a superseded engine read", async () => {
    const w = await setup();
    const dispatch = await provisioned(w, await dispatched(w));
    await w.stores.dispatches.put({ ...dispatch, generation: 2 });
    const root = await w.stores.executionNodes.get(w.f.scope, w.f.rootNodeId);
    const write = await call(
      w,
      "PUT",
      `${w.paths.run}/nodes/${w.f.rootNodeId}`,
      { ...root, status: "running" },
      engine(w, dispatch, 1),
    );
    expect(write.status).toBe(403);
    expect(code(write)).toBe("stale_generation");
    const read = await call(w, "GET", `${w.paths.run}/dispatch`, undefined, engine(w, dispatch, 1));
    expect(read.status).toBe(200);
    const current = await call(
      w,
      "PUT",
      `${w.paths.run}/nodes/${w.f.rootNodeId}`,
      { ...root, status: "running" },
      engine(w, dispatch, 2),
    );
    // Past the gate: whatever the transition table then says, the fence let it through.
    expect(current.status, JSON.stringify(current.body)).not.toBe(403);
  });

  it("stops the machine at the per-run cap and tells the runner so", async () => {
    const w = await setup();
    const dispatch = await provisioned(w, await dispatched(w, "best"));
    const seconds =
      Math.ceil((DEFAULT_COMPUTE_CEILINGS.maxUsdPerRun / COMPUTE_TIERS.best.usdPerHour) * 3600) +
      60;
    const response = await call(
      w,
      "POST",
      `${w.paths.run}/dispatch/heartbeat`,
      heartbeatBody(1, { report: "ready", meteredSeconds: seconds }),
      engine(w, dispatch),
    );
    expect(response.body).toMatchObject({ status: "stopping", stop: true });
    expect((response.body as { token?: string }).token).toBeUndefined();
    expect((await w.stores.dispatches.get(w.f.scope))?.failure?.code).toBe("run_cap");
  });

  it("has nothing to heartbeat before a machine exists", async () => {
    const w = await setup();
    const dispatch = await dispatched(w);
    const response = await call(
      w,
      "POST",
      `${w.paths.run}/dispatch/heartbeat`,
      heartbeatBody(1),
      engine(w, dispatch),
    );
    expect(code(response)).toBe("no_machine");
  });
});

describe("cancel and resume", () => {
  it("stops a dispatch with no machine outright, and marks one with a machine stopping", async () => {
    const w = await setup();
    const requested = await dispatched(w);
    const cancelled = await call(w, "POST", `${w.paths.run}/dispatch/cancel`);
    expect(cancelled.body).toMatchObject({ status: "stopped", failure: { code: "cancelled" } });
    expect((await w.stores.computeLedger.get(w.orgId, "2026-10"))?.liveRuns).toEqual([]);

    await w.stores.dispatches.put({ ...requested, status: "running", instanceId: "i-1" });
    const stopping = await call(w, "POST", `${w.paths.run}/dispatch/cancel`);
    expect(stopping.body).toMatchObject({ status: "stopping" });
    const stopped = await call(
      w,
      "POST",
      `${w.paths.run}/dispatch/heartbeat`,
      heartbeatBody(1, { report: "stopped" }),
      engine(w, requested),
    );
    expect(stopped.body).toMatchObject({ status: "stopped", stop: true });
  });

  it("resumes a settled dispatch from its snapshot, within retention, and refuses otherwise", async () => {
    const w = await setup();
    const dispatch = await dispatched(w);
    const settled: Dispatch = {
      ...dispatch,
      status: "stopped",
      cleanup: { snapshotId: "snap-1", snapshotTakenAt: NOW, volumeDeleted: true, failures: [] },
    };
    await w.stores.dispatches.put(settled);
    const resumed = await call(w, "POST", `${w.paths.run}/dispatch/resume`);
    expect(resumed.status, JSON.stringify(resumed.body)).toBe(200);
    expect(resumed.body).toMatchObject({ status: "provisioning", generation: 2 });
    expect((resumed.body as Dispatch).attempts.at(-1)).toMatchObject({ reason: "resume" });

    await w.stores.dispatches.put({ ...settled, cleanup: { volumeDeleted: true, failures: [] } });
    const refused = await call(w, "POST", `${w.paths.run}/dispatch/resume`);
    expect(code(refused)).toBe("cannot_resume");
  });
});

describe("publication intents (D-P10-22)", () => {
  it("records one pending intent per head for a live machine, and lists them", async () => {
    const w = await setup();
    const dispatch = await provisioned(w, await dispatched(w));
    const early = await call(
      w,
      "POST",
      `${w.paths.run}/publication`,
      { head: SHA_B, expectedPredecessor: SHA, bundleKey: "bundles/b.bundle" },
      engine(w, dispatch),
    );
    expect(code(early)).toBe("dispatch_not_live");
    await w.stores.dispatches.put({ ...dispatch, status: "running" });
    const created = await call(
      w,
      "POST",
      `${w.paths.run}/publication`,
      { head: SHA_B, expectedPredecessor: SHA, bundleKey: "bundles/b.bundle" },
      engine(w, dispatch),
    );
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ head: SHA_B, status: "pending" });
    const again = await call(
      w,
      "POST",
      `${w.paths.run}/publication`,
      { head: SHA_B, expectedPredecessor: SHA, bundleKey: "bundles/b.bundle" },
      engine(w, dispatch),
    );
    expect(again.status).toBe(200);
    const listed = await call(w, "GET", `${w.paths.run}/publication`);
    expect((listed.body as { intents: unknown[] }).intents).toHaveLength(1);
  });
});

describe("compute records (D-P10-14, D-P10-15)", () => {
  it("answers a run's utilization, a project's warm cache, and 404 for neither", async () => {
    const w = await setup();
    await seed(w);
    expect((await call(w, "GET", `${w.paths.run}/compute`)).status).toBe(404);
    expect((await call(w, "GET", `${w.paths.project}/warm-cache`)).status).toBe(404);
    await w.stores.computeUtilizations.put(makeComputeUtilization(w.f));
    await w.stores.warmCaches.put(makeWarmCache(w.f));
    expect((await call(w, "GET", `${w.paths.run}/compute`)).status).toBe(200);
    expect((await call(w, "GET", `${w.paths.project}/warm-cache`)).body).toMatchObject({
      architecture: "arm64",
    });
  });

  it("recommends from the project's last three runs on the program's tier", async () => {
    const w = await setup();
    await seed(w, ratified(w.f, { compute: { tier: "better" } }));
    const insufficient = await call(w, "GET", `${w.paths.program}/compute/recommendation`);
    expect(insufficient.body).toMatchObject({ current: "better", kind: "insufficient", have: 0 });
    for (let index = 0; index < 3; index += 1) {
      await w.stores.computeUtilizations.put(
        makeComputeUtilization(w.f, { runId: w.f.ids.next("run"), tier: "better" }),
      );
    }
    const recommendation = await call(w, "GET", `${w.paths.program}/compute/recommendation`);
    expect(recommendation.body).toMatchObject({
      current: "better",
      kind: "recommendation",
      direction: "down",
      tier: "good",
    });
  });
});

describe("an org's credentials (D-P10-23)", () => {
  it("seals a key under the org, answers a view, and lists views only", async () => {
    const w = await setup();
    const set = await call(w, "PUT", `/orgs/${w.orgId}/credentials/openai`, {
      key: "sk-proj-secret-9876",
    });
    expect(set.status).toBe(200);
    expect(set.body).toEqual({ provider: "openai", lastFour: "9876", setAt: NOW });
    const stored = await w.stores.credentials.sealed(w.orgId, "openai");
    expect(stored?.ciphertext).toBeDefined();
    expect(JSON.stringify(stored)).not.toContain("secret");
    expect((await call(w, "GET", `/orgs/${w.orgId}/credentials`)).body).toEqual({
      items: [{ provider: "openai", lastFour: "9876", setAt: NOW }],
    });
  });

  it("refuses an unknown provider, a short key, and another org", async () => {
    const w = await setup();
    expect(
      (await call(w, "PUT", `/orgs/${w.orgId}/credentials/google`, { key: "x".repeat(20) })).status,
    ).toBe(400);
    expect(
      (await call(w, "PUT", `/orgs/${w.orgId}/credentials/openai`, { key: "short" })).status,
    ).toBe(400);
    const other = w.f.ids.next("org");
    expect(
      (await call(w, "PUT", `/orgs/${other}/credentials/openai`, { key: "x".repeat(20) })).status,
    ).toBe(403);
  });

  it("says so plainly when the plane has no key to seal under", async () => {
    const w = omitting(await setup(), "envelope");
    const response = await call(w, "PUT", `/orgs/${w.orgId}/credentials/openai`, {
      key: "sk-proj-secret-9876",
    });
    expect(response.status).toBe(501);
    expect(await w.stores.credentials.view(w.orgId)).toEqual([]);
  });

  it("never writes the key into a diagnostic, even when the route fails unexpectedly", async () => {
    const w = await setup();
    const failing = {
      ...w.stores,
      credentials: {
        ...w.stores.credentials,
        put: async () => {
          throw new Error("the table is on fire");
        },
      },
    };
    const lines: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      lines.push(args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(" "));
    });
    const response = await handleRequest(
      { ...w.deps, stores: failing },
      {
        method: "PUT",
        path: `/orgs/${w.orgId}/credentials/openai`,
        query: {},
        body: { key: "sk-proj-very-secret-9876" },
        principal: w.principal,
      },
    );
    spy.mockRestore();
    expect(response.status).toBe(500);
    expect(lines.join("\n")).toContain("[body masked]");
    expect(lines.join("\n")).not.toContain("very-secret");
  });
});

describe("an org's GitHub installation (D-P10-02)", () => {
  it("tells a customer where to install, records what GitHub says, and reads it back", async () => {
    const w = await setup();
    expect((await call(w, "GET", "/github/app")).body).toMatchObject({
      slug: "nightshift-publisher",
    });
    expect((await call(w, "GET", `/orgs/${w.orgId}/github`)).status).toBe(404);
    const recorded = await call(w, "PUT", `/orgs/${w.orgId}/github`, { installationId: 166952409 });
    expect(recorded.status).toBe(200);
    expect(recorded.body).toMatchObject({
      installationId: 166952409,
      account: "wildorder",
      repositories: ["wildorder/nightshift", "wildorder/fixture"],
    });
    expect((await call(w, "GET", `/orgs/${w.orgId}/github`)).body).toEqual(recorded.body);
    expect((await w.stores.orgConfigs.get(w.orgId))?.version).toBe(1);
  });

  it("refuses an installation GitHub does not know, and 501s without the App", async () => {
    const w = await setup();
    expect((await call(w, "PUT", `/orgs/${w.orgId}/github`, { installationId: 42 })).status).toBe(
      404,
    );
    const without = omitting(await setup(), "github");
    expect((await call(without, "GET", "/github/app")).status).toBe(501);
  });

  it("survives a policy write, which carries the ceilings and keeps the installation", async () => {
    const w = await setup();
    await call(w, "PUT", `/orgs/${w.orgId}/github`, { installationId: 166952409 });
    const written = await call(w, "PUT", `/orgs/${w.orgId}/config`, {
      routingPolicy: DEFAULT_ROUTING_POLICY,
      examinationPolicy: DEFAULT_EXAMINATION_POLICY,
      compute: { ...DEFAULT_COMPUTE_CEILINGS, maxTier: "good" },
      replacesVersion: 1,
    });
    expect(written.status, JSON.stringify(written.body)).toBe(200);
    expect(written.body).toMatchObject({
      version: 2,
      compute: { maxTier: "good" },
      github: { installationId: 166952409 },
    });
  });
});
