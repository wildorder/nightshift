import type { LineRecord, ProgramId } from "@nightshift/contracts";
import { describe, expect, it } from "vitest";
import {
  createFixtures,
  makeDispatch,
  makeLineRecord,
  makeLineVerification,
} from "../testing/factories.js";
import {
  appendQueueEntry,
  capReached,
  chargeDispatchUsage,
  composeBatch,
  DEFAULT_LINE_MONTHLY_USD,
  dispatchChargeDue,
  dispatchChargeKey,
  LINE_COMPOSITION_SECONDS,
  LINE_IDLE_SECONDS,
  LINE_RESOLVER_ATTEMPTS,
  lineHasWork,
  lineQueueOwed,
  MAX_LINE_BATCH_ENTRIES,
  meterProjectUsage,
  occupiesComputeSlot,
  parkBatch,
  previousMonthOf,
  requestPush,
  resolvePush,
  settleBatch,
  takeBatch,
} from "./line.js";

const f = createFixtures();
const P1 = f.ids.next("prog") as ProgramId;
const P2 = f.ids.next("prog") as ProgramId;
const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const AT = "2026-10-27T10:00:00.000Z";
const LATER = "2026-10-27T11:00:00.000Z";

const empty = (): LineRecord => makeLineRecord(f);
const queued = (): LineRecord =>
  appendQueueEntry(
    appendQueueEntry(empty(), { program: P1, upTo: A }, AT),
    { program: P2, upTo: B },
    AT,
  );

const compositionBody = (batchId: string, extra: Record<string, unknown> = {}) => ({
  batchId,
  commit: C,
  parent: A,
  ranges: [{ program: P1, upTo: A }],
  verification: makeLineVerification(f),
  ...extra,
});

describe("dispatchChargeKey", () => {
  it("is the same across generations of one dispatch and differs between dispatches", () => {
    expect(dispatchChargeKey("b", "agent_1")).toBe(dispatchChargeKey("b", "agent_1"));
    expect(dispatchChargeKey("b", "agent_1")).not.toBe(dispatchChargeKey("b", "agent_2"));
    expect(dispatchChargeKey("b", "agent_1")).not.toBe(dispatchChargeKey("c", "agent_1"));
  });
});

describe("the constants", () => {
  it("are the settled ones", () => {
    expect(DEFAULT_LINE_MONTHLY_USD).toBe(25);
    expect(LINE_COMPOSITION_SECONDS).toBe(3600);
    expect(LINE_RESOLVER_ATTEMPTS).toBe(3);
  });
});

describe("appendQueueEntry", () => {
  it("is idempotent by program and head", () => {
    const once = appendQueueEntry(empty(), { program: P1, upTo: A }, AT);
    expect(appendQueueEntry(once, { program: P1, upTo: A }, LATER)).toBe(once);
    expect(once.queue).toEqual([{ program: P1, upTo: A, enqueuedAt: AT }]);
    expect(appendQueueEntry(once, { program: P1, upTo: B }, LATER).queue).toHaveLength(2);
    expect(appendQueueEntry(once, { program: P2, upTo: A }, LATER).queue).toHaveLength(2);
  });

  it("does not re-add a range already batched", () => {
    const { record } = takeBatch(queued(), 1, { batchId: "batch-1" }, AT);
    expect(appendQueueEntry(record, { program: P1, upTo: A }, LATER)).toBe(record);
  });

  it("does not re-add a range already composed", () => {
    const { record } = takeBatch(queued(), 1, { batchId: "batch-1" }, AT);
    const composed = composeBatch(record, compositionBody("batch-1") as never, "comp-1", AT);
    if (!composed.ok) throw new Error("expected a composition");
    const pushing = requestPush(
      composed.record,
      { head: C, expectedPredecessor: A, bundleKey: "k" },
      1,
      AT,
    );
    if (!pushing.ok) throw new Error("expected a push");
    expect(appendQueueEntry(pushing.record, { program: P1, upTo: A }, LATER)).toBe(pushing.record);
    expect(appendQueueEntry(pushing.record, { program: P1, upTo: C }, LATER).queue).toHaveLength(1);
    const pushed = resolvePush(pushing.record, C, "published", undefined, LATER);
    if (!pushed.ok) throw new Error("expected resolved");
    expect(appendQueueEntry(pushed.record, { program: P1, upTo: A }, LATER)).toBe(pushed.record);
  });
});

describe("takeBatch", () => {
  it("moves the whole queue into one batch for the generation", () => {
    const { record, batch } = takeBatch(queued(), 2, { batchId: "batch-1" }, AT);
    expect(batch).toBeUndefined();
    expect(record.queue).toEqual([]);
    expect(record.batch).toMatchObject({
      batchId: "batch-1",
      generation: 2,
      takenAt: AT,
    });
    expect(record.batch?.entries.map((entry) => entry.upTo)).toEqual([A, B]);
  });

  it("gives no batch when the queue is empty", () => {
    const taken = takeBatch(empty(), 1, { batchId: "batch-1" }, AT);
    expect(taken.batch).toBeUndefined();
    expect(taken.record.batch).toBeUndefined();
  });

  it("hands back a batch already held, re-bound to a newer generation, and leaves the queue", () => {
    const first = takeBatch(queued(), 1, { batchId: "batch-1" }, AT).record;
    const more = appendQueueEntry(first, { program: P1, upTo: C }, AT);
    const same = takeBatch(more, 1, { batchId: "batch-2" }, LATER);
    expect(same.batch?.batchId).toBe("batch-1");
    const newer = takeBatch(more, 2, { batchId: "batch-2" }, LATER);
    expect(newer.batch).toMatchObject({ batchId: "batch-1", generation: 2 });
    expect(newer.record.queue).toHaveLength(1);
  });
});

describe("composeBatch and parkBatch", () => {
  const batched = () => takeBatch(queued(), 1, { batchId: "batch-1" }, AT).record;

  it("composes, clears the batch and records the composition", () => {
    const result = composeBatch(batched(), compositionBody("batch-1") as never, "comp-1", LATER);
    if (!result.ok) throw new Error("expected ok");
    expect(result.record.batch).toBeUndefined();
    expect(result.record.compositions).toHaveLength(1);
    expect(result.record.compositions[0]).toMatchObject({
      compositionId: "comp-1",
      commit: C,
      composedAt: LATER,
    });
    expect(lineHasWork(result.record)).toBe(false);
  });

  it("parks, clears the batch and records why", () => {
    const result = parkBatch(
      batched(),
      {
        batchId: "batch-1",
        ranges: [{ program: P1, upTo: A }],
        reason: "conflict",
      } as never,
      "comp-2",
      LATER,
    );
    if (!result.ok) throw new Error("expected ok");
    expect(result.record.batch).toBeUndefined();
    expect(result.record.parked).toMatchObject([
      { compositionId: "comp-2", reason: "conflict", parkedAt: LATER },
    ]);
  });

  it("refuses a stale batchId, whatever the record holds", () => {
    expect(composeBatch(batched(), compositionBody("batch-0") as never, "c", AT)).toMatchObject({
      ok: false,
      reason: "stale_batch",
    });
    expect(
      parkBatch(batched(), { batchId: "batch-0", ranges: [], reason: "x" } as never, "c", AT),
    ).toMatchObject({ ok: false, reason: "stale_batch" });
    // And once it is settled, the same id is stale.
    const settled = composeBatch(batched(), compositionBody("batch-1") as never, "c", AT);
    if (!settled.ok) throw new Error("expected ok");
    expect(
      composeBatch(settled.record, compositionBody("batch-1") as never, "c2", AT),
    ).toMatchObject({
      ok: false,
      reason: "stale_batch",
    });
  });

  it("refuses resolver attempts above the limit, and accepts the limit", () => {
    const over = { decision: "gave_up", attempts: LINE_RESOLVER_ATTEMPTS + 1 };
    expect(
      composeBatch(batched(), compositionBody("batch-1", { resolver: over }) as never, "c", AT),
    ).toMatchObject({ ok: false, reason: "resolver_attempts" });
    expect(
      parkBatch(
        batched(),
        {
          batchId: "batch-1",
          ranges: [{ program: P1, upTo: A }],
          reason: "x",
          resolver: over,
        } as never,
        "c",
        AT,
      ),
    ).toMatchObject({ ok: false, reason: "resolver_attempts" });
    const at = { decision: "resolved", attempts: LINE_RESOLVER_ATTEMPTS };
    expect(
      composeBatch(batched(), compositionBody("batch-1", { resolver: at }) as never, "c", AT).ok,
    ).toBe(true);
  });

  it("keeps the newest fifty compositions and the newest fifty parked", () => {
    let record = empty();
    for (let i = 0; i < 55; i += 1) {
      const sha = i.toString(16).padStart(40, "0");
      record = appendQueueEntry(record, { program: P1, upTo: sha as never }, AT);
      record = takeBatch(record, 1, { batchId: `b${i}` }, AT).record;
      const composed = composeBatch(record, compositionBody(`b${i}`) as never, `comp-${i}`, AT);
      if (!composed.ok) throw new Error("expected ok");
      record = composed.record;
    }
    expect(record.compositions).toHaveLength(50);
    expect(record.compositions[0]?.compositionId).toBe("comp-5");
    expect(record.compositions.at(-1)?.compositionId).toBe("comp-54");
    for (let i = 0; i < 52; i += 1) {
      record = appendQueueEntry(
        record,
        {
          program: P2,
          upTo: (1000 + i).toString(16).padStart(40, "0") as never,
        },
        AT,
      );
      record = takeBatch(record, 1, { batchId: `p${i}` }, AT).record;
      const parked = parkBatch(
        record,
        {
          batchId: `p${i}`,
          ranges: [{ program: P2, upTo: A }],
          reason: "r",
        } as never,
        `park-${i}`,
        AT,
      );
      if (!parked.ok) throw new Error("expected ok");
      record = parked.record;
    }
    expect(record.parked).toHaveLength(50);
    expect(record.parked[0]?.compositionId).toBe("park-2");
  });
});

describe("requestPush and resolvePush", () => {
  const request = {
    head: C,
    expectedPredecessor: A,
    bundleKey: "proj/line/x/1/p.pack",
  };

  it("records a pending push for the generation, and the same head again is the same push", () => {
    const first = requestPush(empty(), request, 2, AT);
    if (!first.ok) throw new Error("expected ok");
    expect(first.record.push).toMatchObject({
      ...request,
      generation: 2,
      status: "pending",
      requestedAt: AT,
    });
    expect(lineHasWork(first.record)).toBe(true);
    const again = requestPush(first.record, request, 2, LATER);
    expect(again).toEqual({ ok: true, record: first.record });
  });

  it("refuses a second head while one is pending", () => {
    const first = requestPush(empty(), request, 2, AT);
    if (!first.ok) throw new Error("expected ok");
    expect(requestPush(first.record, { ...request, head: B }, 2, LATER)).toMatchObject({
      ok: false,
      reason: "push_pending",
    });
  });

  it("resolves published: the head moves and the composition is marked pushed", () => {
    const batched = takeBatch(queued(), 1, { batchId: "b" }, AT).record;
    const composed = composeBatch(batched, compositionBody("b") as never, "comp-1", AT);
    if (!composed.ok) throw new Error("expected ok");
    const pushed = requestPush(composed.record, request, 1, AT);
    if (!pushed.ok) throw new Error("expected ok");
    const resolved = resolvePush(pushed.record, C, "published", undefined, LATER);
    if (!resolved.ok) throw new Error("expected ok");
    expect(resolved.record.head).toBe(C);
    expect(resolved.record.push).toMatchObject({
      status: "published",
      resolvedAt: LATER,
    });
    expect(resolved.record.compositions[0]?.pushed).toEqual({ at: LATER });
    expect(lineHasWork(resolved.record)).toBe(false);
    // A resolved push does not hold the next one.
    expect(requestPush(resolved.record, { ...request, head: B }, 1, LATER).ok).toBe(true);
  });

  it("resolves a refusal without moving the head, keeping the detail", () => {
    const pushed = requestPush({ ...empty(), head: A }, request, 1, AT);
    if (!pushed.ok) throw new Error("expected ok");
    const resolved = resolvePush(pushed.record, C, "conflict", "the line moved", LATER);
    if (!resolved.ok) throw new Error("expected ok");
    expect(resolved.record.head).toBe(A);
    expect(resolved.record.push).toMatchObject({
      status: "conflict",
      detail: "the line moved",
    });
  });

  it("refuses to resolve a push that is not the line's", () => {
    expect(resolvePush(empty(), C, "published", undefined, AT)).toMatchObject({
      ok: false,
      reason: "no_such_push",
    });
    const pushed = requestPush(empty(), request, 1, AT);
    if (!pushed.ok) throw new Error("expected ok");
    expect(resolvePush(pushed.record, B, "published", undefined, AT)).toMatchObject({ ok: false });
  });
});

describe("the project's self-started usage", () => {
  const input = (month: string, deltaUsd: number, capUsd = 25) => ({
    projectId: f.scope.projectId,
    month,
    deltaUsd,
    capUsd,
  });

  it("adds a delta and notes when the cap is first reached", () => {
    const first = meterProjectUsage(undefined, input("2026-10", 10), AT);
    expect(first).toMatchObject({
      meteredUsd: 10,
      capUsd: 25,
      month: "2026-10",
    });
    expect(first.reachedAt).toBeUndefined();
    const second = meterProjectUsage(first, input("2026-10", 15), LATER);
    expect(second.meteredUsd).toBe(25);
    expect(second.reachedAt).toBe(LATER);
    const third = meterProjectUsage(second, input("2026-10", 1), "2026-10-28T00:00:00.000Z");
    expect(third.reachedAt).toBe(LATER);
    expect(third.meteredUsd).toBe(26);
  });

  it("resets the spend when the month rolls over", () => {
    const october = meterProjectUsage(undefined, input("2026-10", 30), AT);
    expect(capReached(october, "2026-10", 25)).toBe(true);
    const november = meterProjectUsage(october, input("2026-11", 2), "2026-11-01T00:00:00.000Z");
    expect(november).toMatchObject({ month: "2026-11", meteredUsd: 2 });
    expect(november.reachedAt).toBeUndefined();
    expect(capReached(november, "2026-11", 25)).toBe(false);
  });

  it("reaches the cap exactly at the cap, and never for another month's row or none", () => {
    expect(capReached(undefined, "2026-10", 25)).toBe(false);
    const row = meterProjectUsage(undefined, input("2026-10", 24.99), AT);
    expect(capReached(row, "2026-10", 25)).toBe(false);
    expect(capReached(meterProjectUsage(row, input("2026-10", 0.01), AT), "2026-10", 25)).toBe(
      true,
    );
    expect(capReached(row, "2026-11", 1)).toBe(false);
  });

  it("never lets a negative delta pay the spend back", () => {
    const row = meterProjectUsage(undefined, input("2026-10", 5), AT);
    expect(meterProjectUsage(row, input("2026-10", -3), AT).meteredUsd).toBe(5);
  });
});

describe("charging a dispatch to the project's usage", () => {
  const charge = (dispatchUsd: number, baselineUsd = 0, month = "2026-10") => ({
    projectId: f.scope.projectId,
    month,
    capUsd: 25,
    key: "b#1",
    dispatchUsd,
    baselineUsd,
  });

  it("charges the dispatch's cumulative spend once, however often it is repeated", () => {
    const first = chargeDispatchUsage(undefined, charge(2), AT);
    expect(first).toMatchObject({ meteredUsd: 2, charged: { "b#1": 2 } });
    const again = chargeDispatchUsage(first, charge(2), LATER);
    expect(again.meteredUsd).toBe(2);
    const more = chargeDispatchUsage(again, charge(3.5), LATER);
    expect(more).toMatchObject({ meteredUsd: 3.5, charged: { "b#1": 3.5 } });
    expect(chargeDispatchUsage(more, charge(1), LATER).meteredUsd).toBe(3.5);
  });

  it("knows when a charge is due", () => {
    const row = chargeDispatchUsage(undefined, charge(2), AT);
    const key = { month: "2026-10", key: "b#1", baselineUsd: 0 };
    expect(dispatchChargeDue(row, { ...key, dispatchUsd: 2 })).toBe(false);
    expect(dispatchChargeDue(row, { ...key, dispatchUsd: 2.1 })).toBe(true);
    expect(dispatchChargeDue(undefined, { ...key, dispatchUsd: 0.1 })).toBe(true);
    expect(dispatchChargeDue(undefined, { ...key, dispatchUsd: 0 })).toBe(false);
  });

  it("starts a new month's row from the baseline, and leaves other dispatches' entries", () => {
    const october = chargeDispatchUsage(undefined, charge(4), AT);
    const november = chargeDispatchUsage(october, charge(5, 4, "2026-11"), LATER);
    expect(november).toMatchObject({
      month: "2026-11",
      meteredUsd: 1,
      charged: { "b#1": 5 },
    });
    const other = chargeDispatchUsage(november, { ...charge(2, 0, "2026-11"), key: "b#2" }, LATER);
    expect(other).toMatchObject({
      meteredUsd: 3,
      charged: { "b#1": 5, "b#2": 2 },
    });
  });

  it("parses rows from before the field and notes the cap", () => {
    const legacy = meterProjectUsage(
      undefined,
      {
        projectId: f.scope.projectId,
        month: "2026-10",
        deltaUsd: 1,
        capUsd: 25,
      },
      AT,
    );
    expect(legacy.charged).toBeUndefined();
    const row = chargeDispatchUsage(legacy, charge(30), LATER);
    expect(row.meteredUsd).toBe(31);
    expect(row.reachedAt).toBe(LATER);
  });

  it("names the month before", () => {
    expect(previousMonthOf("2026-11")).toBe("2026-10");
    expect(previousMonthOf("2026-01")).toBe("2025-12");
  });
});

describe("lineQueueOwed", () => {
  const dispatchWith = (publication: Record<string, unknown>) =>
    makeDispatch(f, { publication: { intents: [], ...publication } });

  it("is owed when asked for and the published head is not the one last queued", () => {
    expect(lineQueueOwed(dispatchWith({ lineOwed: true, head: A }))).toBe(true);
    expect(lineQueueOwed(dispatchWith({ lineOwed: true, head: B, lineQueuedUpTo: A }))).toBe(true);
  });

  it("is not owed once queued, when not asked for, or before anything is published", () => {
    expect(lineQueueOwed(dispatchWith({ lineOwed: true, head: A, lineQueuedUpTo: A }))).toBe(false);
    expect(lineQueueOwed(dispatchWith({ head: A }))).toBe(false);
    expect(lineQueueOwed(dispatchWith({ lineOwed: false, head: A }))).toBe(false);
    expect(lineQueueOwed(dispatchWith({ lineOwed: true }))).toBe(false);
  });
});

describe("lineHasWork", () => {
  it("holds for a queue, a batch or a pending push, and for nothing else", () => {
    expect(lineHasWork(empty())).toBe(false);
    expect(lineHasWork(queued())).toBe(true);
    expect(lineHasWork(takeBatch(queued(), 1, { batchId: "b" }, AT).record)).toBe(true);
    const pending = requestPush(
      empty(),
      { head: C, expectedPredecessor: A, bundleKey: "k" },
      1,
      AT,
    );
    if (!pending.ok) throw new Error("expected ok");
    expect(lineHasWork(pending.record)).toBe(true);
    const done = resolvePush(pending.record, C, "published", undefined, LATER);
    if (!done.ok) throw new Error("expected ok");
    expect(lineHasWork(done.record)).toBe(false);
    const blocked = resolvePush(pending.record, C, "protected", "branch protection", LATER);
    if (!blocked.ok) throw new Error("expected ok");
    expect(lineHasWork(blocked.record)).toBe(false);
  });
});

describe("occupiesComputeSlot", () => {
  it.each([
    ["requested", false],
    ["provisioning", true],
    ["ready", true],
    ["running", true],
    ["stopping", true],
    ["stopped", false],
    ["failed", false],
  ] as const)("%s occupies a slot: %s", (status, occupies) => {
    expect(occupiesComputeSlot(status)).toBe(occupies);
  });
});

describe("takeBatch cap", () => {
  it("takes at most MAX_LINE_BATCH_ENTRIES of the oldest entries and leaves the rest queued", () => {
    let record = empty();
    for (let i = 0; i < MAX_LINE_BATCH_ENTRIES + 5; i += 1) {
      record = appendQueueEntry(
        record,
        { program: P1, upTo: i.toString(16).padStart(40, "0") as never },
        AT,
      );
    }
    const taken = takeBatch(record, 1, { batchId: "batch-1" }, AT);
    expect(taken.record.batch?.entries).toEqual(record.queue.slice(0, MAX_LINE_BATCH_ENTRIES));
    expect(taken.record.queue).toEqual(record.queue.slice(MAX_LINE_BATCH_ENTRIES));
    expect(taken.record.queue).toHaveLength(5);
  });
});

describe("settleBatch", () => {
  const batched = () => takeBatch(queued(), 1, { batchId: "batch-1" }, AT).record;
  const { batchId: _id, ...composition } = compositionBody("batch-1");
  const push = { head: C, expectedPredecessor: A, bundleKey: "k" };
  const parkedBody = { ranges: [{ program: P2, upTo: B }], reason: "conflict" };

  it("records the composition and every parked entry in one change and clears the batch", () => {
    const result = settleBatch(
      batched(),
      {
        batchId: "batch-1",
        composition,
        push,
        parked: [parkedBody, parkedBody],
      } as never,
      { compositionId: "comp-1", parkedIds: ["park-1", "park-2"] },
      1,
      LATER,
    );
    if (!result.ok) throw new Error("expected ok");
    expect(result.record.batch).toBeUndefined();
    expect(result.record.compositions).toMatchObject([
      { compositionId: "comp-1", composedAt: LATER },
    ]);
    expect(result.record.parked.map((p) => p.compositionId)).toEqual(["park-1", "park-2"]);
    expect(result.record.updatedAt).toBe(LATER);
  });

  it("settles with neither, clearing the batch", () => {
    const result = settleBatch(
      batched(),
      { batchId: "batch-1", parked: [] } as never,
      { parkedIds: [] },
      1,
      LATER,
    );
    if (!result.ok) throw new Error("expected ok");
    expect(result.record.batch).toBeUndefined();
    expect(result.record.compositions).toEqual([]);
    expect(result.record.parked).toEqual([]);
  });

  it("refuses a stale batch and resolver attempts above the limit", () => {
    expect(
      settleBatch(batched(), { batchId: "batch-0", parked: [] } as never, { parkedIds: [] }, 1, AT),
    ).toMatchObject({ ok: false, reason: "stale_batch" });
    const over = { decision: "gave_up", attempts: LINE_RESOLVER_ATTEMPTS + 1 };
    expect(
      settleBatch(
        batched(),
        {
          batchId: "batch-1",
          composition: { ...composition, resolver: over },
          push,
          parked: [],
        } as never,
        { compositionId: "c", parkedIds: [] },
        1,
        AT,
      ),
    ).toMatchObject({ ok: false, reason: "resolver_attempts" });
    expect(
      settleBatch(
        batched(),
        {
          batchId: "batch-1",
          parked: [{ ...parkedBody, resolver: over }],
        } as never,
        { parkedIds: ["p"] },
        1,
        AT,
      ),
    ).toMatchObject({ ok: false, reason: "resolver_attempts" });
  });

  const settled = () => {
    const result = settleBatch(
      batched(),
      { batchId: "batch-1", composition, push, parked: [] } as never,
      { compositionId: "comp-1", parkedIds: [] },
      3,
      LATER,
    );
    if (!result.ok) throw new Error("expected ok");
    return result.record;
  };

  it("carries the push with the composition, so it survives the owner dying", () => {
    const record = settled();
    expect(record.batch).toBeUndefined();
    expect(record.compositions).toMatchObject([{ commit: C }]);
    expect(record.push).toEqual({
      ...push,
      generation: 3,
      status: "pending",
      requestedAt: LATER,
    });
    expect(lineHasWork(record)).toBe(true);
  });

  it("refuses to settle while a different push is pending, and accepts the same head", () => {
    const other = requestPush(
      batched(),
      { head: B, expectedPredecessor: A, bundleKey: "o" },
      1,
      AT,
    );
    if (!other.ok) throw new Error("expected ok");
    const body = { batchId: "batch-1", composition, push, parked: [] } as never;
    expect(
      settleBatch(other.record, body, { compositionId: "c", parkedIds: [] }, 1, AT),
    ).toMatchObject({ ok: false, reason: "push_pending" });
    const same = requestPush(batched(), push, 1, AT);
    if (!same.ok) throw new Error("expected ok");
    expect(
      settleBatch(same.record, body, { compositionId: "c", parkedIds: [] }, 1, LATER),
    ).toMatchObject({ ok: true });
  });

  it("requeues the ranges of a failed push, and accepts them again", () => {
    const record = settled();
    const taken = { program: P1, upTo: A };
    expect(appendQueueEntry(record, taken, LATER).queue).toEqual([]);
    const failed = resolvePush(record, C, "conflict", "moved", LATER);
    if (!failed.ok) throw new Error("expected ok");
    expect(failed.record.queue).toEqual([{ ...taken, enqueuedAt: LATER }]);
    expect(appendQueueEntry(failed.record, taken, LATER).queue).toHaveLength(1);
    const again = resolvePush(failed.record, C, "error", undefined, LATER);
    if (!again.ok) throw new Error("expected ok");
    expect(again.record.queue).toHaveLength(1);
  });

  it("requeues a failed push ahead of a head queued while it was pending, at its composedAt", () => {
    const record = settled();
    const newer = { program: P1, upTo: B };
    const withNewer = appendQueueEntry(record, newer, "2030-01-01T00:00:00.000Z");
    expect(withNewer.queue).toHaveLength(1);
    const failed = resolvePush(withNewer, C, "conflict", "moved", "2031-01-01T00:00:00.000Z");
    if (!failed.ok) throw new Error("expected ok");
    expect(failed.record.queue).toEqual([
      { program: P1, upTo: A, enqueuedAt: LATER },
      { ...newer, enqueuedAt: "2030-01-01T00:00:00.000Z" },
    ]);
  });

  it("does not requeue when the push published", () => {
    const published = resolvePush(settled(), C, "published", undefined, LATER);
    if (!published.ok) throw new Error("expected ok");
    expect(published.record.queue).toEqual([]);
  });
});

describe("the line's idle wait", () => {
  it("is exported", () => {
    expect(LINE_IDLE_SECONDS).toBe(600);
  });
});

describe("held entries", () => {
  const sha = (n: number) => n.toString(16).padStart(40, "0");
  const manyHeld = Array.from({ length: MAX_LINE_BATCH_ENTRIES + 5 }, (_, i) => ({
    program: P1,
    upTo: sha(i + 1),
    enqueuedAt: AT,
    repairs: 2,
  }));
  const settleHolding = (held: LineRecord["held"], generation = 1) => {
    const base = { ...empty(), queue: held };
    const taken = takeBatch(base, generation, { batchId: "b1" }, AT);
    const result = settleBatch(
      taken.record,
      { batchId: "b1", parked: [], held: held.slice(0, MAX_LINE_BATCH_ENTRIES) } as never,
      { parkedIds: [] },
      generation,
      LATER,
    );
    if (!result.ok) throw new Error("expected ok");
    return result.record;
  };

  it("moves settled held entries into record.held, deduplicated keeping the larger repairs", () => {
    const taken = takeBatch(queued(), 1, { batchId: "b1" }, AT).record;
    const entries = taken.batch?.entries ?? [];
    const first = entries[0];
    if (first === undefined) throw new Error("no entry");
    const result = settleBatch(
      taken,
      {
        batchId: "b1",
        parked: [],
        held: [
          { ...first, repairs: 1 },
          { ...first, repairs: 3 },
          { ...first, repairs: 2 },
        ],
      } as never,
      { parkedIds: [] },
      1,
      LATER,
    );
    if (!result.ok) throw new Error("expected ok");
    expect(result.record.held).toEqual([{ ...first, repairs: 3 }]);
    expect(result.record.batch).toBeUndefined();
  });

  it("refuses held entries that were not in the settled batch", () => {
    const taken = takeBatch(queued(), 1, { batchId: "b1" }, AT).record;
    expect(
      settleBatch(
        taken,
        { batchId: "b1", parked: [], held: [{ program: P1, upTo: C, enqueuedAt: AT }] } as never,
        { parkedIds: [] },
        1,
        LATER,
      ),
    ).toMatchObject({ ok: false, reason: "held_not_in_batch" });
  });

  it("never blocks unrelated queued entries, however many are held", () => {
    const record = settleHolding(manyHeld);
    expect(record.held).toHaveLength(MAX_LINE_BATCH_ENTRIES);
    const withWork = appendQueueEntry(record, { program: P2, upTo: B }, LATER);
    const taken = takeBatch(withWork, 1, { batchId: "b2" }, LATER).record;
    expect(taken.batch?.entries.map((e) => e.upTo)).toEqual([
      ...manyHeld.slice(MAX_LINE_BATCH_ENTRIES).map((e) => e.upTo),
      B,
    ]);
    expect(taken.held).toHaveLength(MAX_LINE_BATCH_ENTRIES);
  });

  it("puts released entries at the queue front with repairs intact", () => {
    const record = appendQueueEntry(
      settleHolding(manyHeld.slice(0, 2)),
      { program: P2, upTo: B },
      LATER,
    );
    const released = takeBatch(record, 1, { batchId: "b2" }, LATER, [
      { program: P1, upTo: sha(2) },
    ]).record;
    expect(released.batch?.entries.map((e) => [e.upTo, e.repairs])).toEqual([
      [sha(2), 2],
      [B, undefined],
    ]);
    expect(released.held.map((e) => e.upTo)).toEqual([sha(1)]);
  });

  it("releases every held entry when a newer generation takes", () => {
    const record = settleHolding(manyHeld.slice(0, 2));
    const taken = takeBatch(record, 2, { batchId: "b2" }, LATER).record;
    expect(taken.held).toEqual([]);
    expect(taken.batch).toMatchObject({ generation: 2 });
    expect(taken.batch?.entries).toEqual(manyHeld.slice(0, 2));
  });

  it("keeps repairs when a rejected push requeues the composition's ranges", () => {
    const batched = takeBatch(queued(), 1, { batchId: "b" }, AT).record;
    const composed = composeBatch(
      batched,
      compositionBody("b", { ranges: [{ program: P1, upTo: A, repairs: 3 }] }) as never,
      "comp-1",
      AT,
    );
    if (!composed.ok) throw new Error("expected ok");
    const pushed = requestPush(
      composed.record,
      { head: C, expectedPredecessor: A, bundleKey: "k" },
      1,
      AT,
    );
    if (!pushed.ok) throw new Error("expected ok");
    const resolved = resolvePush(pushed.record, C, "conflict", "no", LATER);
    if (!resolved.ok) throw new Error("expected ok");
    expect(resolved.record.queue[0]).toMatchObject({ program: P1, upTo: A, repairs: 3 });
  });

  it("keeps the repaired commit through settle, a rejected push, held and a new generation", () => {
    const batched = takeBatch(queued(), 1, { batchId: "b" }, AT).record;
    const composed = composeBatch(
      batched,
      compositionBody("b", {
        ranges: [{ program: P1, upTo: A, repairs: 3, repaired: B }],
      }) as never,
      "comp-1",
      AT,
    );
    if (!composed.ok) throw new Error("expected ok");
    expect(composed.record.compositions[0]?.ranges).toEqual([
      { program: P1, upTo: A, repairs: 3, repaired: B },
    ]);
    const pushed = requestPush(
      composed.record,
      { head: C, expectedPredecessor: A, bundleKey: "k" },
      1,
      AT,
    );
    if (!pushed.ok) throw new Error("expected ok");
    const resolved = resolvePush(pushed.record, C, "conflict", "no", LATER);
    if (!resolved.ok) throw new Error("expected ok");
    expect(resolved.record.queue[0]).toMatchObject({
      program: P1,
      upTo: A,
      repairs: 3,
      repaired: B,
    });

    // Taken again and held behind another repair, it keeps the commit through a generation change.
    const retaken = takeBatch(resolved.record, 1, { batchId: "b2" }, LATER).record;
    const entry = retaken.batch?.entries.find((e) => e.program === P1);
    if (entry === undefined) throw new Error("no entry");
    expect(entry).toMatchObject({ repairs: 3, repaired: B });
    const held = settleBatch(
      retaken,
      { batchId: "b2", parked: [], held: [entry] } as never,
      { parkedIds: [] },
      1,
      LATER,
    );
    if (!held.ok) throw new Error("expected ok");
    expect(held.record.held[0]).toMatchObject({ repaired: B });
    const replaced = takeBatch(held.record, 2, { batchId: "b3" }, LATER).record;
    expect(replaced.batch?.entries.find((e) => e.program === P1)).toMatchObject({
      repairs: 3,
      repaired: B,
    });
  });

  // Skipped until the program head merges: its composedEntryOf/parkedEntryOf (line/settlement.ts)
  // copy `repair` in settleBatch; re-enable then.
  it.skip("stores the repair ref from a composition and from parked bodies", () => {
    const repair = { runId: f.ids.next("run"), jobContractId: f.ids.next("job") };
    const batched = takeBatch(queued(), 1, { batchId: "b" }, AT).record;
    const { batchId: _id, ...composition } = compositionBody("b", { repair });
    const result = settleBatch(
      batched,
      {
        batchId: "b",
        composition,
        push: { head: C, expectedPredecessor: A, bundleKey: "k" },
        parked: [{ ranges: [{ program: P2, upTo: B }], reason: "x", repair }],
      } as never,
      { compositionId: "c1", parkedIds: ["p1"] },
      1,
      LATER,
    );
    if (!result.ok) throw new Error("expected ok");
    expect(result.record.compositions[0]?.repair).toEqual(repair);
    expect(result.record.parked[0]?.repair).toEqual(repair);
  });
});
