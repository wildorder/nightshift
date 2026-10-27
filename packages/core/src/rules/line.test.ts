import type { LineRecord, ProgramId } from "@nightshift/contracts";
import { describe, expect, it } from "vitest";
import {
  createFixtures,
  makeDispatch,
  makeLineDispatch,
  makeLineRecord,
  makeLineVerification,
} from "../testing/factories.js";
import { beginReplacement, leaseLost, runnerStopped, transitionDispatch } from "./dispatch.js";
import {
  appendQueueEntry,
  capReached,
  composeBatch,
  DEFAULT_LINE_MONTHLY_USD,
  LINE_COMPOSITION_SECONDS,
  LINE_RESOLVER_ATTEMPTS,
  lineHasWork,
  lineQueueOwed,
  meterProjectUsage,
  newLineDispatch,
  occupiesComputeSlot,
  parkBatch,
  requestPush,
  resolvePush,
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
    expect(appendQueueEntry(composed.record, { program: P1, upTo: A }, LATER)).toBe(
      composed.record,
    );
    expect(appendQueueEntry(composed.record, { program: P1, upTo: C }, LATER).queue).toHaveLength(
      1,
    );
  });
});

describe("takeBatch", () => {
  it("moves the whole queue into one batch for the generation", () => {
    const { record, batch } = takeBatch(queued(), 2, { batchId: "batch-1" }, AT);
    expect(batch).toBeUndefined();
    expect(record.queue).toEqual([]);
    expect(record.batch).toMatchObject({ batchId: "batch-1", generation: 2, takenAt: AT });
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
      { batchId: "batch-1", ranges: [{ program: P1, upTo: A }], reason: "conflict" } as never,
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
        { program: P2, upTo: (1000 + i).toString(16).padStart(40, "0") as never },
        AT,
      );
      record = takeBatch(record, 1, { batchId: `p${i}` }, AT).record;
      const parked = parkBatch(
        record,
        { batchId: `p${i}`, ranges: [{ program: P2, upTo: A }], reason: "r" } as never,
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
  const request = { head: C, expectedPredecessor: A, bundleKey: "proj/line/x/1/p.pack" };

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
    expect(resolved.record.push).toMatchObject({ status: "published", resolvedAt: LATER });
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
    expect(resolved.record.push).toMatchObject({ status: "conflict", detail: "the line moved" });
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
    expect(first).toMatchObject({ meteredUsd: 10, capUsd: 25, month: "2026-10" });
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

describe("a line dispatch", () => {
  const machine = {
    tier: "good",
    instanceType: "c8id.2xlarge",
    usdPerHour: 0.5,
    amiVersion: "1.0.0",
  } as const;
  const base = {
    projectId: f.scope.projectId,
    branch: "nightshift/develop",
    engineAgentId: f.ids.next("agent"),
    machine,
    at: AT,
  };

  it("starts at generation 1, requested, estimated for one composition hour", () => {
    const first = newLineDispatch(base);
    expect(first).toMatchObject({ generation: 1, status: "requested", version: 1 });
    expect(first.spend.estimatedUsd).toBeCloseTo(0.5);
    expect(first.attempts).toEqual([{ generation: 1, reason: "dispatch", startedAt: AT }]);
  });

  it("continues the generation across dispatches, never back to 1", () => {
    const first = newLineDispatch(base);
    const second = newLineDispatch({ ...base, previous: first });
    const third = newLineDispatch({ ...base, previous: second });
    expect([first.generation, second.generation, third.generation]).toEqual([1, 2, 3]);
    expect(
      newLineDispatch({ ...base, previous: makeLineDispatch(f, { generation: 7 }) }).generation,
    ).toBe(8);
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

describe("the dispatch machine rules over a line dispatch", () => {
  it("drive a line dispatch as they do a run's", () => {
    const requested = makeLineDispatch(f);
    const provisioning = transitionDispatch(requested, "provision", AT);
    expect(provisioning.status).toBe("provisioning");
    const running = transitionDispatch(transitionDispatch(provisioning, "ready", AT), "start", AT);
    expect(leaseLost({ ...running, leaseExpiresAt: AT }, Date.parse(LATER))).toBe(true);
    const replaced = beginReplacement(
      { ...running, instanceId: "i-1", leaseExpiresAt: AT },
      "lease_lost",
      LATER,
    );
    expect(replaced).toMatchObject({ generation: 2, status: "provisioning" });
    expect(replaced.instanceId).toBeUndefined();
    const failed = runnerStopped(replaced, { code: "setup_failed", message: "no" }, LATER);
    expect(failed).toMatchObject({ status: "failed", failure: { code: "setup_failed" } });
  });
});
