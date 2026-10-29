/**
 * A run of the line program (Pipkin): started through the dispatch route's own
 * admission, metered against the project's cap, and tagged on its machine.
 */
import { generateKeyPairSync, sign as signWith } from "node:crypto";
import {
  calendarMonthOf,
  DEFAULT_COMPUTE_CEILINGS,
  defaultOrgConfig,
  emptyComputeUsage,
  type OrgId,
  type ProgramContract,
} from "@nightshift/contracts";
import {
  chargeDispatchUsage,
  createFixedClock,
  createFixtures,
  dispatchChargeKey,
  type Fixtures,
  type GitHubAppClient,
  lineProgramId,
  makeDispatch,
  makeLineRecord,
  makeMembership,
  makeProgramContract,
  makeProject,
  makeRun,
  nextUserId,
} from "@nightshift/core";
import { createInMemoryStores, type InMemoryStores } from "@nightshift/persistence/memory";
import { describe, expect, it } from "vitest";
import type { RequestPrincipal } from "../auth/principal.js";
import { handleRequest } from "../handler.js";
import type { ApiDeps } from "../http.js";
import { startLineRun } from "./line-run.js";
import { machineTags } from "./provision.js";

const NOW = "2026-10-01T12:00:00.000Z";
const MONTH = calendarMonthOf(NOW);
const SHA = "a".repeat(40);
const BRANCH = "nightshift/develop";
const REPOSITORY = "wildorder/fixture";

const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });

interface World {
  readonly stores: InMemoryStores;
  readonly deps: ApiDeps;
  readonly f: Fixtures;
  readonly orgId: OrgId;
  readonly naming: ProgramContract;
  readonly provisions: string[];
  readonly principal: RequestPrincipal;
}

/** `lineHead`: where the line ref stands at GitHub, absent while it has not been pushed. */
const setup = async (lineHead?: string, monthlyUsd?: number): Promise<World> => {
  const stores = createInMemoryStores();
  const f = createFixtures();
  const orgId = f.ids.next("org");
  const subject = nextUserId(f);
  await stores.memberships.put(makeMembership(subject, orgId));
  await stores.projects.put(makeProject(f, { orgId }));
  await stores.orgConfigs.put({
    ...defaultOrgConfig(orgId, NOW),
    version: 1,
    installations: [
      { installationId: 1, account: "wildorder", repositories: [REPOSITORY], recordedAt: NOW },
    ],
  });
  const naming = makeProgramContract(f, {
    repository: {
      url: `https://github.com/${REPOSITORY}`,
      baseBranch: "main",
      programBranch: "program/fixture",
    },
    line: { branch: BRANCH, ...(monthlyUsd === undefined ? {} : { monthlyUsd }) },
  });
  await stores.lines.update(f.scope.projectId, BRANCH, () =>
    makeLineRecord(f, { repositoryUrl: naming.repository.url }),
  );
  const github = {
    branchHead: async (_id: number, _repository: string, branch: string) =>
      branch === BRANCH ? lineHead : branch === "main" ? SHA : undefined,
    readToken: async () => ({ token: "t", expiresAt: NOW }),
  } as unknown as GitHubAppClient;
  const provisions: string[] = [];
  return {
    stores,
    f,
    orgId,
    naming,
    provisions,
    principal: { kind: "user", userId: subject },
    deps: {
      stores,
      clock: createFixedClock(Date.parse(NOW)),
      github,
      dispatcher: {
        provision: async (scope: { runId: string }) => void provisions.push(scope.runId),
      } as never,
      tokens: {
        issuer: "https://api.test.nightshift.invalid",
        signer: { sign: async (input) => signWith("sha256", input, keys.privateKey) },
      },
    },
  };
};

const start = (w: World) =>
  startLineRun(w.deps, { projectId: w.f.scope.projectId, branch: BRANCH, naming: w.naming });

const runsOfLine = async (w: World) =>
  (
    await w.stores.runs.listByProgram({
      projectId: w.f.scope.projectId,
      programId: lineProgramId(w.f.scope.projectId, BRANCH),
    })
  ).items;

describe("startLineRun", () => {
  it("makes the line program once and starts a run of it with a dispatch", async () => {
    const w = await setup();
    const result = await start(w);
    expect(result.kind).toBe("started");
    if (result.kind !== "started") return;
    const programId = lineProgramId(w.f.scope.projectId, BRANCH);
    const program = await w.stores.programContracts.get(w.f.scope.projectId, programId);
    expect(program?.kind).toBe("line");
    const scope = { projectId: w.f.scope.projectId, programId, runId: result.runId };
    const run = await w.stores.runs.get(scope, result.runId);
    expect(run).toMatchObject({ status: "pending", location: "remote" });
    const dispatch = await w.stores.dispatches.get(scope);
    // The line ref does not exist yet: the base branch's head is where it starts.
    expect(dispatch).toMatchObject({
      status: "requested",
      input: { branch: BRANCH, baseSha: SHA },
    });
    expect(w.provisions).toEqual([result.runId]);
  });

  it("starts from the line ref's head when the ref exists", async () => {
    const head = "c".repeat(40);
    const w = await setup(head);
    const result = await start(w);
    expect(result.kind).toBe("started");
    const [run] = await runsOfLine(w);
    const dispatch = await w.stores.dispatches.get({
      projectId: w.f.scope.projectId,
      programId: lineProgramId(w.f.scope.projectId, BRANCH),
      runId: run?.runId as never,
    });
    expect(dispatch?.input.baseSha).toBe(head);
  });

  it("answers live while a line run is live, creating no run and no dispatch", async () => {
    const w = await setup();
    const first = await start(w);
    expect(first.kind).toBe("started");
    const second = await start(w);
    expect(second.kind).toBe("live");
    expect(await runsOfLine(w)).toHaveLength(1);
    expect(await w.stores.dispatches.listByStatus(["requested"])).toHaveLength(1);
    expect(w.provisions).toHaveLength(1);
  });

  const refused = async (w: World, reason: string) => {
    const result = await start(w);
    expect(result).toMatchObject({ kind: "waiting", reason });
    const runs = await runsOfLine(w);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("interrupted");
    expect(runs[0]?.outcomeReason).toContain("the dispatch was refused");
    expect(await w.stores.dispatches.listByStatus(["requested"])).toHaveLength(0);
    expect((await w.stores.lines.get(w.f.scope.projectId, BRANCH))?.waiting?.reason).toBe(reason);
    // The program is free for the next start.
    expect(w.provisions).toHaveLength(0);
  };

  it("is refused at the project's self-started cap", async () => {
    const w = await setup(undefined, 10);
    await w.stores.projectSelfStartedUsage.update(w.f.scope.projectId, MONTH, () =>
      chargeDispatchUsage(
        undefined,
        {
          projectId: w.f.scope.projectId,
          month: MONTH,
          capUsd: 10,
          key: "other#1",
          dispatchUsd: 10,
          baselineUsd: 0,
        },
        NOW,
      ),
    );
    await refused(w, "monthly_cap");
  });

  it("is refused at the org's monthly ceiling", async () => {
    const w = await setup();
    const empty = emptyComputeUsage(w.orgId, MONTH, NOW);
    await w.stores.computeLedger.put({ ...empty, meteredUsd: 1_000_000 });
    await refused(w, "org_month_ceiling");
  });

  it("is refused at maxConcurrentRuns like any run", async () => {
    const w = await setup();
    const config = (await w.stores.orgConfigs.get(w.orgId)) ?? defaultOrgConfig(w.orgId, NOW);
    await w.stores.orgConfigs.put({
      ...config,
      version: config.version + 1,
      compute: { ...DEFAULT_COMPUTE_CEILINGS, maxConcurrentRuns: 1 },
    });
    const other = w.f.ids.next("run") as never;
    await w.stores.runs.put(makeRun(w.f, { runId: other, status: "pending", location: "remote" }));
    await w.stores.dispatches.put(makeDispatch(w.f, { runId: other, status: "running" }));
    await refused(w, "org_concurrency");
  });
});

describe("a line run's heartbeat", () => {
  const live = async (w: World) => {
    const started = await start(w);
    if (started.kind !== "started") throw new Error("not started");
    const scope = {
      projectId: w.f.scope.projectId,
      programId: lineProgramId(w.f.scope.projectId, BRANCH),
      runId: started.runId,
    };
    const dispatch = await w.stores.dispatches.get(scope);
    if (dispatch === undefined) throw new Error("no dispatch");
    await w.stores.dispatches.put({
      ...dispatch,
      status: "running",
      instanceId: "i-1",
      volumeId: "vol-1",
    });
    return { scope, dispatch };
  };
  const beat = (w: World, scope: { programId: string; runId: string }, seconds: number) =>
    handleRequest(w.deps, {
      method: "POST",
      path: `/projects/${w.f.scope.projectId}/programs/${scope.programId}/runs/${scope.runId}/dispatch/heartbeat`,
      query: {},
      body: {
        generation: 1,
        meteredSeconds: seconds,
        samples: [{ memoryPct: 1, cpuPct: 1, diskPct: 1, swapUsed: false, oomKills: 0 }],
      },
      principal: w.principal,
    });

  it("charges the project's usage idempotently, and stops the run at the cap", async () => {
    const w = await setup(undefined, 0.5);
    const { scope, dispatch } = await live(w);
    const key = dispatchChargeKey(BRANCH, scope.runId);
    const first = await beat(w, scope, 60);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const usageAfterFirst = await w.stores.projectSelfStartedUsage.get(w.f.scope.projectId, MONTH);
    const charged = usageAfterFirst?.charged?.[key];
    expect(charged).toBeGreaterThan(0);
    expect((first.body as { stop: boolean }).stop).toBe(false);
    // The same beat again charges nothing more.
    await beat(w, scope, 60);
    const again = await w.stores.projectSelfStartedUsage.get(w.f.scope.projectId, MONTH);
    expect(again?.meteredUsd).toBe(usageAfterFirst?.meteredUsd);
    expect(again?.charged?.[key]).toBe(charged);
    // Enough time to cross the $0.50 cap.
    const hours = 0.5 / dispatch.usdPerHour;
    const over = await beat(w, scope, Math.ceil(hours * 3600) + 600);
    expect((over.body as { stop: boolean }).stop).toBe(true);
    const stopped = await w.stores.dispatches.get(scope);
    expect(stopped?.status).toBe("stopping");
    expect(stopped?.failure?.code).toBe("line_cap");
    expect((await w.stores.lines.get(w.f.scope.projectId, BRANCH))?.waiting?.reason).toBe(
      "monthly_cap",
    );
  });
});

describe("a line run's machine", () => {
  it("carries the nightshift:line tag beside the usual ones", async () => {
    const w = await setup();
    const started = await start(w);
    if (started.kind !== "started") throw new Error("not started");
    const dispatch = await w.stores.dispatches.get({
      projectId: w.f.scope.projectId,
      programId: lineProgramId(w.f.scope.projectId, BRANCH),
      runId: started.runId,
    });
    if (dispatch === undefined) throw new Error("no dispatch");
    const tags = machineTags(dispatch, "dev", "https://api", dispatch.input.branch);
    expect(tags["nightshift:line"]).toBe(BRANCH);
    expect(tags["nightshift:managed"]).toBe("true");
    expect(tags["nightshift-run"]).toBe(started.runId);
  });
});
