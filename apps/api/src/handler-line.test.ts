/**
 * The project line's routes (Pipkin M1b, J3): authorization of the line owner
 * and of humans, the queue and its refusals, the push, the bundle upload URL,
 * the heartbeat's fence, metering, caps and parking, the idle-stop race, and the
 * concurrency accounting of line dispatches. Through the real handler over the
 * memory stores.
 */
import { generateKeyPairSync, sign as signWith } from "node:crypto";
import {
  DEFAULT_COMPUTE_CEILINGS,
  DEFAULT_EXAMINATION_POLICY,
  DEFAULT_ROUTING_POLICY,
  type LineDispatch,
  type LineRecord,
  type OrgId,
  type ProjectSelfStartedUsage,
} from "@nightshift/contracts";
import {
  beginReplacement,
  createFixedClock,
  createFixtures,
  dispatchChargeKey,
  type Fixtures,
  lineBundleObjectKey,
  makeLineDispatch,
  makeLineRecord,
  makeLineVerification,
  makeMembership,
  makeProgramContract,
  makeProject,
  nextUserId,
} from "@nightshift/core";
import { createInMemoryStores, type InMemoryStores } from "@nightshift/persistence/memory";
import { describe, expect, it } from "vitest";
import type { RequestPrincipal } from "./auth/principal.js";
import { handleRequest } from "./handler.js";
import type { ApiDeps, ApiResponse } from "./http.js";
import { verifyExecutionToken } from "./tokens/verify.js";

const NOW = "2026-10-01T12:00:00.000Z";
const SHA = "a".repeat(40);
const SHA_B = "b".repeat(40);
const BRANCH = "nightshift/develop";
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const ISSUER = "https://api.test.nightshift.invalid";

const provisioned: string[] = [];
const published: string[] = [];

interface World {
  readonly stores: InMemoryStores;
  readonly deps: ApiDeps;
  readonly f: Fixtures;
  readonly orgId: OrgId;
  readonly user: RequestPrincipal;
  readonly signed: string[];
}

const setup = async (): Promise<World> => {
  const stores = createInMemoryStores();
  const f = createFixtures();
  const subject = nextUserId(f);
  const orgId = f.ids.next("org");
  await stores.memberships.put(makeMembership(subject, orgId));
  await stores.projects.put(makeProject(f, { orgId }));
  const signed: string[] = [];
  provisioned.length = 0;
  published.length = 0;
  return {
    stores,
    f,
    orgId,
    signed,
    user: { kind: "user", userId: subject },
    deps: {
      stores,
      clock: createFixedClock(Date.parse(NOW)),
      dispatcher: {
        provision: async () => undefined,
        provisionLine: async ({ branch }) => void provisioned.push(branch),
        publishLine: async ({ branch }) => void published.push(branch),
      },
      uploads: {
        sign: async () => {
          throw new Error("not used");
        },
        signKey: async (key, contentType) => {
          signed.push(key);
          return {
            uri: `s3://bucket/${key}`,
            uploadUrl: `https://bucket.invalid/${key}?sig=1`,
            key,
            contentType,
            expiresAt: NOW,
          };
        },
      },
      tokens: {
        issuer: ISSUER,
        signer: { sign: async (input) => signWith("sha256", input, keys.privateKey) },
      },
    },
  };
};

const lineUrl = (w: World, branch = BRANCH, tail = "") =>
  `/projects/${w.f.scope.projectId}/line/${encodeURIComponent(branch)}${tail}`;

const call = (
  w: World,
  method: string,
  path: string,
  body?: unknown,
  principal: RequestPrincipal = w.user,
): Promise<ApiResponse> => handleRequest(w.deps, { method, path, query: {}, body, principal });

const linePrincipal = (
  _w: World,
  dispatch: LineDispatch,
  overrides: Partial<{ branch: string; generation: number; projectId: string }> = {},
): RequestPrincipal =>
  ({
    kind: "line",
    projectId: dispatch.projectId,
    branch: dispatch.branch,
    agentId: dispatch.engineAgentId,
    generation: dispatch.generation,
    ...overrides,
  }) as RequestPrincipal;

const code = (response: ApiResponse): string =>
  (response.body as { error: { code: string } }).error.code;

const beat = (generation: number, extra: Record<string, unknown> = {}) => ({
  generation,
  meteredSeconds: 60,
  samples: [],
  ...extra,
});

interface Seed {
  readonly queue?: LineRecord["queue"];
  readonly batch?: LineRecord["batch"];
  readonly dispatch?: Partial<LineDispatch>;
  readonly capUsd?: number;
}

/** A line with a running dispatch and a program feeding it. */
const seedLine = async (w: World, seed: Seed = {}) => {
  await w.stores.programContracts.put(
    makeProgramContract(w.f, {
      line: { branch: BRANCH, ...(seed.capUsd === undefined ? {} : { monthlyUsd: seed.capUsd }) },
    }),
  );
  await w.stores.lines.update(w.f.scope.projectId, BRANCH, () =>
    makeLineRecord(w.f, {
      queue: seed.queue ?? [],
      ...(seed.batch === undefined ? {} : { batch: seed.batch }),
    }),
  );
  const dispatch = makeLineDispatch(w.f, {
    status: "running",
    instanceId: "i-1",
    ...seed.dispatch,
  });
  expect(await w.stores.lineDispatches.start(dispatch)).toBe("started");
  return dispatch;
};

/** The line's stored dispatch; the test seeded one. */
const heldDispatch = async (w: World): Promise<LineDispatch> => {
  const held = await w.stores.lineDispatches.get(w.f.scope.projectId, BRANCH);
  if (held === undefined) throw new Error("no line dispatch stored");
  return held;
};

const entry = (w: World, upTo = SHA) => ({
  program: w.f.scope.programId,
  upTo,
  enqueuedAt: NOW,
});

describe("authorization of the line routes", () => {
  it("refuses a stale generation with 403, but serves the current one", async () => {
    const w = await setup();
    const dispatch = await seedLine(w, { dispatch: { generation: 1 } });
    const stale = linePrincipal(w, dispatch, { generation: 0 + 2 });
    const response = await call(w, "POST", lineUrl(w, BRANCH, "/batch"), { generation: 1 }, stale);
    expect(response.status).toBe(403);
    const current = await call(
      w,
      "POST",
      lineUrl(w, BRANCH, "/batch"),
      { generation: 1 },
      linePrincipal(w, dispatch),
    );
    expect(current.status).toBe(200);
  });

  it("refuses a line principal of another project or another branch", async () => {
    const w = await setup();
    const dispatch = await seedLine(w);
    const otherBranch = linePrincipal(w, dispatch, { branch: "nightshift/other" });
    const otherProject = linePrincipal(w, dispatch, {
      projectId: createFixtures().scope.projectId.replace(/.$/, "Z"),
    });
    for (const principal of [otherBranch, otherProject]) {
      expect((await call(w, "GET", lineUrl(w), undefined, principal)).status).toBe(403);
      expect(
        (await call(w, "POST", lineUrl(w, BRANCH, "/heartbeat"), beat(1), principal)).status,
      ).toBe(403);
    }
  });

  it("refuses a user of another org", async () => {
    const w = await setup();
    await seedLine(w);
    const stranger = nextUserId(w.f);
    await w.stores.memberships.put(makeMembership(stranger, w.f.ids.next("org")));
    const response = await call(w, "GET", lineUrl(w), undefined, {
      kind: "user",
      userId: stranger,
    });
    expect(response.status).toBe(403);
  });

  it("refuses line.cancel by a line principal, and lets a user cancel", async () => {
    const w = await setup();
    const dispatch = await seedLine(w);
    const cancel = lineUrl(w, BRANCH, "/dispatch/cancel");
    expect((await call(w, "POST", cancel, {}, linePrincipal(w, dispatch))).status).toBe(403);
    const response = await call(w, "POST", cancel, {});
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: "stopping", failure: { code: "cancelled" } });
  });
});

describe("GET the line", () => {
  it("returns the record, the dispatch, this month's usage and each queued program's branch", async () => {
    const w = await setup();
    await seedLine(w, { queue: [entry(w)] });
    const usage: ProjectSelfStartedUsage = {
      schemaVersion: 1,
      projectId: w.f.scope.projectId,
      month: "2026-10",
      meteredUsd: 1.5,
      capUsd: 25,
      version: 1,
      updatedAt: NOW,
    };
    await w.stores.projectSelfStartedUsage.update(w.f.scope.projectId, "2026-10", () => usage);
    const dispatch = await heldDispatch(w);
    for (const principal of [w.user, linePrincipal(w, dispatch)]) {
      const response = await call(w, "GET", lineUrl(w), undefined, principal);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const view = response.body as {
        record: LineRecord;
        dispatch: LineDispatch;
        usage: ProjectSelfStartedUsage;
        programs: unknown;
      };
      expect(view.record.branch).toBe(BRANCH);
      expect(view.dispatch.status).toBe("running");
      expect(view.usage.meteredUsd).toBe(1.5);
      expect(view.programs).toEqual([{ program: w.f.scope.programId, branch: "program/fixture" }]);
    }
  });

  it("is a 404 for a line that does not exist", async () => {
    const w = await setup();
    expect((await call(w, "GET", lineUrl(w))).status).toBe(404);
  });
});

describe("batch, compositions, parked and push", () => {
  it("takes the whole queue as one batch, and answers none when empty", async () => {
    const w = await setup();
    const dispatch = await seedLine(w, { queue: [entry(w), entry(w, SHA_B)] });
    const me = linePrincipal(w, dispatch);
    const url = lineUrl(w, BRANCH, "/batch");
    const first = await call(w, "POST", url, { generation: 1 }, me);
    expect((first.body as { batch: { entries: unknown[] } }).batch.entries).toHaveLength(2);
    const record = await w.stores.lines.get(w.f.scope.projectId, BRANCH);
    expect(record?.queue).toEqual([]);
    // The batch held is handed back, not a second one.
    const again = await call(w, "POST", url, { generation: 1 }, me);
    expect((again.body as { batch: unknown }).batch).toEqual(
      (first.body as { batch: unknown }).batch,
    );
    // Nothing queued and nothing held: none.
    const empty = await setup();
    const d2 = await seedLine(empty);
    const none = await call(
      empty,
      "POST",
      lineUrl(empty, BRANCH, "/batch"),
      { generation: 1 },
      linePrincipal(empty, d2),
    );
    expect(none.status).toBe(200);
    expect(none.body).toEqual({});
  });

  const composition = (batchId: string, attempts = 0) => ({
    batchId,
    commit: SHA_B,
    parent: SHA,
    ranges: [{ program: undefined as unknown, upTo: SHA }],
    verification: undefined as unknown,
    resolver: { decision: "none", attempts },
  });

  it("composes the batch it holds, and refuses a stale batchId with 409", async () => {
    const w = await setup();
    const dispatch = await seedLine(w, { queue: [entry(w)] });
    const me = linePrincipal(w, dispatch);
    const taken = await call(w, "POST", lineUrl(w, BRANCH, "/batch"), { generation: 1 }, me);
    const batchId = (taken.body as { batch: { batchId: string } }).batch.batchId;
    const body = {
      ...composition(batchId),
      ranges: [{ program: w.f.scope.programId, upTo: SHA }],
      verification: makeLineVerification(w.f),
    };
    const stale = await call(
      w,
      "POST",
      lineUrl(w, BRANCH, "/compositions"),
      { ...body, batchId: "nope" },
      me,
    );
    expect(stale.status).toBe(409);
    expect(code(stale)).toBe("stale_batch");
    const ok = await call(w, "POST", lineUrl(w, BRANCH, "/compositions"), body, me);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const record = await w.stores.lines.get(w.f.scope.projectId, BRANCH);
    expect(record?.batch).toBeUndefined();
    expect(record?.compositions).toHaveLength(1);
    // Settled: the same batch again is stale.
    expect((await call(w, "POST", lineUrl(w, BRANCH, "/compositions"), body, me)).status).toBe(409);
  });

  it("refuses resolver attempts above 3 with 409, on compositions and parked", async () => {
    const w = await setup();
    const dispatch = await seedLine(w, { queue: [entry(w)] });
    const me = linePrincipal(w, dispatch);
    const taken = await call(w, "POST", lineUrl(w, BRANCH, "/batch"), { generation: 1 }, me);
    const batchId = (taken.body as { batch: { batchId: string } }).batch.batchId;
    const ranges = [{ program: w.f.scope.programId, upTo: SHA }];
    const over = await call(
      w,
      "POST",
      lineUrl(w, BRANCH, "/compositions"),
      { ...composition(batchId, 4), ranges, verification: makeLineVerification(w.f) },
      me,
    );
    expect(over.status).toBe(409);
    expect(code(over)).toBe("resolver_attempts");
    const parkedOver = await call(
      w,
      "POST",
      lineUrl(w, BRANCH, "/parked"),
      { batchId, ranges, reason: "conflict", resolver: { decision: "gave_up", attempts: 4 } },
      me,
    );
    expect(parkedOver.status).toBe(409);
    const parked = await call(
      w,
      "POST",
      lineUrl(w, BRANCH, "/parked"),
      { batchId, ranges, reason: "conflict", resolver: { decision: "gave_up", attempts: 3 } },
      me,
    );
    expect(parked.status, JSON.stringify(parked.body)).toBe(200);
    expect(
      (await call(w, "POST", lineUrl(w, BRANCH, "/parked"), { batchId, ranges, reason: "x" }, me))
        .status,
    ).toBe(409);
  });

  it("records a pending push, then asks the publisher; another head is refused", async () => {
    const w = await setup();
    const dispatch = await seedLine(w);
    const me = linePrincipal(w, dispatch);
    const push = { head: SHA_B, expectedPredecessor: SHA, bundleKey: "k/1.pack" };
    const response = await call(w, "POST", lineUrl(w, BRANCH, "/push"), push, me);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const record = await w.stores.lines.get(w.f.scope.projectId, BRANCH);
    expect(record?.push).toMatchObject({ head: SHA_B, status: "pending", generation: 1 });
    expect(published).toEqual([BRANCH]);
    const other = await call(
      w,
      "POST",
      lineUrl(w, BRANCH, "/push"),
      { ...push, head: "c".repeat(40) },
      me,
    );
    expect(other.status).toBe(409);
  });
});

describe("bundle-upload-url", () => {
  it("signs a PUT for the line bundle key", async () => {
    const w = await setup();
    const dispatch = await seedLine(w);
    const response = await call(
      w,
      "POST",
      lineUrl(w, BRANCH, "/bundle-upload-url"),
      { generation: 1, id: "01ABC" },
      linePrincipal(w, dispatch),
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const key = lineBundleObjectKey(w.f.scope.projectId, BRANCH, 1, "01ABC");
    expect(key).toBe(`${w.f.scope.projectId}/line/nightshift%2Fdevelop/1/01ABC.pack`);
    expect(w.signed).toEqual([key]);
    expect(response.body).toMatchObject({ key, uploadUrl: expect.stringContaining(key) });
  });

  it("refuses an id that would leave its prefix, and a stale generation", async () => {
    const w = await setup();
    const dispatch = await seedLine(w);
    const me = linePrincipal(w, dispatch);
    const url = lineUrl(w, BRANCH, "/bundle-upload-url");
    expect((await call(w, "POST", url, { generation: 1, id: "../x" }, me)).status).toBe(400);
    expect((await call(w, "POST", url, { generation: 2, id: "ok" }, me)).status).toBe(409);
    expect(w.signed).toEqual([]);
  });
});

describe("the heartbeat", () => {
  const usageOf = (w: World) =>
    w.stores.projectSelfStartedUsage.get(w.f.scope.projectId, "2026-10");
  const ledgerOf = (w: World) => w.stores.computeLedger.get(w.orgId, "2026-10");

  it("refuses a body generation that is not the current one", async () => {
    const w = await setup();
    await seedLine(w, { dispatch: { generation: 2 } });
    const response = await call(w, "POST", lineUrl(w, BRANCH, "/heartbeat"), beat(1));
    expect(response.status).toBe(409);
    expect(code(response)).toBe("stale_generation");
  });

  it("meters both the project's self-started ledger and the org's", async () => {
    const w = await setup();
    const dispatch = await seedLine(w);
    const response = await call(
      w,
      "POST",
      lineUrl(w, BRANCH, "/heartbeat"),
      beat(1, { meteredSeconds: 1800 }),
      linePrincipal(w, dispatch),
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const stored = await heldDispatch(w);
    expect(stored.spend.meteredUsd).toBeGreaterThan(0);
    expect((await usageOf(w))?.meteredUsd).toBeCloseTo(stored.spend.meteredUsd);
    expect((await ledgerOf(w))?.meteredUsd).toBeCloseTo(stored.spend.meteredUsd);
    // A second beat adds only the difference.
    await call(w, "POST", lineUrl(w, BRANCH, "/heartbeat"), beat(1, { meteredSeconds: 3000 }));
    const after = await heldDispatch(w);
    expect((await usageOf(w))?.meteredUsd).toBeCloseTo(after.spend.meteredUsd);
    expect((await ledgerOf(w))?.meteredUsd).toBeCloseTo(after.spend.meteredUsd);
  });

  it("renews the token, and carries the GitHub read token, only while running", async () => {
    const w = await setup();
    const deps: ApiDeps = {
      ...w.deps,
      github: {
        app: async () => ({ slug: "s", installUrl: "https://example.invalid" }),
        installation: async () => ({ account: "example", repositories: ["example/fixture"] }),
        branchHead: async () => SHA,
        readToken: async () => ({ token: "ghs_read", expiresAt: NOW }),
        writeToken: async () => ({ token: "ghs_write", expiresAt: NOW }),
      },
    };
    const world = { ...w, deps };
    const dispatch = await seedLine(world);
    await world.stores.orgConfigs.put({
      schemaVersion: 1,
      orgId: world.orgId,
      routingPolicy: DEFAULT_ROUTING_POLICY,
      examinationPolicy: DEFAULT_EXAMINATION_POLICY,
      installations: [
        {
          installationId: 5,
          account: "example",
          repositories: ["example/fixture"],
          recordedAt: NOW,
        },
      ] as never,
      compute: DEFAULT_COMPUTE_CEILINGS,
      version: 1,
      updatedAt: NOW,
    });
    const response = await call(
      world,
      "POST",
      lineUrl(world, BRANCH, "/heartbeat"),
      beat(1),
      linePrincipal(world, dispatch),
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const body = response.body as {
      token: string;
      stop: boolean;
      credentials?: Record<string, string>;
    };
    expect(body.stop).toBe(false);
    const verified = verifyExecutionToken(body.token, {
      publicKey: keys.publicKey,
      issuer: ISSUER,
      now: Date.parse(NOW),
    });
    expect(verified.ok && verified.principal).toMatchObject({
      kind: "line",
      branch: BRANCH,
      generation: 1,
    });
    expect(body.credentials).toEqual({ github: "ghs_read" });
  });

  it("stops the machine when the project cap is crossed and records waiting", async () => {
    const w = await setup();
    const dispatch = await seedLine(w, { capUsd: 0.1 });
    const response = await call(
      w,
      "POST",
      lineUrl(w, BRANCH, "/heartbeat"),
      beat(1, { meteredSeconds: 3600 }),
      linePrincipal(w, dispatch),
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toMatchObject({ stop: true, status: "stopping" });
    expect((response.body as { token?: string }).token).toBeUndefined();
    const stored = await heldDispatch(w);
    expect(stored.failure?.code).toBe("line_cap");
    expect((await usageOf(w))?.reachedAt).toBe(NOW);
    const record = await w.stores.lines.get(w.f.scope.projectId, BRANCH);
    expect(record?.waiting).toMatchObject({ reason: "monthly_cap", since: NOW });
  });

  it("counts spend made earlier by another branch of the same project", async () => {
    const w = await setup();
    const dispatch = await seedLine(w, { capUsd: 1 });
    await w.stores.projectSelfStartedUsage.update(w.f.scope.projectId, "2026-10", () => ({
      schemaVersion: 1,
      projectId: w.f.scope.projectId,
      month: "2026-10",
      // Spent by a line on another branch: all but a cent of the cap.
      meteredUsd: 0.995,
      capUsd: 1,
      version: 1,
      updatedAt: NOW,
    }));
    const response = await call(
      w,
      "POST",
      lineUrl(w, BRANCH, "/heartbeat"),
      beat(1, { meteredSeconds: 120 }),
      linePrincipal(w, dispatch),
    );
    expect(response.body).toMatchObject({ stop: true });
    expect((await w.stores.lineDispatches.get(w.f.scope.projectId, BRANCH))?.failure?.code).toBe(
      "line_cap",
    );
  });

  it("parks a batch older than an hour with reason composition_hour", async () => {
    const w = await setup();
    const dispatch = await seedLine(w, {
      batch: {
        batchId: "batch-old",
        entries: [entry(w)],
        takenAt: "2026-10-01T10:30:00.000Z",
        generation: 1,
      },
    });
    await call(w, "POST", lineUrl(w, BRANCH, "/heartbeat"), beat(1), linePrincipal(w, dispatch));
    const record = await w.stores.lines.get(w.f.scope.projectId, BRANCH);
    expect(record?.batch).toBeUndefined();
    expect(record?.parked).toHaveLength(1);
    expect(record?.parked[0]).toMatchObject({
      reason: "composition_hour",
      ranges: [{ program: w.f.scope.programId, upTo: SHA }],
    });
  });

  it("leaves a younger batch alone", async () => {
    const w = await setup();
    const dispatch = await seedLine(w, {
      batch: {
        batchId: "batch-young",
        entries: [entry(w)],
        takenAt: "2026-10-01T11:30:00.000Z",
        generation: 1,
      },
    });
    await call(w, "POST", lineUrl(w, BRANCH, "/heartbeat"), beat(1), linePrincipal(w, dispatch));
    expect((await w.stores.lines.get(w.f.scope.projectId, BRANCH))?.batch?.batchId).toBe(
      "batch-young",
    );
  });

  it("moves provisioning to ready and ready to running", async () => {
    const w = await setup();
    const dispatch = await seedLine(w, { dispatch: { status: "provisioning" } });
    const me = linePrincipal(w, dispatch);
    const url = lineUrl(w, BRANCH, "/heartbeat");
    expect((await call(w, "POST", url, beat(1, { report: "ready" }), me)).body).toMatchObject({
      status: "ready",
    });
    expect((await call(w, "POST", url, beat(1, { report: "running" }), me)).body).toMatchObject({
      status: "running",
    });
  });

  it("starts no second dispatch on `stopped` with work queued until cleanup has settled", async () => {
    const w = await setup();
    const dispatch = await seedLine(w, { queue: [entry(w)] });
    const me = linePrincipal(w, dispatch);
    const url = lineUrl(w, BRANCH, "/heartbeat");
    const stopped = await call(w, "POST", url, beat(1, { report: "stopped" }), me);
    expect(stopped.status, JSON.stringify(stopped.body)).toBe(200);
    expect((await w.stores.lineDispatches.get(w.f.scope.projectId, BRANCH))?.status).toBe(
      "stopped",
    );
    expect(provisioned).toEqual([]);
    const again = await call(w, "POST", url, beat(1, { report: "stopped" }), me);
    expect(again.status).toBe(200);
    expect(provisioned).toEqual([]);
    expect((await w.stores.lineDispatches.get(w.f.scope.projectId, BRANCH))?.generation).toBe(1);

    // Cleanup settles (J5's); the next report starts exactly one, at the next generation.
    await w.stores.lineDispatches.update(w.f.scope.projectId, BRANCH, (current) => ({
      ...current,
      cleanup: { ...current.cleanup, settledAt: NOW },
    }));
    await call(w, "POST", url, beat(1, { report: "stopped" }), me);
    await call(w, "POST", url, beat(1, { report: "stopped" }), me);
    const next = await heldDispatch(w);
    expect(next).toMatchObject({ generation: 2, status: "requested" });
    expect(provisioned).toEqual([BRANCH]);
  });
});

describe("the heartbeat's charge to the project's ledger", () => {
  const usageOf = (w: World, month = "2026-10") =>
    w.stores.projectSelfStartedUsage.get(w.f.scope.projectId, month);
  const url = (w: World) => lineUrl(w, BRANCH, "/heartbeat");

  it("repairs a failed ledger write on the retry, records the cap and stops the machine", async () => {
    const w = await setup();
    const dispatch = await seedLine(w, { capUsd: 0.1 });
    const real = w.stores.projectSelfStartedUsage;
    let failures = 1;
    const flaky: ApiDeps = {
      ...w.deps,
      stores: {
        ...w.stores,
        projectSelfStartedUsage: {
          ...real,
          get: real.get.bind(real),
          update: async (...args: Parameters<typeof real.update>) => {
            if (failures-- > 0) throw new Error("injected ledger failure");
            return real.update(...args);
          },
        },
      },
    };
    const principal = linePrincipal(w, dispatch);
    const first = await handleRequest(flaky, {
      method: "POST",
      path: url(w),
      query: {},
      body: beat(1, { meteredSeconds: 3600 }),
      principal,
    });
    expect(first.status).toBe(500);
    expect(await usageOf(w)).toBeUndefined();
    const spent = (await heldDispatch(w)).spend.meteredUsd;
    expect(spent).toBeGreaterThan(0.1);

    const retry = await handleRequest(flaky, {
      method: "POST",
      path: url(w),
      query: {},
      body: beat(1, { meteredSeconds: 3600 }),
      principal,
    });
    expect(retry.body).toMatchObject({ stop: true, status: "stopping" });
    expect((await usageOf(w))?.meteredUsd).toBeCloseTo(spent);
    expect((await usageOf(w))?.reachedAt).toBe(NOW);
    expect((await heldDispatch(w)).failure?.code).toBe("line_cap");
    expect((await w.stores.lines.get(w.f.scope.projectId, BRANCH))?.waiting).toMatchObject({
      reason: "monthly_cap",
    });
  });

  it("charges a dispatch once however many beats repeat its spend", async () => {
    const w = await setup();
    const dispatch = await seedLine(w, { capUsd: 100 });
    const principal = linePrincipal(w, dispatch);
    for (let i = 0; i < 3; i += 1) {
      await call(w, "POST", url(w), beat(1, { meteredSeconds: 1800 }), principal);
    }
    const spent = (await heldDispatch(w)).spend.meteredUsd;
    const row = await usageOf(w);
    expect(row?.meteredUsd).toBeCloseTo(spent);
    expect(row?.charged?.[dispatchChargeKey(BRANCH, dispatch.engineAgentId)]).toBeCloseTo(spent);
    expect(row?.version).toBe(1);
  });

  it("charges a replaced dispatch once: the earlier generation's spend is not charged again", async () => {
    const w = await setup();
    const dispatch = await seedLine(w, { capUsd: 0.6 });
    const first = await call(
      w,
      "POST",
      url(w),
      beat(1, { meteredSeconds: 3600 }),
      linePrincipal(w, dispatch),
    );
    expect(first.body).toMatchObject({ stop: false });
    const spent = (await heldDispatch(w)).spend.meteredUsd;
    expect(spent).toBeGreaterThan(0.4);
    expect(spent).toBeLessThan(0.6);
    expect((await usageOf(w))?.meteredUsd).toBeCloseTo(spent);

    await w.stores.lineDispatches.update(w.f.scope.projectId, BRANCH, (current) => ({
      ...beginReplacement(current, "lease_lost", NOW),
      status: "running" as const,
      instanceId: "i-2",
    }));
    const second = linePrincipal(w, await heldDispatch(w));
    expect(second.kind === "line" && second.generation).toBe(2);
    const zero = await call(w, "POST", url(w), beat(2, { meteredSeconds: 0 }), second);
    expect(zero.body).toMatchObject({ stop: false });
    expect((await heldDispatch(w)).spend.meteredUsd).toBeCloseTo(spent);
    expect((await usageOf(w))?.meteredUsd).toBeCloseTo(spent);
    expect((await usageOf(w))?.reachedAt).toBeUndefined();

    const more = await call(w, "POST", url(w), beat(2, { meteredSeconds: 600 }), second);
    expect(more.body).toMatchObject({ stop: false });
    const total = (await heldDispatch(w)).spend.meteredUsd;
    expect(total).toBeGreaterThan(spent);
    expect((await usageOf(w))?.meteredUsd).toBeCloseTo(total);
  });

  it("charges each of two successive line dispatches its own spend", async () => {
    const w = await setup();
    const dispatch = await seedLine(w, { capUsd: 100 });
    await call(w, "POST", url(w), beat(1, { meteredSeconds: 1800 }), linePrincipal(w, dispatch));
    const one = (await heldDispatch(w)).spend.meteredUsd;
    await w.stores.lineDispatches.update(w.f.scope.projectId, BRANCH, () =>
      makeLineDispatch(w.f, {
        status: "running",
        instanceId: "i-3",
        generation: 2,
        attempts: [{ generation: 2, reason: "dispatch", startedAt: NOW }],
      }),
    );
    const next = await heldDispatch(w);
    expect(next.engineAgentId).not.toBe(dispatch.engineAgentId);
    await call(w, "POST", url(w), beat(2, { meteredSeconds: 900 }), linePrincipal(w, next));
    const two = (await heldDispatch(w)).spend.meteredUsd;
    expect(two).toBeGreaterThan(0);
    const row = await usageOf(w);
    expect(row?.meteredUsd).toBeCloseTo(one + two);
    expect(Object.keys(row?.charged ?? {})).toHaveLength(2);
  });

  it("charges only the spend after a month boundary in the new month's row", async () => {
    const w = await setup();
    const dispatch = await seedLine(w, { capUsd: 100 });
    const principal = linePrincipal(w, dispatch);
    await call(w, "POST", url(w), beat(1, { meteredSeconds: 1800 }), principal);
    const october = (await heldDispatch(w)).spend.meteredUsd;
    await handleRequest(
      { ...w.deps, clock: createFixedClock(Date.parse("2026-11-01T00:30:00.000Z")) },
      {
        method: "POST",
        path: url(w),
        query: {},
        body: beat(1, { meteredSeconds: 3600 }),
        principal,
      },
    );
    const total = (await heldDispatch(w)).spend.meteredUsd;
    expect((await usageOf(w, "2026-10"))?.meteredUsd).toBeCloseTo(october);
    expect((await usageOf(w, "2026-11"))?.meteredUsd).toBeCloseTo(total - october);
  });
});
