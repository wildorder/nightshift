/**
 * The project-line port conformance suite (Pipkin M1b, S-02): `LineStore`
 * and `ProjectSelfStartedUsageStore`, run against every
 * adapter beside `persistence-ports.ts`.
 */
import type { CalendarMonth, IsoTimestamp, JobContractId, RunId } from "@nightshift/contracts";
import {
  createCountingIdGenerator,
  createFixtures,
  FIXTURE_COMMIT,
  type Fixtures,
  makeLineRecord,
  makeLineVerification,
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

    describe("line contents", () => {
      const runId = "run_01J0000000000000000000000A" as RunId;
      const jobContractId = "job_01J0000000000000000000000A" as JobContractId;
      const range = (f: Fixtures) => ({ program: f.scope.programId, upTo: FIXTURE_COMMIT });
      const repair = { runId, jobContractId };

      it("keeps a batch with the run that holds it, and clears it", async () => {
        const { projectId } = a.scope;
        await stores.lines.update(projectId, BRANCH, () =>
          makeLineRecord(a, {
            queue: [entry(a)],
            batch: { batchId: "b1", entries: [entry(a)], takenAt: AT, generation: 2, runId },
          }),
        );
        expect((await stores.lines.get(projectId, BRANCH))?.batch).toEqual({
          batchId: "b1",
          entries: [entry(a)],
          takenAt: AT,
          generation: 2,
          runId,
        });
        const cleared = await stores.lines.update(projectId, BRANCH, (current) =>
          current === undefined ? undefined : { ...current, batch: undefined, queue: [] },
        );
        expect(cleared?.batch).toBeUndefined();
        expect((await stores.lines.get(projectId, BRANCH))?.batch).toBeUndefined();
      });

      it("keeps compositions and parked entries naming a repair's run and job contract", async () => {
        const { projectId } = a.scope;
        const verification = makeLineVerification(a);
        const composition = {
          compositionId: "comp-1",
          commit: FIXTURE_COMMIT,
          parent: FIXTURE_COMMIT,
          ranges: [range(a)],
          verification,
          resolver: { decision: "resolved" as const, attempts: 1 },
          repair,
          composedAt: AT,
          pushed: { at: LATER },
        };
        const parked = {
          compositionId: "comp-2",
          ranges: [range(a)],
          reason: "the repair ran out of budget",
          verification,
          resolver: { decision: "gave_up" as const, attempts: 3, detail: "conflict" },
          repair,
          parkedAt: LATER,
        };
        await stores.lines.update(projectId, BRANCH, () =>
          makeLineRecord(a, { compositions: [composition], parked: [parked] }),
        );
        const stored = await stores.lines.get(projectId, BRANCH);
        expect(stored?.compositions).toEqual([composition]);
        expect(stored?.parked).toEqual([parked]);
        expect(stored?.compositions[0]?.repair).toEqual(repair);
        expect(stored?.parked[0]?.repair).toEqual(repair);
      });

      it("keeps a push in flight and a waiting reason, and drops them when cleared", async () => {
        const { projectId } = a.scope;
        const push = {
          head: FIXTURE_COMMIT,
          expectedPredecessor: FIXTURE_COMMIT,
          bundleKey: "bundles/k",
          generation: 1,
          status: "pending" as const,
          requestedAt: AT,
        };
        const waiting = { reason: "monthly_cap" as const, detail: "cap reached", since: AT };
        await stores.lines.update(projectId, BRANCH, () =>
          makeLineRecord(a, { push, waiting, head: FIXTURE_COMMIT }),
        );
        const stored = await stores.lines.get(projectId, BRANCH);
        expect(stored).toMatchObject({ push, waiting, head: FIXTURE_COMMIT });
        const published = await stores.lines.update(projectId, BRANCH, (current) =>
          current === undefined
            ? undefined
            : {
                ...current,
                push: { ...push, status: "published" as const, resolvedAt: LATER },
                waiting: undefined,
              },
        );
        expect(published?.push?.status).toBe("published");
        expect(published?.waiting).toBeUndefined();
        expect((await stores.lines.get(projectId, BRANCH))?.waiting).toBeUndefined();
      });

      it("refuses nothing to a stale writer silently: a lost race re-reads and applies once", async () => {
        const { projectId } = a.scope;
        await stores.lines.update(projectId, BRANCH, () => makeLineRecord(a));
        let calls = 0;
        const [x, y] = await Promise.all(
          [0, 1].map(() =>
            stores.lines.update(projectId, BRANCH, (current) => {
              calls += 1;
              return current === undefined
                ? undefined
                : { ...current, queue: [...current.queue, entry(a)] };
            }),
          ),
        );
        expect(calls).toBeGreaterThanOrEqual(2);
        expect([x?.version, y?.version].sort()).toEqual([2, 3]);
        expect((await stores.lines.get(projectId, BRANCH))?.queue).toHaveLength(2);
      });

      it("reads a stored line record that still carries decisions, without them", async () => {
        const { projectId } = a.scope;
        const legacy = {
          ...makeLineRecord(a, { queue: [entry(a)] }),
          decisions: [{ decisionId: "d1", choice: "keep both", generation: 1 }],
          agents: [],
        };
        await stores.lines.update(projectId, BRANCH, () => legacy as never);
        const stored = await stores.lines.get(projectId, BRANCH);
        expect(stored).toBeDefined();
        expect(stored?.queue).toEqual([entry(a)]);
        expect(stored).not.toHaveProperty("decisions");
        expect(stored).not.toHaveProperty("agents");
        const next = await stores.lines.update(projectId, BRANCH, (current) =>
          current === undefined ? undefined : { ...current, updatedAt: LATER },
        );
        expect(next?.version).toBe(2);
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
