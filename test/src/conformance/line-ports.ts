/**
 * The project-line port conformance suite (Pipkin M1b, S-02): `LineStore`,
 * `LineDispatchStore` and `ProjectSelfStartedUsageStore`, run against every
 * adapter beside `persistence-ports.ts`.
 */
import type { CalendarMonth, IsoTimestamp, LineDispatch } from "@nightshift/contracts";
import {
  createCountingIdGenerator,
  createFixtures,
  FIXTURE_COMMIT,
  type Fixtures,
  makeLineDispatch,
  makeLineRecord,
  type ProjectStores,
} from "@nightshift/core";
import { beforeEach, describe, expect, it } from "vitest";
import type { StoresFactory } from "./persistence-ports.js";

const AT = "2026-01-01T00:00:00.000Z" as IsoTimestamp;
const LATER = "2026-01-01T00:05:00.000Z" as IsoTimestamp;
const MONTH = "2026-01" as CalendarMonth;
const BRANCH = "nightshift/develop";

const entry = (f: Fixtures, upTo = FIXTURE_COMMIT) => ({
  program: f.scope.programId,
  upTo,
  enqueuedAt: AT,
});

export const describeLinePortConformance = <S extends ProjectStores>(
  name: string,
  factory: StoresFactory<S>,
): void => {
  describe(`${name} — line port conformance`, () => {
    let stores: S;
    let a: Fixtures;
    let b: Fixtures;

    beforeEach(async () => {
      let at = Date.parse(AT);
      stores = await factory({
        now: () => new Date(at).toISOString() as IsoTimestamp,
        set: (value) => {
          at = Date.parse(value);
        },
        advance: (ms) => {
          at += ms;
        },
      });
      const ids = createCountingIdGenerator();
      a = createFixtures(ids);
      b = createFixtures(ids);
    });

    const settledStopped = (f: Fixtures, generation: number, overrides = {}): LineDispatch =>
      makeLineDispatch(f, {
        status: "stopped",
        generation,
        cleanup: { volumeDeleted: true, failures: [], settledAt: AT },
        ...overrides,
      });

    describe("lines", () => {
      it("creates, reads and versions a line", async () => {
        const projectId = a.scope.projectId;
        expect(await stores.lines.get(projectId, BRANCH)).toBeUndefined();
        const created = await stores.lines.update(projectId, BRANCH, () => makeLineRecord(a));
        expect(created?.version).toBe(1);
        const next = await stores.lines.update(projectId, BRANCH, (current) =>
          current === undefined ? undefined : { ...current, updatedAt: LATER },
        );
        expect(next?.version).toBe(2);
        expect(await stores.lines.get(projectId, BRANCH)).toEqual(next);
      });

      it("changes nothing when the change returns undefined", async () => {
        const projectId = a.scope.projectId;
        expect(await stores.lines.update(projectId, BRANCH, () => undefined)).toBeUndefined();
        const created = await stores.lines.update(projectId, BRANCH, () => makeLineRecord(a));
        expect(await stores.lines.update(projectId, BRANCH, () => undefined)).toEqual(created);
        expect((await stores.lines.get(projectId, BRANCH))?.version).toBe(1);
      });

      it("keeps every concurrent update, re-reading on a lost race", async () => {
        const projectId = a.scope.projectId;
        await stores.lines.update(projectId, BRANCH, () => makeLineRecord(a));
        await Promise.all(
          Array.from({ length: 6 }, (_, i) =>
            stores.lines.update(projectId, BRANCH, (current) =>
              current === undefined
                ? undefined
                : {
                    ...current,
                    queue: [...current.queue, entry(a, FIXTURE_COMMIT)].map((e, n) => ({
                      ...e,
                      enqueuedAt: new Date(
                        Date.parse(AT) + (n + i) * 1000,
                      ).toISOString() as IsoTimestamp,
                    })),
                  },
            ),
          ),
        );
        const stored = await stores.lines.get(projectId, BRANCH);
        expect(stored?.version).toBe(7);
        expect(stored?.queue).toHaveLength(6);
      });

      it("creates a line once when two creations race", async () => {
        const projectId = a.scope.projectId;
        let created = 0;
        await Promise.all(
          [0, 1].map(() =>
            stores.lines.update(projectId, BRANCH, (current) => {
              if (current !== undefined) return current;
              created += 1;
              return makeLineRecord(a);
            }),
          ),
        );
        expect((await stores.lines.get(projectId, BRANCH))?.version).toBe(2);
        expect(created).toBeGreaterThanOrEqual(1);
      });

      it("lists exactly the lines with work, and drops one that has none", async () => {
        const queued = makeLineRecord(a, { queue: [entry(a)] });
        const batched = makeLineRecord(b, {
          batch: { batchId: "b1", entries: [entry(b)], takenAt: AT, generation: 1 },
        });
        const pushing = makeLineRecord(a, {
          push: {
            head: FIXTURE_COMMIT,
            expectedPredecessor: FIXTURE_COMMIT,
            bundleKey: "k",
            generation: 1,
            status: "pending",
            requestedAt: AT,
          },
        });
        const idle = makeLineRecord(b);
        const resolved = makeLineRecord(b, {
          push: {
            head: FIXTURE_COMMIT,
            expectedPredecessor: FIXTURE_COMMIT,
            bundleKey: "k",
            generation: 1,
            status: "published",
            requestedAt: AT,
            resolvedAt: AT,
          },
        });
        await stores.lines.update(a.scope.projectId, "line/queued", () => queued);
        await stores.lines.update(b.scope.projectId, "line/batched", () => batched);
        await stores.lines.update(a.scope.projectId, "line/pushing", () => pushing);
        await stores.lines.update(b.scope.projectId, "line/idle", () => idle);
        await stores.lines.update(b.scope.projectId, "line/resolved", () => resolved);

        const names = async () =>
          (await stores.lines.listWithWork()).map((line) => line.branch).sort();
        expect(await names()).toEqual(["line/batched", "line/pushing", "line/queued"]);

        await stores.lines.update(a.scope.projectId, "line/queued", (current) =>
          current === undefined ? undefined : { ...current, queue: [] },
        );
        expect(await names()).toEqual(["line/batched", "line/pushing"]);
        await stores.lines.update(b.scope.projectId, "line/batched", (current) =>
          current === undefined ? undefined : { ...current, batch: undefined },
        );
        expect(await names()).toEqual(["line/pushing"]);
      });

      it("keeps one project's line apart from another's", async () => {
        await stores.lines.update(a.scope.projectId, BRANCH, () => makeLineRecord(a));
        expect(await stores.lines.get(b.scope.projectId, BRANCH)).toBeUndefined();
      });
    });

    describe("line dispatches", () => {
      it("starts a dispatch and reads it back", async () => {
        const dispatch = makeLineDispatch(a);
        expect(await stores.lineDispatches.get(a.scope.projectId, BRANCH)).toBeUndefined();
        expect(await stores.lineDispatches.start(dispatch)).toBe("started");
        expect(await stores.lineDispatches.get(a.scope.projectId, BRANCH)).toEqual(dispatch);
      });

      it("answers started for exactly one of two concurrent starts", async () => {
        const answers = await Promise.all([
          stores.lineDispatches.start(makeLineDispatch(a)),
          stores.lineDispatches.start(makeLineDispatch(a)),
        ]);
        expect([...answers].sort()).toEqual(["live", "started"]);
      });

      it("answers live while the stored dispatch is not terminal", async () => {
        await stores.lineDispatches.start(makeLineDispatch(a, { status: "running" }));
        expect(await stores.lineDispatches.start(makeLineDispatch(a, { generation: 2 }))).toBe(
          "live",
        );
        expect((await stores.lineDispatches.get(a.scope.projectId, BRANCH))?.generation).toBe(1);
      });

      it("answers live for a terminal dispatch whose cleanup has not settled", async () => {
        await stores.lineDispatches.start(makeLineDispatch(a, { status: "failed" }));
        expect(await stores.lineDispatches.start(makeLineDispatch(a, { generation: 2 }))).toBe(
          "live",
        );
        await stores.lineDispatches.start(makeLineDispatch(b, { status: "stopped" }));
        expect(await stores.lineDispatches.start(makeLineDispatch(b, { generation: 2 }))).toBe(
          "live",
        );
      });

      it("starts after a settled terminal dispatch only at generation prev+1", async () => {
        await stores.lineDispatches.start(settledStopped(a, 1));
        expect(await stores.lineDispatches.start(makeLineDispatch(a, { generation: 1 }))).toBe(
          "live",
        );
        expect(await stores.lineDispatches.start(makeLineDispatch(a, { generation: 3 }))).toBe(
          "live",
        );
        const next = makeLineDispatch(a, { generation: 2 });
        expect(await stores.lineDispatches.start(next)).toBe("started");
        const stored = await stores.lineDispatches.get(a.scope.projectId, BRANCH);
        expect(stored?.generation).toBe(2);
        expect(stored?.status).toBe("requested");
        expect(stored?.version).toBeGreaterThan(1);
      });

      it("starts after a settled failed dispatch", async () => {
        await stores.lineDispatches.start(settledStopped(a, 1, { status: "failed" }));
        expect(await stores.lineDispatches.start(makeLineDispatch(a, { generation: 2 }))).toBe(
          "started",
        );
      });

      it("updates by compare-and-swap, keeping every concurrent change", async () => {
        const { projectId } = a.scope;
        await stores.lineDispatches.start(makeLineDispatch(a));
        await Promise.all(
          Array.from({ length: 6 }, () =>
            stores.lineDispatches.update(projectId, BRANCH, (current) => ({
              ...current,
              spend: { ...current.spend, meteredSeconds: current.spend.meteredSeconds + 1 },
            })),
          ),
        );
        const stored = await stores.lineDispatches.get(projectId, BRANCH);
        expect(stored?.spend.meteredSeconds).toBe(6);
        expect(stored?.version).toBe(7);
      });

      it("changes nothing for an undefined change, and answers undefined when absent", async () => {
        const { projectId } = a.scope;
        expect(
          await stores.lineDispatches.update(projectId, BRANCH, (current) => current),
        ).toBeUndefined();
        await stores.lineDispatches.start(makeLineDispatch(a));
        const same = await stores.lineDispatches.update(projectId, BRANCH, () => undefined);
        expect(same?.version).toBe(1);
      });

      it("lists dispatches by status, following a status change", async () => {
        await stores.lineDispatches.start(makeLineDispatch(a));
        await stores.lineDispatches.start(makeLineDispatch(b, { status: "running" }));
        const branches = async (
          statuses: Parameters<typeof stores.lineDispatches.listByStatus>[0],
        ) => (await stores.lineDispatches.listByStatus(statuses)).map((d) => d.projectId).sort();
        expect(await branches(["requested"])).toEqual([a.scope.projectId]);
        expect(await branches(["running"])).toEqual([b.scope.projectId]);
        expect(await branches(["requested", "running"])).toHaveLength(2);
        expect(await branches(["failed"])).toEqual([]);

        await stores.lineDispatches.update(a.scope.projectId, BRANCH, (current) => ({
          ...current,
          status: "running",
          updatedAt: LATER,
        }));
        expect(await branches(["requested"])).toEqual([]);
        expect(await branches(["running"])).toHaveLength(2);
      });
    });

    describe("project self-started usage", () => {
      const usage = (f: Fixtures, meteredUsd = 0) => ({
        schemaVersion: 1 as const,
        projectId: f.scope.projectId,
        month: MONTH,
        meteredUsd,
        capUsd: 100,
        version: 1,
        updatedAt: AT,
      });

      it("creates and reads a month's usage", async () => {
        const { projectId } = a.scope;
        expect(await stores.projectSelfStartedUsage.get(projectId, MONTH)).toBeUndefined();
        const created = await stores.projectSelfStartedUsage.update(
          projectId,
          MONTH,
          () => usage(a) as never,
        );
        expect(created?.version).toBe(1);
        expect(await stores.projectSelfStartedUsage.get(projectId, MONTH)).toEqual(created);
        expect(
          await stores.projectSelfStartedUsage.get(projectId, "2026-02" as CalendarMonth),
        ).toBeUndefined();
        expect(await stores.projectSelfStartedUsage.get(b.scope.projectId, MONTH)).toBeUndefined();
      });

      it("keeps every concurrent update, re-reading on a lost race", async () => {
        const { projectId } = a.scope;
        await Promise.all(
          Array.from({ length: 6 }, () =>
            stores.projectSelfStartedUsage.update(projectId, MONTH, (current) =>
              current === undefined
                ? (usage(a, 1) as never)
                : { ...current, meteredUsd: current.meteredUsd + 1 },
            ),
          ),
        );
        const stored = await stores.projectSelfStartedUsage.get(projectId, MONTH);
        expect(stored?.meteredUsd).toBe(6);
        expect(stored?.version).toBe(6);
      });
    });
  });
};
