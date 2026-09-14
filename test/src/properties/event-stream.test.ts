/**
 * The event-stream helpers, and the durable-but-unnumbered window they exist for
 * (A-22).
 *
 * The second half runs against the in-memory adapter in deferred-sequencing mode,
 * so the lag is exercised offline. Without that, this state would only occur
 * against real AWS and every consumer written from P3 onward would be untested
 * against the case it most needs to handle.
 */
import type { Event } from "@nightshift/contracts";
import {
  createFixtures,
  findSequenceGaps,
  highestSequence,
  isCaughtUp,
  isDense,
  isPending,
  isSequenced,
  makeEvent,
  nextEventIdCursor,
  nextSequenceCursor,
  orderEvents,
  partitionBySequencing,
  pendingCount,
  sequencingLag,
} from "@nightshift/core";
import { createInMemoryStores } from "@nightshift/persistence/memory";
import { beforeEach, describe, expect, it } from "vitest";

const f = createFixtures();

/** An event with an explicit sequence, for pure-function tests. */
const at = (sequence: number | null, suffix = ""): Event =>
  makeEvent(f, { sequence, idempotencyKey: `k${String(sequence)}${suffix}` });

describe("isSequenced / isPending", () => {
  it("splits on null", () => {
    expect(isSequenced(at(0))).toBe(true);
    expect(isPending(at(0))).toBe(false);
    expect(isSequenced(at(null))).toBe(false);
    expect(isPending(at(null))).toBe(true);
  });

  it("treats sequence 0 as numbered, not as absent", () => {
    // The bug this guards against: `!event.sequence` would call 0 unnumbered.
    expect(isSequenced(at(0))).toBe(true);
  });
});

describe("partitionBySequencing", () => {
  it("separates numbered from pending", () => {
    const events = [at(0), at(null, "a"), at(1), at(null, "b")];
    const { sequenced, pending } = partitionBySequencing(events);
    expect(sequenced).toHaveLength(2);
    expect(pending).toHaveLength(2);
  });

  it("reports an empty batch as caught up", () => {
    expect(isCaughtUp([])).toBe(true);
    expect(pendingCount([])).toBe(0);
  });
});

describe("orderEvents", () => {
  it("orders numbered events by sequence", () => {
    const ordered = orderEvents([at(2), at(0), at(1)]);
    expect(ordered.map((e) => e.sequence)).toEqual([0, 1, 2]);
  });

  it("puts pending events last, since they are by construction the newest", () => {
    const ordered = orderEvents([at(null, "a"), at(0), at(null, "b"), at(1)]);
    expect(ordered.map((e) => e.sequence)).toEqual([0, 1, null, null]);
  });

  it("orders pending events by identifier, which is time-ordered", () => {
    const first = makeEvent(f, { sequence: null, idempotencyKey: "p1" });
    const second = makeEvent(f, { sequence: null, idempotencyKey: "p2" });
    const ordered = orderEvents([second, first]);
    expect(ordered.map((e) => e.eventId)).toEqual(
      [first.eventId, second.eventId].sort((x, y) => (x < y ? -1 : 1)),
    );
  });

  it("does not mutate its input", () => {
    const events = [at(2), at(0)];
    const snapshot = [...events];
    orderEvents(events);
    expect(events).toEqual(snapshot);
  });
});

describe("gap detection", () => {
  it("finds nothing in a dense run", () => {
    expect(findSequenceGaps([at(0), at(1), at(2)])).toEqual([]);
    expect(isDense([at(0), at(1), at(2)])).toBe(true);
  });

  it("finds a hole", () => {
    expect(findSequenceGaps([at(0), at(2), at(3)])).toEqual([1]);
    expect(isDense([at(0), at(2), at(3)])).toBe(false);
  });

  it("does not count a pending event as a gap", () => {
    // A late event has no number at all; it is lag, not loss.
    expect(findSequenceGaps([at(0), at(1), at(null)])).toEqual([]);
    expect(pendingCount([at(0), at(1), at(null)])).toBe(1);
  });

  it("respects a window, so events before it are not reported missing", () => {
    expect(findSequenceGaps([at(5), at(7)])).toContain(0);
    expect(findSequenceGaps([at(5), at(7)], 5)).toEqual([6]);
  });

  it("reports nothing when nothing is numbered yet", () => {
    expect(findSequenceGaps([at(null), at(null, "b")])).toEqual([]);
    expect(highestSequence([at(null)])).toBeUndefined();
  });
});

describe("cursors", () => {
  it("a sequence cursor ignores pending events", () => {
    const cursor = nextSequenceCursor([at(0), at(1), at(null)]);
    expect(cursor).toEqual({ kind: "sequence", afterSequence: 1 });
  });

  it("an identifier cursor includes them", () => {
    const pending = makeEvent(f, { sequence: null, idempotencyKey: "tail" });
    const cursor = nextEventIdCursor([at(0), pending]);
    expect(cursor).toEqual({ kind: "eventId", afterEventId: pending.eventId });
  });

  it("both report the beginning for an empty batch", () => {
    expect(nextSequenceCursor([])).toEqual({ kind: "beginning" });
    expect(nextEventIdCursor([])).toEqual({ kind: "beginning" });
  });
});

describe("deferred numbering against the in-memory adapter", () => {
  let stores: ReturnType<typeof createInMemoryStores>;
  let world: ReturnType<typeof createFixtures>;

  beforeEach(() => {
    stores = createInMemoryStores({ deferSequencing: true });
    world = createFixtures();
  });

  const appendMany = async (count: number) => {
    for (let i = 0; i < count; i += 1) {
      await stores.events.append(makeEvent(world, { idempotencyKey: `k${i}` }));
    }
  };

  it("returns a durable event with no number", async () => {
    const result = await stores.events.append(makeEvent(world, { idempotencyKey: "k" }));
    expect(result.stored).toBe(true);
    expect(result.event.sequence).toBeNull();
    expect(isPending(result.event)).toBe(true);
  });

  it("makes the event readable before it is numbered", async () => {
    await appendMany(3);
    const page = await stores.events.listByRun(world.scope);
    expect(page.items).toHaveLength(3);
    expect(isCaughtUp(page.items)).toBe(false);
    expect(sequencingLag(page.items)).toBe(3);
  });

  // The trade A-22 makes explicit: a sequence cursor lags rather than skipping.
  it("hides unnumbered events from a sequence cursor", async () => {
    await appendMany(3);
    const tail = await stores.events.listByRun(world.scope, { afterSequence: -1 });
    expect(tail.items).toHaveLength(0);
  });

  it("numbers them densely from zero, in append order, once materialized", async () => {
    await appendMany(5);
    expect(stores.materializeSequences()).toBe(5);

    const page = await stores.events.listByRun(world.scope);
    expect(page.items.map((e) => e.sequence)).toEqual([0, 1, 2, 3, 4]);
    expect(isCaughtUp(page.items)).toBe(true);
    expect(isDense(page.items)).toBe(true);
  });

  it("makes events visible to a sequence cursor only after numbering", async () => {
    await appendMany(4);
    expect((await stores.events.listByRun(world.scope, { afterSequence: 0 })).items).toHaveLength(
      0,
    );

    stores.materializeSequences();
    const tail = await stores.events.listByRun(world.scope, { afterSequence: 0 });
    expect(tail.items.map((e) => e.sequence)).toEqual([1, 2, 3]);
  });

  it("is idempotent: materializing twice numbers nothing new", async () => {
    await appendMany(3);
    expect(stores.materializeSequences()).toBe(3);
    expect(stores.materializeSequences()).toBe(0);
  });

  it("numbers a mixed batch without renumbering what is already done", async () => {
    await appendMany(2);
    stores.materializeSequences();
    await stores.events.append(makeEvent(world, { idempotencyKey: "late" }));

    const before = await stores.events.listByRun(world.scope);
    expect(before.items.map((e) => e.sequence)).toEqual([0, 1, null]);

    expect(stores.materializeSequences()).toBe(1);
    const after = await stores.events.listByRun(world.scope);
    expect(after.items.map((e) => e.sequence)).toEqual([0, 1, 2]);
  });

  it("still deduplicates on idempotency key while unnumbered", async () => {
    const event = makeEvent(world, { idempotencyKey: "same" });
    const first = await stores.events.append(event);
    const second = await stores.events.append(event);
    expect(second.stored).toBe(false);
    expect(second.event.eventId).toBe(first.event.eventId);
    expect((await stores.events.listByRun(world.scope)).items).toHaveLength(1);
  });

  it("keeps numbering per run when two runs interleave", async () => {
    const other = createFixtures();
    await stores.events.append(makeEvent(world, { idempotencyKey: "a" }));
    await stores.events.append(makeEvent(other, { idempotencyKey: "b" }));
    await stores.events.append(makeEvent(world, { idempotencyKey: "c" }));
    stores.materializeSequences();

    expect((await stores.events.listByRun(world.scope)).items.map((e) => e.sequence)).toEqual([
      0, 1,
    ]);
    expect((await stores.events.listByRun(other.scope)).items.map((e) => e.sequence)).toEqual([0]);
  });

  it("behaves synchronously when deferral is off", async () => {
    const eager = createInMemoryStores();
    const result = await eager.events.append(makeEvent(world, { idempotencyKey: "k" }));
    expect(result.event.sequence).toBe(0);
    expect(eager.materializeSequences()).toBe(0);
  });
});
