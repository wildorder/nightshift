/**
 * The materializer against the in-memory adapter, with `materializeSequences()`
 * as the reference numbering (T6 deliverable 6).
 */
import type { Event } from "@nightshift/contracts";
import {
  createFixtures,
  type Fixtures,
  findSequenceGaps,
  makeEvent,
  type SequenceLedger,
} from "@nightshift/core";
import { createInMemoryStores, type InMemoryStores } from "@nightshift/persistence/memory";
import { describe, expect, it } from "vitest";
import { type MaterializerRecord, materializeBatch } from "./materialize.js";

let recordCounter = 0;

const insertOf = (event: Event): MaterializerRecord => {
  recordCounter += 1;
  return {
    kind: "event",
    recordId: `seq-${recordCounter}`,
    scope: { projectId: event.projectId, programId: event.programId, runId: event.runId },
    eventId: event.eventId,
  };
};

const appendAll = async (stores: InMemoryStores, f: Fixtures, count: number, tag = "k") => {
  const events: Event[] = [];
  for (let i = 0; i < count; i += 1) {
    events.push((await stores.events.append(makeEvent(f, { idempotencyKey: `${tag}${i}` }))).event);
  }
  return events;
};

const sequencesOf = async (stores: InMemoryStores, f: Fixtures) =>
  (await stores.events.listByRun(f.scope)).items.map((event) => event.sequence);

describe("materializeBatch", () => {
  it("numbers a fresh run from zero, exactly as the reference numbering does", async () => {
    const f = createFixtures();
    const stores = createInMemoryStores({ deferSequencing: true });
    const reference = createInMemoryStores({ deferSequencing: true });
    const events = await appendAll(stores, f, 5);
    for (const event of events) await reference.events.append(event);

    const result = await materializeBatch(stores.sequenceLedger, events.map(insertOf));
    reference.materializeSequences();

    expect(result).toMatchObject({ stamped: 5, batchItemFailures: [] });
    expect(await sequencesOf(stores, f)).toEqual([0, 1, 2, 3, 4]);
    expect((await stores.events.listByRun(f.scope)).items).toEqual(
      (await reference.events.listByRun(f.scope)).items,
    );
  });

  it("leaves already-numbered events alone in a mixed batch", async () => {
    const f = createFixtures();
    const stores = createInMemoryStores({ deferSequencing: true });
    const events = await appendAll(stores, f, 4);
    await materializeBatch(stores.sequenceLedger, events.slice(0, 2).map(insertOf));

    const result = await materializeBatch(stores.sequenceLedger, events.map(insertOf));
    expect(result).toMatchObject({ stamped: 2, alreadyNumbered: 2 });
    expect(await sequencesOf(stores, f)).toEqual([0, 1, 2, 3]);
  });

  it("treats redelivery of a whole batch as a no-op that consumes no number", async () => {
    const f = createFixtures();
    const stores = createInMemoryStores({ deferSequencing: true });
    const batch = (await appendAll(stores, f, 3)).map(insertOf);
    await materializeBatch(stores.sequenceLedger, batch);

    const replay = await materializeBatch(stores.sequenceLedger, batch);
    expect(replay).toMatchObject({ stamped: 0, alreadyNumbered: 3, batchItemFailures: [] });
    expect(await sequencesOf(stores, f)).toEqual([0, 1, 2]);
    expect(await stores.events.nextSequence(f.scope)).toBe(3);
  });

  it("numbers two runs interleaved in one batch independently", async () => {
    const a = createFixtures();
    const b = createFixtures();
    const stores = createInMemoryStores({ deferSequencing: true });
    const inA = await appendAll(stores, a, 3, "a");
    const inB = await appendAll(stores, b, 2, "b");
    const interleaved = [inA[0], inB[0], inA[1], inB[1], inA[2]].map((e) => insertOf(e as Event));

    await materializeBatch(stores.sequenceLedger, interleaved);
    expect(await sequencesOf(stores, a)).toEqual([0, 1, 2]);
    expect(await sequencesOf(stores, b)).toEqual([0, 1]);
  });

  it("skips a record whose event no longer exists instead of throwing", async () => {
    const f = createFixtures();
    const stores = createInMemoryStores({ deferSequencing: true });
    const ghost: MaterializerRecord = {
      kind: "event",
      recordId: "ghost",
      scope: f.scope,
      eventId: f.ids.next("evt"),
    };
    const [real] = await appendAll(stores, f, 1);

    const result = await materializeBatch(stores.sequenceLedger, [ghost, insertOf(real as Event)]);
    expect(result).toMatchObject({ missing: 1, stamped: 1, batchItemFailures: [] });
    expect(await sequencesOf(stores, f)).toEqual([0]);
  });

  it("ignores records that are not event inserts", async () => {
    const stores = createInMemoryStores({ deferSequencing: true });
    const result = await materializeBatch(stores.sequenceLedger, [
      { kind: "ignored", recordId: "counter" },
      { kind: "ignored", recordId: "marker" },
    ]);
    expect(result).toMatchObject({ ignored: 2, batchItemFailures: [] });
  });

  it("holds back the rest of a failing run, lets other runs proceed, and recovers densely", async () => {
    const a = createFixtures();
    const b = createFixtures();
    const stores = createInMemoryStores({ deferSequencing: true });
    const inA = await appendAll(stores, a, 3, "a");
    const inB = await appendAll(stores, b, 1, "b");
    const poisoned = inA[1]?.eventId;

    // A ledger that fails once on one event, as a throttled write would.
    let failedOnce = false;
    const flaky: SequenceLedger = {
      stamp: async (scope, eventId) => {
        if (eventId === poisoned && !failedOnce) {
          failedOnce = true;
          throw new Error("ProvisionedThroughputExceededException");
        }
        return stores.sequenceLedger.stamp(scope, eventId);
      },
    };
    const batch = [inA[0], inA[1], inB[0], inA[2]].map((e) => insertOf(e as Event));
    const errors: string[] = [];

    const first = await materializeBatch(flaky, batch, {
      error: (message) => errors.push(message),
    });
    expect(first.batchItemFailures.map((f) => f.itemIdentifier)).toEqual([
      batch[1]?.recordId,
      batch[3]?.recordId,
    ]);
    expect(await sequencesOf(stores, a)).toEqual([0, null, null]);
    expect(await sequencesOf(stores, b)).toEqual([0]);
    expect(errors).toHaveLength(1);

    // Lambda redelivers from the first failed record onward.
    const retry = await materializeBatch(flaky, batch.slice(1));
    expect(retry.batchItemFailures).toEqual([]);
    const numbered = (await stores.events.listByRun(a.scope)).items;
    expect(numbered.map((e) => e.sequence)).toEqual([0, 1, 2]);
    expect(numbered.map((e) => e.eventId)).toEqual(inA.map((e) => e.eventId));
    expect(findSequenceGaps(numbered)).toEqual([]);
  });

  it("blocks everything after a record it cannot attribute to a run", async () => {
    const f = createFixtures();
    const stores = createInMemoryStores({ deferSequencing: true });
    const [event] = await appendAll(stores, f, 1);
    const result = await materializeBatch(stores.sequenceLedger, [
      { kind: "malformed", recordId: "bad", reason: "no image" },
      insertOf(event as Event),
    ]);
    expect(result.batchItemFailures).toHaveLength(2);
    expect(await sequencesOf(stores, f)).toEqual([null]);
  });
});
