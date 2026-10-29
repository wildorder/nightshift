/**
 * The project line's routes (Pipkin M1b): who may use each of the five that
 * survive (line.get, takeBatch, settle, push, createBundleUploadUrl), the
 * queue and its refusals, the push and the bundle upload URL. The line's owner
 * is the engine of a run of the line program; humans may read the line.
 * Through the real handler over the memory stores.
 */
import { generateKeyPairSync, sign as signWith } from "node:crypto";
import {
  DEFAULT_EXAMINATION_POLICY,
  DEFAULT_ROUTING_POLICY,
  type LineRecord,
  MAX_INLINE_PAYLOAD_BYTES,
  type OrgId,
  type ProgramId,
  type ProjectId,
  type ProjectSelfStartedUsage,
  type RunId,
} from "@nightshift/contracts";
import {
  createFixedClock,
  createFixtures,
  type Fixtures,
  gatherReport,
  lineBundleObjectKey,
  lineProgramId,
  makeDispatch,
  makeLineRecord,
  makeLineVerification,
  makeMembership,
  makeProgramContract,
  makeProject,
  makeRootNode,
  makeRun,
  nextUserId,
} from "@nightshift/core";
import { createInMemoryStores, type InMemoryStores } from "@nightshift/persistence/memory";
import { describe, expect, it, vi } from "vitest";
import type { RequestPrincipal } from "./auth/principal.js";
import { handleRequest, ROUTES } from "./handler.js";
import type { ApiDeps, ApiResponse } from "./http.js";

const NOW = "2026-10-01T12:00:00.000Z";
const SHA = "a".repeat(40);
const SHA_B = "b".repeat(40);
const BRANCH = "nightshift/develop";
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const ISSUER = "https://api.test.nightshift.invalid";

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
        signer: {
          sign: async (input) => signWith("sha256", input, keys.privateKey),
        },
      },
    },
  };
};

const lineUrl = (w: World, branch = BRANCH, tail = "") =>
  `/projects/${w.f.scope.projectId}/line${tail}?branch=${encodeURIComponent(branch)}`;

/** A request as the gateway hands it over: the path, and the query apart from it. */
const call = (
  w: World,
  method: string,
  url: string,
  body?: unknown,
  principal: RequestPrincipal = w.user,
): Promise<ApiResponse> => {
  const [path = url, search = ""] = url.split("?");
  const query = Object.fromEntries(new URLSearchParams(search));
  return handleRequest(w.deps, { method, path, query, body, principal });
};

const code = (response: ApiResponse): string =>
  (response.body as { error: { code: string } }).error.code;

interface Seed {
  readonly queue?: LineRecord["queue"];
  readonly batch?: LineRecord["batch"];
  readonly held?: LineRecord["held"];
}

/** The engine of a run, as the dispatch Lambda mints it. */
const engineOf = (
  w: World,
  runId: string,
  overrides: Record<string, unknown> = {},
): RequestPrincipal =>
  ({
    kind: "execution",
    projectId: w.f.scope.projectId,
    programId: lineProgramId(w.f.scope.projectId, BRANCH),
    runId,
    nodeId: w.f.rootNodeId,
    agentId: w.f.ids.next("agent"),
    role: "engine",
    generation: 1,
    ...overrides,
  }) as RequestPrincipal;

/** Starts a run of a program with a dispatch at generation 1, as the plane does. */
const startRun = async (w: World, programId = lineProgramId(w.f.scope.projectId, BRANCH)) => {
  const runId = w.f.ids.next("run");
  await w.stores.runs.put(makeRun(w.f, { programId, runId, status: "pending" }));
  await w.stores.dispatches.put(
    makeDispatch(w.f, {
      programId,
      runId,
      generation: 1,
      status: "running",
      instanceId: "i-1",
    }),
  );
  await w.stores.runs.put(makeRun(w.f, { programId, runId, status: "running" }));
  return runId;
};

const endRun = async (w: World, runId: string) => {
  const programId = lineProgramId(w.f.scope.projectId, BRANCH);
  const run = await w.stores.runs.get(
    { projectId: w.f.scope.projectId, programId },
    runId as RunId,
  );
  if (run === undefined) throw new Error("no such run");
  await w.stores.runs.put({ ...run, status: "succeeded" });
};

/** A line fed by a program, and the line program, with no run of it yet. */
const seedLineRecords = async (w: World, seed: Seed = {}) => {
  await w.stores.programContracts.put(makeProgramContract(w.f, { line: { branch: BRANCH } }));
  await w.stores.programContracts.put(
    makeProgramContract(w.f, {
      programId: lineProgramId(w.f.scope.projectId, BRANCH),
      kind: "line",
      repository: {
        url: "https://example.invalid/repo.git",
        baseBranch: "main",
        programBranch: BRANCH,
      },
    }),
  );
  await w.stores.lines.update(w.f.scope.projectId, BRANCH, () =>
    makeLineRecord(w.f, {
      queue: seed.queue ?? [],
      ...(seed.held === undefined ? {} : { held: seed.held }),
      ...(seed.batch === undefined ? {} : { batch: seed.batch }),
    }),
  );
};

/** A line as `seedLineRecords` makes it, and a live run of its program: answers the run and its engine. */
const seedLine = async (w: World, seed: Seed = {}) => {
  await seedLineRecords(w, seed);
  const runId = await startRun(w);
  return { runId, me: engineOf(w, runId) };
};

const entry = (w: World, upTo = SHA) => ({
  program: w.f.scope.programId,
  upTo,
  enqueuedAt: NOW,
});

describe("the line routes", () => {
  it("are exactly the six that survive", () => {
    expect(
      ROUTES.filter((route) => route.operation.startsWith("line.")).map((route) => route.operation),
    ).toEqual([
      "line.get",
      "line.takeBatch",
      "line.settle",
      "line.attempt",
      "line.push",
      "line.createBundleUploadUrl",
    ]);
  });
});

/**
 * Every principal against every surviving line route. `allowed` is a route the
 * principal reaches (anything but a 403: what it then asks may still be
 * refused for its own reasons); `read` only the GET; `none` no route at all.
 */
describe("every principal against every line route", () => {
  type Reach = "all" | "read" | "none";
  const ROUTES = [
    { name: "line.get", method: "GET", tail: "", body: undefined, read: true },
    {
      name: "line.takeBatch",
      method: "POST",
      tail: "/batch",
      body: { generation: 1 },
      read: false,
    },
    {
      name: "line.settle",
      method: "POST",
      tail: "/settle",
      body: { batchId: "x", parked: [] },
      read: false,
    },
    {
      name: "line.push",
      method: "POST",
      tail: "/push",
      body: { head: SHA_B, expectedPredecessor: SHA, bundleKey: "bundles/k" },
      read: false,
    },
    {
      name: "line.createBundleUploadUrl",
      method: "POST",
      tail: "/bundle-upload-url",
      body: { generation: 1, id: "b1" },
      read: false,
    },
  ] as const;

  interface Case {
    readonly name: string;
    readonly reach: Reach;
    readonly principal: (w: World, runId: string) => Promise<RequestPrincipal> | RequestPrincipal;
    /** Which branch the request names; the line's own unless the case says otherwise. */
    readonly branch?: string;
  }

  const CASES: readonly Case[] = [
    {
      name: "a user of the owning org",
      reach: "read",
      principal: (w) => w.user,
    },
    {
      name: "a user of another org",
      reach: "none",
      principal: async (w) => {
        const stranger = nextUserId(w.f);
        await w.stores.memberships.put(makeMembership(stranger, w.f.ids.next("org")));
        return { kind: "user", userId: stranger };
      },
    },
    {
      name: "the line run's engine token",
      reach: "all",
      principal: (w, runId) => engineOf(w, runId),
    },
    {
      name: "the line run's engine token, on another branch",
      reach: "none",
      branch: "nightshift/other",
      principal: (w, runId) => engineOf(w, runId),
    },
    {
      name: "the line run's engine token, of another project",
      reach: "none",
      principal: (w, runId) => engineOf(w, runId, { projectId: createFixtures().scope.projectId }),
    },
    {
      name: "the line run's engine token, at a stale generation",
      reach: "read",
      principal: (w, runId) => engineOf(w, runId, { generation: 2 }),
    },
    {
      name: "the line run's engine token, once its run has ended",
      reach: "read",
      principal: async (w, runId) => {
        await endRun(w, runId);
        return engineOf(w, runId);
      },
    },
    {
      name: "a non-line engine token of the same project",
      reach: "none",
      principal: async (w) => {
        const runId = await startRun(w, w.f.scope.programId);
        return engineOf(w, runId, { programId: w.f.scope.programId });
      },
    },
    ...(["orchestrator", "worker", "examiner"] as const).map(
      (role): Case => ({
        name: `the line run's ${role}`,
        reach: "none",
        principal: (w, runId) => engineOf(w, runId, { role }),
      }),
    ),
  ];

  for (const kase of CASES) {
    describe(kase.name, () => {
      for (const route of ROUTES) {
        const reached =
          kase.reach === "all" || (kase.reach === "read" && route.read) ? "reaches" : "is refused";
        it(`${reached} ${route.name}`, async () => {
          const w = await setup();
          const { runId } = await seedLine(w, { queue: [entry(w)] });
          const principal = await kase.principal(w, runId);
          const response = await call(
            w,
            route.method,
            lineUrl(w, kase.branch ?? BRANCH, route.tail),
            route.body,
            principal,
          );
          if (reached === "is refused") {
            expect(response.status, JSON.stringify(response.body)).toBe(403);
          } else {
            expect(response.status, JSON.stringify(response.body)).not.toBe(403);
            if (route.name === "line.get" || route.name === "line.takeBatch") {
              expect(response.status, JSON.stringify(response.body)).toBe(200);
            }
          }
        });
      }
    });
  }
});

describe("GET the line", () => {
  it("returns the record, the line program's latest run, this month's usage and each queued program's branch", async () => {
    const w = await setup();
    const { runId, me } = await seedLine(w, { queue: [entry(w)] });
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
    for (const principal of [w.user, me]) {
      const response = await call(w, "GET", lineUrl(w), undefined, principal);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const view = response.body as Record<string, unknown> & {
        record: LineRecord;
        usage: ProjectSelfStartedUsage;
      };
      expect(view.record.branch).toBe(BRANCH);
      expect(view.programId).toBe(lineProgramId(w.f.scope.projectId, BRANCH));
      expect(view.runId).toBe(runId);
      expect(view.dispatchStatus).toBe("running");
      expect(view.generation).toBe(1);
      expect(view.meteredUsd).toBe(0);
      expect(view.dispatch).toBeUndefined();
      expect(view.usage.meteredUsd).toBe(1.5);
      expect(view.programs).toEqual([{ program: w.f.scope.programId, branch: "program/fixture" }]);
    }
  });

  it("names the line program and no run before one has started", async () => {
    const w = await setup();
    await seedLine(w);
    const bare = await setup();
    await bare.stores.lines.update(bare.f.scope.projectId, BRANCH, () => makeLineRecord(bare.f));
    const response = await call(bare, "GET", lineUrl(bare));
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      programId: lineProgramId(bare.f.scope.projectId, BRANCH),
    });
    expect((response.body as { runId?: string }).runId).toBeUndefined();
    expect((response.body as { dispatchStatus?: string }).dispatchStatus).toBeUndefined();
  });

  it("is a 404 for a line that does not exist", async () => {
    const w = await setup();
    expect((await call(w, "GET", lineUrl(w))).status).toBe(404);
  });
});

describe("batch, settle and push", () => {
  it("takes the whole queue as one batch, and answers none when empty", async () => {
    const w = await setup();
    const { me } = await seedLine(w, { queue: [entry(w), entry(w, SHA_B)] });
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
    const idle = await seedLine(empty);
    const none = await call(
      empty,
      "POST",
      lineUrl(empty, BRANCH, "/batch"),
      { generation: 1 },
      idle.me,
    );
    expect(none.status).toBe(200);
    expect(none.body).toEqual({});
  });

  it("holds settled entries, refuses others, and releases them on the next take", async () => {
    const w = await setup();
    const { me } = await seedLine(w, { queue: [entry(w), entry(w, SHA_B)] });
    const taken = await call(w, "POST", lineUrl(w, BRANCH, "/batch"), { generation: 1 }, me);
    const batchId = (taken.body as { batch: { batchId: string } }).batch.batchId;
    const url = lineUrl(w, BRANCH, "/settle");
    const foreign = await call(
      w,
      "POST",
      url,
      { batchId, parked: [], held: [entry(w, "c".repeat(40))] },
      me,
    );
    expect(foreign.status).toBe(409);
    expect(code(foreign)).toBe("held_not_in_batch");
    const held = { ...entry(w), repairs: 2 };
    const settled = await call(w, "POST", url, { batchId, parked: [], held: [held] }, me);
    expect(settled.status).toBe(200);
    const record = await w.stores.lines.get(w.f.scope.projectId, BRANCH);
    expect(record?.held).toEqual([held]);
    const released = await call(
      w,
      "POST",
      lineUrl(w, BRANCH, "/batch"),
      { generation: 1, release: [{ program: held.program, upTo: held.upTo }] },
      me,
    );
    const entries = (released.body as { batch: { entries: unknown[] } }).batch.entries;
    expect(entries).toEqual([held]);
    expect((await w.stores.lines.get(w.f.scope.projectId, BRANCH))?.held).toEqual([]);
  });

  it("settles a batch with a composition and parked entries in one change", async () => {
    const w = await setup();
    const { me } = await seedLine(w, { queue: [entry(w), entry(w, SHA_B)] });
    const taken = await call(w, "POST", lineUrl(w, BRANCH, "/batch"), { generation: 1 }, me);
    const batchId = (taken.body as { batch: { batchId: string } }).batch.batchId;
    const program = w.f.scope.programId;
    const parked = { ranges: [{ program, upTo: SHA_B }], reason: "conflict" };
    const body = {
      batchId,
      composition: {
        commit: SHA_B,
        parent: SHA,
        ranges: [{ program, upTo: SHA }],
        verification: makeLineVerification(w.f),
      },
      push: { head: SHA_B, expectedPredecessor: SHA, bundleKey: "bundles/k" },
      parked: [parked],
    };
    const url = lineUrl(w, BRANCH, "/settle");
    const withoutPush = await call(w, "POST", url, { ...body, push: undefined }, me);
    expect(withoutPush.status).toBe(400);
    const stale = await call(w, "POST", url, { ...body, batchId: "nope" }, me);
    expect(stale.status).toBe(409);
    expect(code(stale)).toBe("stale_batch");
    const over = await call(
      w,
      "POST",
      url,
      {
        ...body,
        parked: [{ ...parked, resolver: { decision: "gave_up", attempts: 4 } }],
      },
      me,
    );
    expect(over.status).toBe(409);
    expect(code(over)).toBe("resolver_attempts");
    const overComposed = await call(
      w,
      "POST",
      url,
      {
        ...body,
        composition: {
          ...body.composition,
          resolver: { decision: "none", attempts: 4 },
        },
      },
      me,
    );
    expect(overComposed.status).toBe(409);
    expect(code(overComposed)).toBe("resolver_attempts");
    const ok = await call(w, "POST", url, body, me);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const record = await w.stores.lines.get(w.f.scope.projectId, BRANCH);
    expect(record?.batch).toBeUndefined();
    expect(record?.compositions).toHaveLength(1);
    expect(record?.parked).toHaveLength(1);
    expect(record?.compositions[0]?.compositionId).not.toBe(record?.parked[0]?.compositionId);
    expect(record?.push).toMatchObject({
      head: SHA_B,
      status: "pending",
      generation: 1,
    });
    // Settled: the same body again is a recovery; another body for the batch is stale.
    expect((await call(w, "POST", url, body, me)).status).toBe(200);
    expect((await call(w, "POST", url, { ...body, parked: [] }, me)).status).toBe(409);
  });

  describe("settle appends the entries to the holding run as events", () => {
    const settled = async () => {
      const w = await setup();
      const { me, runId } = await seedLine(w, {
        queue: [entry(w), entry(w, SHA_B)],
      });
      const taken = await call(w, "POST", lineUrl(w, BRANCH, "/batch"), { generation: 1 }, me);
      const batchId = (taken.body as { batch: { batchId: string } }).batch.batchId;
      const program = w.f.scope.programId;
      const body = {
        batchId,
        composition: {
          commit: SHA_B,
          parent: SHA,
          ranges: [{ program, upTo: SHA }],
          verification: makeLineVerification(w.f),
        },
        push: { head: SHA_B, expectedPredecessor: SHA, bundleKey: "bundles/k" },
        parked: [
          { ranges: [{ program, upTo: SHA_B }], reason: "conflict" },
          { ranges: [{ program, upTo: SHA_B }], reason: "budget" },
        ],
      };
      const scope = {
        projectId: w.f.scope.projectId,
        programId: lineProgramId(w.f.scope.projectId, BRANCH),
        runId,
      };
      return { w, me, body, scope };
    };

    it("appends one event per entry and a commit marker, and a repeated settle adds none", async () => {
      const { w, me, body, scope } = await settled();
      const url = lineUrl(w, BRANCH, "/settle");
      expect((await call(w, "POST", url, body, me)).status).toBe(200);
      const events = (await w.stores.events.listByRun(scope)).items;
      expect(events.map((e) => e.type).sort()).toEqual([
        "line.composed",
        "line.parked",
        "line.parked",
        "line.settled",
      ]);
      const record = await w.stores.lines.get(w.f.scope.projectId, BRANCH);
      const entryKeys = events
        .filter((e) => e.type !== "line.settled")
        .map((e) => e.idempotencyKey)
        .sort();
      expect(entryKeys).toEqual(
        [
          `line.composed:${record?.compositions[0]?.compositionId}`,
          ...(record?.parked ?? []).map((p) => `line.parked:${p.compositionId}`),
        ]
          .sort()
          .map((prefix, i) => {
            expect(entryKeys[i]?.startsWith(`${prefix}:`)).toBe(true);
            return entryKeys[i];
          }),
      );
      for (const key of entryKeys) expect(key?.length).toBeLessThanOrEqual(256);
      expect(record?.lastSettled?.batchId).toBe(body.batchId);
      // The same body again is a recovery of a committed settle: 200, nothing new.
      expect((await call(w, "POST", url, body, me)).status).toBe(200);
      expect((await w.stores.events.listByRun(scope)).items).toHaveLength(4);
      // A different body for the settled batch stays a refusal.
      const other = await call(w, "POST", url, { ...body, parked: [] }, me);
      expect(other.status).toBe(409);
      expect(code(other)).toBe("stale_batch");
    });

    it("derives the ids from the batch, so a retry yields the same ones", async () => {
      const { w, me, body } = await settled();
      expect((await call(w, "POST", lineUrl(w, BRANCH, "/settle"), body, me)).status).toBe(200);
      const record = await w.stores.lines.get(w.f.scope.projectId, BRANCH);
      expect(record?.compositions[0]?.compositionId).toBe(`${body.batchId}-c`);
      expect(record?.parked.map((p) => p.compositionId)).toEqual([
        `${body.batchId}-p0`,
        `${body.batchId}-p1`,
      ]);
    });

    const reportOf = async (
      w: World,
      scope: { projectId: ProjectId; programId: ProgramId; runId: RunId },
    ) => {
      await w.stores.executionNodes.put(makeRootNode(w.f, scope));
      return (await gatherReport(w.stores, scope)).line;
    };
    const evict = (w: World) =>
      w.stores.lines.update(w.f.scope.projectId, BRANCH, (cur) =>
        cur === undefined ? undefined : { ...cur, compositions: [], parked: [] },
      );

    it("a failure on the second entry append fails the settle, leaves the record, and reports none; a retry reports each entry once", async () => {
      const { w, me, body, scope } = await settled();
      const before = await w.stores.lines.get(w.f.scope.projectId, BRANCH);
      const append = w.stores.events.append.bind(w.stores.events);
      let calls = 0;
      vi.spyOn(w.stores.events, "append").mockImplementation((event) => {
        calls += 1;
        // The second entry's append fails, once: the first is already stored.
        if (calls === 2) return Promise.reject(new Error("store down"));
        return append(event);
      });
      const url = lineUrl(w, BRANCH, "/settle");
      const failed = await call(w, "POST", url, body, me);
      expect(failed.status).toBeGreaterThanOrEqual(500);
      expect(await w.stores.lines.get(w.f.scope.projectId, BRANCH)).toEqual(before);
      expect((await w.stores.events.listByRun(scope)).items).toHaveLength(1);
      const none = await reportOf(w, scope);
      expect(none?.compositions).toEqual([]);
      expect(none?.parked).toEqual([]);
      const retried = await call(w, "POST", url, body, me);
      expect(retried.status, JSON.stringify(retried.body)).toBe(200);
      await evict(w);
      const line = await reportOf(w, scope);
      expect(line?.compositions.map((c) => c.compositionId)).toEqual([`${body.batchId}-c`]);
      expect(line?.parked.map((p) => p.reason).sort()).toEqual(["budget", "conflict"]);
      vi.restoreAllMocks();
    });

    it("a takeover between the dry-run and the update refuses the settle and reports nothing", async () => {
      const { w, me, body, scope } = await settled();
      const append = w.stores.events.append.bind(w.stores.events);
      let calls = 0;
      vi.spyOn(w.stores.events, "append").mockImplementation(async (event) => {
        const stored = await append(event);
        calls += 1;
        // After the last entry is appended, another owner takes the batch.
        if (calls === 3) {
          await w.stores.lines.update(w.f.scope.projectId, BRANCH, (cur) =>
            cur?.batch === undefined
              ? undefined
              : { ...cur, batch: { ...cur.batch, generation: 2 } },
          );
        }
        return stored;
      });
      const refused = await call(w, "POST", lineUrl(w, BRANCH, "/settle"), body, me);
      expect(refused.status).toBe(409);
      expect(code(refused)).toBe("stale_generation");
      expect((await w.stores.events.listByRun(scope)).items).toHaveLength(3);
      const line = await reportOf(w, scope);
      expect(line?.compositions).toEqual([]);
      expect(line?.parked).toEqual([]);
      vi.restoreAllMocks();
    });

    it("a replacement owner settling the same batch differently is reported as itself, not the partial first attempt", async () => {
      const { w, me, body, scope } = await settled();
      const append = w.stores.events.append.bind(w.stores.events);
      let calls = 0;
      const spy = vi.spyOn(w.stores.events, "append").mockImplementation((event) => {
        calls += 1;
        if (calls === 3) return Promise.reject(new Error("store down"));
        return append(event);
      });
      const url = lineUrl(w, BRANCH, "/settle");
      expect((await call(w, "POST", url, body, me)).status).toBeGreaterThanOrEqual(500);
      spy.mockRestore();
      // The run is replaced: same run, generation 2, holding the same batch.
      const dispatch = await w.stores.dispatches.get({ ...scope });
      if (dispatch === undefined) throw new Error("no dispatch");
      await w.stores.dispatches.put({ ...dispatch, generation: 2 });
      const second = engineOf(w, scope.runId, { generation: 2 });
      const taken = await call(w, "POST", lineUrl(w, BRANCH, "/batch"), { generation: 2 }, second);
      expect((taken.body as { batch: { batchId: string } }).batch.batchId).toBe(body.batchId);
      const program = w.f.scope.programId;
      const replacement = {
        ...body,
        composition: { ...body.composition, commit: "c".repeat(40) },
        push: { ...body.push, head: "c".repeat(40) },
        parked: [{ ranges: [{ program, upTo: SHA_B }], reason: "moved main: different reason" }],
      };
      const settledAgain = await call(w, "POST", url, replacement, second);
      expect(settledAgain.status, JSON.stringify(settledAgain.body)).toBe(200);
      await evict(w);
      const line = await reportOf(w, scope);
      expect(line?.compositions.map((c) => c.commit)).toEqual(["c".repeat(40)]);
      expect(line?.parked.map((p) => p.reason)).toEqual(["moved main: different reason"]);
    });

    it("a marker append failing after the commit is a 5xx; the retry of the same body recovers and the entries outlive the record window", async () => {
      const { w, me, body, scope } = await settled();
      const append = w.stores.events.append.bind(w.stores.events);
      const spy = vi
        .spyOn(w.stores.events, "append")
        .mockImplementation((event) =>
          event.type === "line.settled" ? Promise.reject(new Error("store down")) : append(event),
        );
      const url = lineUrl(w, BRANCH, "/settle");
      const failed = await call(w, "POST", url, body, me);
      expect(failed.status).toBeGreaterThanOrEqual(500);
      const committed = await w.stores.lines.get(w.f.scope.projectId, BRANCH);
      expect(committed?.compositions).toHaveLength(1);
      spy.mockRestore();
      const retried = await call(w, "POST", url, body, me);
      expect(retried.status, JSON.stringify(retried.body)).toBe(200);
      const events = (await w.stores.events.listByRun(scope)).items;
      expect(events.filter((e) => e.type === "line.settled")).toHaveLength(1);
      expect(events).toHaveLength(4);
      await evict(w);
      const line = await reportOf(w, scope);
      expect(line?.compositions).toHaveLength(1);
      expect(line?.parked.map((p) => p.reason).sort()).toEqual(["budget", "conflict"]);
    });

    it("settles a parked entry with a ~13 KB reason (250 conflict paths and a 1500-char tail) and reports it whole after eviction", async () => {
      const { w, me, body, scope } = await settled();
      const program = w.f.scope.programId;
      const paths = Array.from(
        { length: 250 },
        (_, i) => `packages/area-${i}/src/deep/module-${i}.ts`,
      );
      const tail = `…${"E".repeat(1499)}`;
      const reason = `the merge conflicted in ${paths.join(", ")}; the resolver's attempt limit (3) was spent; last failure: ${tail}`;
      expect(new TextEncoder().encode(reason).length).toBeGreaterThan(MAX_INLINE_PAYLOAD_BYTES);
      const big = { ...body, parked: [{ ranges: [{ program, upTo: SHA_B }], reason }] };
      const response = await call(w, "POST", lineUrl(w, BRANCH, "/settle"), big, me);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const events = (await w.stores.events.listByRun(scope)).items;
      expect(events.some((e) => e.type === "line.entry_chunk")).toBe(true);
      await evict(w);
      const line = await reportOf(w, scope);
      expect(line?.parked.map((p) => p.reason)).toEqual([reason]);
    });

    it("appends no events for a refused settle", async () => {
      const { w, me, body, scope } = await settled();
      const url = lineUrl(w, BRANCH, "/settle");
      const stale = await call(w, "POST", url, { ...body, batchId: "nope" }, me);
      expect(stale.status).toBe(409);
      const notHolder = await call(
        w,
        "POST",
        url,
        body,
        engineOf(w, scope.runId, { generation: 2 }),
      );
      expect(notHolder.status).toBeGreaterThanOrEqual(400);
      expect((await w.stores.events.listByRun(scope)).items).toHaveLength(0);
    });

    it("keeps all 51 parked entries and their reasons as events, and the report lists them", async () => {
      const { w, me, body, scope } = await settled();
      const program = w.f.scope.programId;
      // A record already full, so the window truncates the settlement.
      await w.stores.lines.update(w.f.scope.projectId, BRANCH, (cur) =>
        cur === undefined
          ? undefined
          : {
              ...cur,
              parked: Array.from({ length: 50 }, (_, i) => ({
                compositionId: `old-${i}`,
                ranges: [{ program, upTo: SHA }],
                reason: "old",
                parkedAt: NOW,
              })),
            },
      );
      const many = {
        ...body,
        parked: Array.from({ length: 51 }, (_, i) => ({
          ranges: [{ program, upTo: SHA_B }],
          reason: `reason-${i}`,
        })),
      };
      expect((await call(w, "POST", lineUrl(w, BRANCH, "/settle"), many, me)).status).toBe(200);
      const events = (await w.stores.events.listByRun(scope)).items.filter(
        (e) => e.type === "line.parked",
      );
      expect(events).toHaveLength(51);
      expect(events.map((e) => (e.payload as { reason: string }).reason).sort()).toEqual(
        many.parked.map((p) => p.reason).sort(),
      );
      const record = await w.stores.lines.get(w.f.scope.projectId, BRANCH);
      expect(record?.parked).toHaveLength(50);
      await w.stores.executionNodes.put(makeRootNode(w.f, scope));
      const report = await gatherReport(w.stores, scope);
      const reasons = (report.line?.parked ?? []).map((p) => p.reason);
      for (const p of many.parked) expect(reasons).toContain(p.reason);
    });

    it("chunks an oversized composition whole, command results included", async () => {
      const { w, me, body, scope } = await settled();
      const commands = Array.from({ length: 200 }, (_, i) => ({
        stepId: `step-${i}`,
        command: `npm run step-${i} -- ${"x".repeat(60)}`,
        exitCode: i === 7 ? 1 : 0,
        durationMs: 1,
      }));
      const big = {
        ...body,
        composition: {
          ...body.composition,
          verification: makeLineVerification(w.f, { commands, outcome: "failed" }),
        },
      };
      expect((await call(w, "POST", lineUrl(w, BRANCH, "/settle"), big, me)).status).toBe(200);
      await w.stores.executionNodes.put(makeRootNode(w.f, scope));
      await w.stores.lines.update(w.f.scope.projectId, BRANCH, (cur) =>
        cur === undefined ? undefined : { ...cur, compositions: [], parked: [] },
      );
      const line = (await gatherReport(w.stores, scope)).line;
      const verification = line?.compositions[0]?.verification;
      expect(verification?.commands).toHaveLength(200);
    });
  });

  describe("settle asks the publisher", () => {
    const settleWorld = async () => {
      const w = await setup();
      const { me } = await seedLine(w, { queue: [entry(w)] });
      const taken = await call(w, "POST", lineUrl(w, BRANCH, "/batch"), { generation: 1 }, me);
      const batchId = (taken.body as { batch: { batchId: string } }).batch.batchId;
      const withPush = {
        batchId,
        composition: {
          commit: SHA_B,
          parent: SHA,
          ranges: [{ program: w.f.scope.programId, upTo: SHA }],
          verification: makeLineVerification(w.f),
        },
        push: { head: SHA_B, expectedPredecessor: SHA, bundleKey: "bundles/k" },
        parked: [],
      };
      return { w, me, batchId, withPush };
    };

    it("once for a settle that carries a push", async () => {
      const { w, me, withPush } = await settleWorld();
      const ok = await call(w, "POST", lineUrl(w, BRANCH, "/settle"), withPush, me);
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect(published).toEqual([BRANCH]);
    });

    it("not for a settle without a push", async () => {
      const { w, me, batchId } = await settleWorld();
      const parked = {
        ranges: [{ program: w.f.scope.programId, upTo: SHA }],
        reason: "conflict",
      };
      const ok = await call(
        w,
        "POST",
        lineUrl(w, BRANCH, "/settle"),
        { batchId, parked: [parked] },
        me,
      );
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect(published).toEqual([]);
    });

    it("still returns 200 with the push pending when the publisher throws", async () => {
      const { w, me, withPush } = await settleWorld();
      const failing: World = {
        ...w,
        deps: {
          ...w.deps,
          dispatcher: {
            provision: async () => undefined,
            publishLine: async () => {
              throw new Error("publisher down");
            },
          },
        },
      };
      const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        const ok = await call(failing, "POST", lineUrl(w, BRANCH, "/settle"), withPush, me);
        expect(ok.status, JSON.stringify(ok.body)).toBe(200);
        expect(spy).toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
      const record = await w.stores.lines.get(w.f.scope.projectId, BRANCH);
      expect(record?.push).toMatchObject({ head: SHA_B, status: "pending" });
    });
  });

  it("refuses to settle a composition while a different push is pending", async () => {
    const w = await setup();
    const { me } = await seedLine(w, { queue: [entry(w)] });
    const taken = await call(w, "POST", lineUrl(w, BRANCH, "/batch"), { generation: 1 }, me);
    const batchId = (taken.body as { batch: { batchId: string } }).batch.batchId;
    const other = {
      head: SHA,
      expectedPredecessor: SHA_B,
      bundleKey: "bundles/o",
    };
    expect((await call(w, "POST", lineUrl(w, BRANCH, "/push"), other, me)).status).toBe(200);
    const refused = await call(
      w,
      "POST",
      lineUrl(w, BRANCH, "/settle"),
      {
        batchId,
        composition: {
          commit: SHA_B,
          parent: SHA,
          ranges: [{ program: w.f.scope.programId, upTo: SHA }],
          verification: makeLineVerification(w.f),
        },
        push: { head: SHA_B, expectedPredecessor: SHA, bundleKey: "bundles/k" },
        parked: [],
      },
      me,
    );
    expect(refused.status).toBe(409);
    expect(code(refused)).toBe("conflict");
    expect((await w.stores.lines.get(w.f.scope.projectId, BRANCH))?.batch).toBeDefined();
  });

  it("records a pending push, then asks the publisher; another head is refused", async () => {
    const w = await setup();
    const { me } = await seedLine(w);
    const push = {
      head: SHA_B,
      expectedPredecessor: SHA,
      bundleKey: "k/1.pack",
    };
    const response = await call(w, "POST", lineUrl(w, BRANCH, "/push"), push, me);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const record = await w.stores.lines.get(w.f.scope.projectId, BRANCH);
    expect(record?.push).toMatchObject({
      head: SHA_B,
      status: "pending",
      generation: 1,
    });
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
    const { me } = await seedLine(w);
    const response = await call(
      w,
      "POST",
      lineUrl(w, BRANCH, "/bundle-upload-url"),
      { generation: 1, id: "01ABC" },
      me,
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const key = lineBundleObjectKey(w.f.scope.projectId, BRANCH, 1, "01ABC");
    expect(key).toBe(`${w.f.scope.projectId}/line/nightshift%2Fdevelop/1/01ABC.pack`);
    expect(w.signed).toEqual([key]);
    expect(response.body).toMatchObject({
      key,
      uploadUrl: expect.stringContaining(key),
    });
  });

  it("refuses an id that would leave its prefix, and a stale generation", async () => {
    const w = await setup();
    const { me } = await seedLine(w);
    const url = lineUrl(w, BRANCH, "/bundle-upload-url");
    expect((await call(w, "POST", url, { generation: 1, id: "../x" }, me)).status).toBe(400);
    expect((await call(w, "POST", url, { generation: 2, id: "ok" }, me)).status).toBe(409);
    expect(w.signed).toEqual([]);
  });
});

describe("GET the line's policy", () => {
  it("is the org's effective policy, and absent without an org config", async () => {
    const w = await setup();
    const { me } = await seedLine(w);
    const none = await call(w, "GET", lineUrl(w), undefined, me);
    expect((none.body as { policy?: unknown }).policy).toBeUndefined();
    await w.stores.orgConfigs.put({
      schemaVersion: 1,
      orgId: w.orgId,
      routingPolicy: DEFAULT_ROUTING_POLICY,
      examinationPolicy: DEFAULT_EXAMINATION_POLICY,
      installations: [],
      version: 1,
      updatedAt: NOW,
    } as never);
    const some = await call(w, "GET", lineUrl(w), undefined, me);
    expect(some.status, JSON.stringify(some.body)).toBe(200);
    expect((some.body as { policy: unknown }).policy).toMatchObject({
      routingPolicy: { roles: DEFAULT_ROUTING_POLICY.roles },
      examinationPolicy: DEFAULT_EXAMINATION_POLICY,
      orgConfigVersion: 1,
    });
  });
});

describe("a line run's engine token", () => {
  const settleBody = (w: World, batchId: string) => ({
    batchId,
    parked: [
      {
        ranges: [{ program: w.f.scope.programId, upTo: SHA }],
        reason: "conflict",
      },
    ],
  });
  const pushBody = {
    head: SHA_B,
    expectedPredecessor: SHA,
    bundleKey: "bundles/k",
  };

  const world = async () => {
    const w = await setup();
    await seedLineRecords(w, { queue: [entry(w)] });
    return w;
  };

  const writes = (w: World, batchId: string) =>
    [
      ["POST", lineUrl(w, BRANCH, "/batch"), { generation: 1 }],
      ["POST", lineUrl(w, BRANCH, "/settle"), settleBody(w, batchId)],
      ["POST", lineUrl(w, BRANCH, "/push"), pushBody],
      ["POST", lineUrl(w, BRANCH, "/bundle-upload-url"), { generation: 1, id: "b1" }],
    ] as const;

  it("is served its own line, and refused once its run has ended", async () => {
    const w = await world();
    const runId = await startRun(w);
    const me = engineOf(w, runId);
    expect((await call(w, "GET", lineUrl(w), undefined, me)).status).toBe(200);
    const taken = await call(w, "POST", lineUrl(w, BRANCH, "/batch"), { generation: 1 }, me);
    expect(taken.status, JSON.stringify(taken.body)).toBe(200);
    const batch = (
      taken.body as {
        batch: { batchId: string; runId?: string; generation: number };
      }
    ).batch;
    expect(batch).toMatchObject({ runId, generation: 1 });
    expect((await call(w, "POST", lineUrl(w, BRANCH, "/push"), pushBody, me)).status).toBe(200);
    const url = await call(
      w,
      "POST",
      lineUrl(w, BRANCH, "/bundle-upload-url"),
      { generation: 1, id: "b1" },
      me,
    );
    expect(url.status, JSON.stringify(url.body)).toBe(200);
    await endRun(w, runId);
    for (const [method, path, body] of writes(w, batch.batchId)) {
      expect((await call(w, method, path, body, me)).status, path).toBe(403);
    }
    expect((await call(w, "GET", lineUrl(w), undefined, me)).status).toBe(200);
  });

  it("refuses a body generation that is not its dispatch's", async () => {
    const w = await world();
    const me = engineOf(w, await startRun(w));
    const response = await call(w, "POST", lineUrl(w, BRANCH, "/batch"), { generation: 2 }, me);
    expect(response.status).toBe(409);
    expect(code(response)).toBe("stale_generation");
  });

  it("is refused another branch of its project", async () => {
    const w = await world();
    const me = engineOf(w, await startRun(w));
    const response = await call(
      w,
      "POST",
      lineUrl(w, "nightshift/other", "/batch"),
      { generation: 1 },
      me,
    );
    expect(response.status).toBe(403);
  });

  it("lets run B take back the batch run A held, and fences A out", async () => {
    const w = await world();
    const a = await startRun(w);
    const first = await call(
      w,
      "POST",
      lineUrl(w, BRANCH, "/batch"),
      { generation: 1 },
      engineOf(w, a),
    );
    const batchId = (first.body as { batch: { batchId: string } }).batch.batchId;
    await endRun(w, a);
    const b = await startRun(w);
    const meB = engineOf(w, b);
    for (const [method, path, body] of writes(w, batchId)) {
      expect((await call(w, method, path, body, engineOf(w, a))).status, path).toBe(403);
    }
    const retaken = await call(w, "POST", lineUrl(w, BRANCH, "/batch"), { generation: 1 }, meB);
    expect(retaken.status, JSON.stringify(retaken.body)).toBe(200);
    expect(retaken.body).toMatchObject({
      batch: { batchId, runId: b, generation: 1 },
    });
    const settled = await call(
      w,
      "POST",
      lineUrl(w, BRANCH, "/settle"),
      settleBody(w, batchId),
      meB,
    );
    expect(settled.status, JSON.stringify(settled.body)).toBe(200);
  });

  it("is not granted to a non-line program's engine of the same project", async () => {
    const w = await world();
    const runId = await startRun(w, w.f.scope.programId);
    const me = engineOf(w, runId, { programId: w.f.scope.programId });
    for (const [method, path, body] of writes(w, "x")) {
      expect((await call(w, method, path, body, me)).status, path).toBe(403);
    }
    expect((await call(w, "GET", lineUrl(w), undefined, me)).status).toBe(403);
  });

  it("is not granted to the other execution roles", async () => {
    const w = await world();
    const runId = await startRun(w);
    for (const role of ["orchestrator", "worker", "examiner", "arbiter"]) {
      const me = engineOf(w, runId, { role });
      expect((await call(w, "GET", lineUrl(w), undefined, me)).status, role).toBe(403);
      for (const [method, path, body] of writes(w, "x")) {
        expect((await call(w, method, path, body, me)).status, `${role} ${path}`).toBe(403);
      }
    }
  });
});

describe("users and the line", () => {
  it("may read the line of their own org, and are refused every write", async () => {
    const w = await setup();
    await seedLine(w, { queue: [entry(w)] });
    expect((await call(w, "GET", lineUrl(w))).status).toBe(200);
    for (const [path, body] of [
      ["/batch", { generation: 1 }],
      ["/settle", { batchId: "x", parked: [] }],
      ["/push", { head: SHA_B, expectedPredecessor: SHA, bundleKey: "bundles/k" }],
      ["/bundle-upload-url", { generation: 1, id: "b1" }],
    ] as const) {
      expect((await call(w, "POST", lineUrl(w, BRANCH, path), body)).status, path).toBe(403);
    }
  });

  it("of another org are refused the read", async () => {
    const w = await setup();
    await seedLine(w);
    const stranger = nextUserId(w.f);
    await w.stores.memberships.put(makeMembership(stranger, w.f.ids.next("org")));
    const me: RequestPrincipal = { kind: "user", userId: stranger };
    expect((await call(w, "GET", lineUrl(w), undefined, me)).status).toBe(403);
    expect(
      (await call(w, "POST", lineUrl(w, BRANCH, "/batch"), { generation: 1 }, me)).status,
    ).toBe(403);
  });
});
