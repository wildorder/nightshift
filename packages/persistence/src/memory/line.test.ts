import type { LineDispatch, LineRecord, ProgramId } from "@nightshift/contracts";
import {
  appendQueueEntry,
  createFixtures,
  lineAdmission,
  makeLineDispatch,
  makeLineRecord,
  makeProject,
  meterProjectUsage,
} from "@nightshift/core";
import { describe, expect, it } from "vitest";
import { createInMemoryStores } from "./index.js";

const BRANCH = "nightshift/develop";
const OTHER_BRANCH = "nightshift/other";
const NOW = Date.parse("2026-10-27T10:00:00.000Z");
const clock = { now: () => NOW };
const MONTH = "2026-10";
const A = "a".repeat(40);

const world = () => {
  const f = createFixtures();
  const stores = createInMemoryStores();
  return { f, stores, projectId: f.scope.projectId };
};

describe("lines.update", () => {
  it("creates when absent, stamps the version, and ignores an unchanged answer", async () => {
    const { f, stores, projectId } = world();
    expect(await stores.lines.get(projectId, BRANCH)).toBeUndefined();
    expect(await stores.lines.update(projectId, BRANCH, () => undefined)).toBeUndefined();
    const created = await stores.lines.update(projectId, BRANCH, () => makeLineRecord(f));
    expect(created?.version).toBe(1);
    const same = await stores.lines.update(projectId, BRANCH, () => undefined);
    expect(same?.version).toBe(1);
    const next = await stores.lines.update(projectId, BRANCH, (current) => ({
      ...(current as LineRecord),
      head: A,
    }));
    expect(next).toMatchObject({ version: 2, head: A });
    expect(await stores.lines.get(projectId, BRANCH)).toEqual(next);
  });

  it("applies two concurrent updates, both of them", async () => {
    const { f, stores, projectId } = world();
    await stores.lines.update(projectId, BRANCH, () => makeLineRecord(f));
    const program = f.ids.next("prog") as ProgramId;
    const other = f.ids.next("prog") as ProgramId;
    await Promise.all([
      stores.lines.update(projectId, BRANCH, (current) =>
        appendQueueEntry(
          current as LineRecord,
          { program, upTo: A as never },
          "2026-10-27T10:00:00.000Z",
        ),
      ),
      stores.lines.update(projectId, BRANCH, (current) =>
        appendQueueEntry(
          current as LineRecord,
          { program: other, upTo: A as never },
          "2026-10-27T10:00:00.000Z",
        ),
      ),
    ]);
    const stored = await stores.lines.get(projectId, BRANCH);
    expect(stored?.queue.map((entry) => entry.program).sort()).toEqual([program, other].sort());
    expect(stored?.version).toBe(3);
  });

  it("keeps one project's lines and one branch's apart", async () => {
    const { f, stores, projectId } = world();
    const elsewhere = createFixtures();
    await stores.lines.update(projectId, BRANCH, () => makeLineRecord(f));
    expect(await stores.lines.get(projectId, OTHER_BRANCH)).toBeUndefined();
    expect(await stores.lines.get(elsewhere.scope.projectId, BRANCH)).toBeUndefined();
  });

  it("lists, across projects, exactly the lines that have work", async () => {
    const { f, stores, projectId } = world();
    const elsewhere = createFixtures();
    const program = f.ids.next("prog") as ProgramId;
    await stores.lines.update(projectId, BRANCH, () => makeLineRecord(f));
    await stores.lines.update(projectId, OTHER_BRANCH, () =>
      appendQueueEntry(
        makeLineRecord(f, { branch: OTHER_BRANCH }),
        { program, upTo: A as never },
        "2026-10-27T10:00:00.000Z",
      ),
    );
    await stores.lines.update(elsewhere.scope.projectId, BRANCH, () =>
      appendQueueEntry(
        makeLineRecord(elsewhere),
        { program, upTo: A as never },
        "2026-10-27T10:00:00.000Z",
      ),
    );
    const withWork = await stores.lines.listWithWork();
    expect(withWork.map((line) => `${line.projectId}/${line.branch}`).sort()).toEqual(
      [`${projectId}/${OTHER_BRANCH}`, `${elsewhere.scope.projectId}/${BRANCH}`].sort(),
    );
  });
});

describe("lineDispatches.start", () => {
  const settle = (
    dispatch: LineDispatch,
    status: "stopped" | "failed" = "stopped",
  ): LineDispatch => ({
    ...dispatch,
    status,
    cleanup: { ...dispatch.cleanup, settledAt: "2026-10-27T11:00:00.000Z" },
  });

  it("stores the first dispatch, and exactly one of two concurrent starts", async () => {
    const { f, stores, projectId } = world();
    const results = await Promise.all([
      stores.lineDispatches.start(makeLineDispatch(f)),
      stores.lineDispatches.start(makeLineDispatch(f)),
    ]);
    expect(results.filter((result) => result === "started")).toHaveLength(1);
    expect(results.filter((result) => result === "live")).toHaveLength(1);
    expect((await stores.lineDispatches.get(projectId, BRANCH))?.version).toBe(1);
  });

  it("answers live while the stored dispatch is not terminal", async () => {
    const { f, stores, projectId } = world();
    const first = makeLineDispatch(f);
    await stores.lineDispatches.start(first);
    for (const status of ["requested", "provisioning", "ready", "running", "stopping"] as const) {
      await stores.lineDispatches.update(projectId, BRANCH, (current) => ({ ...current, status }));
      expect(await stores.lineDispatches.start(makeLineDispatch(f, { generation: 2 }))).toBe(
        "live",
      );
    }
    expect((await stores.lineDispatches.get(projectId, BRANCH))?.generation).toBe(1);
  });

  it("answers live while a terminal dispatch's cleanup has not settled", async () => {
    const { f, stores, projectId } = world();
    await stores.lineDispatches.start(makeLineDispatch(f));
    await stores.lineDispatches.update(projectId, BRANCH, (current) => ({
      ...current,
      status: "failed",
    }));
    expect(await stores.lineDispatches.start(makeLineDispatch(f, { generation: 2 }))).toBe("live");
    await stores.lineDispatches.update(projectId, BRANCH, (current) => ({
      ...current,
      status: "stopped",
    }));
    expect(await stores.lineDispatches.start(makeLineDispatch(f, { generation: 2 }))).toBe("live");
  });

  it("after a settled one needs the generation to be exactly the next", async () => {
    for (const status of ["stopped", "failed"] as const) {
      const { f, stores, projectId } = world();
      const first = makeLineDispatch(f);
      await stores.lineDispatches.start(first);
      await stores.lineDispatches.update(projectId, BRANCH, (current) => settle(current, status));
      expect(await stores.lineDispatches.start(makeLineDispatch(f, { generation: 1 }))).toBe(
        "live",
      );
      expect(await stores.lineDispatches.start(makeLineDispatch(f, { generation: 3 }))).toBe(
        "live",
      );
      expect(await stores.lineDispatches.start(makeLineDispatch(f, { generation: 2 }))).toBe(
        "started",
      );
      const stored = await stores.lineDispatches.get(projectId, BRANCH);
      expect(stored).toMatchObject({ generation: 2, status: "requested" });
      expect(stored?.version).toBeGreaterThan(1);
    }
  });

  it("updates by compare-and-swap, listing by status", async () => {
    const { f, stores, projectId } = world();
    expect(await stores.lineDispatches.update(projectId, BRANCH, (c) => c)).toBeUndefined();
    await stores.lineDispatches.start(makeLineDispatch(f));
    const [one, two] = await Promise.all([
      stores.lineDispatches.update(projectId, BRANCH, (current) => ({
        ...current,
        instanceId: "i-1",
      })),
      stores.lineDispatches.update(projectId, BRANCH, (current) => ({
        ...current,
        spend: { ...current.spend, meteredSeconds: current.spend.meteredSeconds + 20 },
      })),
    ]);
    expect([one?.version, two?.version].sort()).toEqual([2, 3]);
    const stored = await stores.lineDispatches.get(projectId, BRANCH);
    expect(stored).toMatchObject({ instanceId: "i-1", version: 3 });
    expect(stored?.spend.meteredSeconds).toBe(20);
    expect(await stores.lineDispatches.listByStatus(["requested"])).toHaveLength(1);
    expect(await stores.lineDispatches.listByStatus(["running", "ready"])).toHaveLength(0);
  });
});

describe("projectSelfStartedUsage", () => {
  it("is read by get, and written by compare-and-swap per month", async () => {
    const { stores, projectId } = world();
    expect(await stores.projectSelfStartedUsage.get(projectId, MONTH)).toBeUndefined();
    await Promise.all(
      [3, 4].map((deltaUsd) =>
        stores.projectSelfStartedUsage.update(projectId, MONTH, (current) =>
          meterProjectUsage(
            current,
            { projectId, month: MONTH, deltaUsd, capUsd: 25 },
            "2026-10-27T10:00:00.000Z",
          ),
        ),
      ),
    );
    expect(await stores.projectSelfStartedUsage.get(projectId, MONTH)).toMatchObject({
      meteredUsd: 7,
      version: 2,
    });
    expect(await stores.projectSelfStartedUsage.get(projectId, "2026-11")).toBeUndefined();
  });
});

describe("lineAdmission", () => {
  const setup = async () => {
    const { f, stores, projectId } = world();
    const project = makeProject(f);
    await stores.projects.put(project);
    await stores.lines.update(projectId, BRANCH, () => makeLineRecord(f, { projectId }));
    await stores.lines.update(projectId, OTHER_BRANCH, () =>
      makeLineRecord(f, { projectId, branch: OTHER_BRANCH }),
    );
    return { f, stores, project, projectId };
  };

  it("reads the ledgers by get alone", async () => {
    const { stores, projectId, project } = await setup();
    const calls: string[] = [];
    const spy = {
      orgConfigs: {
        ...stores.orgConfigs,
        get: async (id: never) => (calls.push("orgConfigs.get"), stores.orgConfigs.get(id)),
      },
      computeLedger: {
        ...stores.computeLedger,
        get: async (id: never, month: string) => (
          calls.push("computeLedger.get"), stores.computeLedger.get(id, month)
        ),
      },
      projectSelfStartedUsage: {
        ...stores.projectSelfStartedUsage,
        get: async (id: never, month: string) => (
          calls.push("usage.get"), stores.projectSelfStartedUsage.get(id, month)
        ),
      },
    };
    expect(
      await lineAdmission(
        { stores: spy, clock },
        { projectId, branch: BRANCH, capUsd: 25, orgId: project.orgId },
      ),
    ).toEqual({ ok: true });
    expect(calls.sort()).toEqual(["computeLedger.get", "orgConfigs.get", "usage.get"]);
  });
});
