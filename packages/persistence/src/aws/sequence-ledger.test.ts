/**
 * The ledger's one promise: a crash can delay a number but never burn one (A-22).
 * These tests inject the crashes rather than assuming them away.
 */
import { createFixtures, findSequenceGaps, makeEvent } from "@nightshift/core";
import { beforeEach, describe, expect, it } from "vitest";
import { keys } from "./keys.js";
import { createDynamoSequenceLedger } from "./sequence-ledger.js";
import { createAwsStores } from "./stores.js";
import type { TableClient } from "./table-client.js";
import { FakeTable } from "./testing/fake-table.js";

const tableName = "nightshift-test";

/** Delegates to `inner`, letting a test intercept `transactWrite`. */
const intercepting = (
  inner: TableClient,
  transactWrite: TableClient["transactWrite"],
): TableClient => ({
  get: (input) => inner.get(input),
  put: (input) => inner.put(input),
  update: (input) => inner.update(input),
  delete: (input) => inner.delete(input),
  query: (input) => inner.query(input),
  scan: (input) => inner.scan(input),
  transactWrite,
});

describe("DynamoDB sequence ledger", () => {
  let table: FakeTable;
  let stores: ReturnType<typeof createAwsStores>;
  let f: ReturnType<typeof createFixtures>;

  beforeEach(() => {
    table = new FakeTable({ tableName });
    stores = createAwsStores({ tableName, table });
    f = createFixtures();
  });

  const appendThree = async () => {
    const events = [0, 1, 2].map((i) => makeEvent(f, { idempotencyKey: `k${i}` }));
    for (const event of events) await stores.events.append(event);
    return events;
  };

  it("numbers a fresh run densely from zero", async () => {
    const ledger = createDynamoSequenceLedger({ tableName, table });
    const events = await appendThree();
    const outcomes = [];
    for (const event of events) outcomes.push(await ledger.stamp(f.scope, event.eventId));

    expect(outcomes).toEqual([0, 1, 2].map((sequence) => ({ kind: "stamped", sequence })));
    expect(await stores.events.nextSequence(f.scope)).toBe(3);
    expect((await stores.events.listByRun(f.scope)).items.map((e) => e.sequence)).toEqual([
      0, 1, 2,
    ]);
  });

  it("treats redelivery as a no-op that consumes no number", async () => {
    const ledger = createDynamoSequenceLedger({ tableName, table });
    const [first] = await appendThree();
    await ledger.stamp(f.scope, first?.eventId as never);
    expect(await ledger.stamp(f.scope, first?.eventId as never)).toEqual({
      kind: "already_numbered",
      sequence: 0,
    });
    expect(await stores.events.nextSequence(f.scope)).toBe(1);
  });

  it("skips an event that no longer exists", async () => {
    const ledger = createDynamoSequenceLedger({ tableName, table });
    expect(await ledger.stamp(f.scope, f.ids.next("evt"))).toEqual({ kind: "missing" });
    expect(await stores.events.nextSequence(f.scope)).toBe(0);
  });

  it("burns no number when the consumer dies after the write commits", async () => {
    const events = await appendThree();
    const crashing = createDynamoSequenceLedger({
      tableName,
      table: intercepting(table, async (input) => {
        await table.transactWrite(input);
        throw new Error("Lambda timed out after the commit");
      }),
    });
    await expect(crashing.stamp(f.scope, events[0]?.eventId as never)).rejects.toThrow(/timed out/);

    // Redelivery of the same record, then the rest of the batch.
    const ledger = createDynamoSequenceLedger({ tableName, table });
    for (const event of events) await ledger.stamp(f.scope, event.eventId);

    const listed = (await stores.events.listByRun(f.scope)).items;
    expect(listed.map((e) => e.sequence)).toEqual([0, 1, 2]);
    expect(findSequenceGaps(listed)).toEqual([]);
    expect(await stores.events.nextSequence(f.scope)).toBe(3);
  });

  it("changes nothing when the consumer dies before the write", async () => {
    const [first] = await appendThree();
    const crashing = createDynamoSequenceLedger({
      tableName,
      table: intercepting(table, async () => {
        throw new Error("Lambda timed out before the commit");
      }),
    });
    await expect(crashing.stamp(f.scope, first?.eventId as never)).rejects.toThrow(/before/);
    expect(await stores.events.nextSequence(f.scope)).toBe(0);

    const ledger = createDynamoSequenceLedger({ tableName, table });
    expect(await ledger.stamp(f.scope, first?.eventId as never)).toEqual({
      kind: "stamped",
      sequence: 0,
    });
  });

  it("gives two racing consumers distinct numbers, retrying the loser", async () => {
    const [first, second] = await appendThree();
    const one = createDynamoSequenceLedger({ tableName, table });
    const two = createDynamoSequenceLedger({ tableName, table });
    const outcomes = await Promise.all([
      one.stamp(f.scope, first?.eventId as never),
      two.stamp(f.scope, second?.eventId as never),
    ]);
    const numbers = outcomes.map((o) => (o.kind === "stamped" ? o.sequence : -1)).sort();
    expect(numbers).toEqual([0, 1]);
    expect(await stores.events.nextSequence(f.scope)).toBe(2);
  });

  it("gives up loudly, rather than looping, when the counter never settles", async () => {
    const [first] = await appendThree();
    let bumps = 0;
    const ledger = createDynamoSequenceLedger({
      tableName,
      maxAttempts: 3,
      table: intercepting(table, async (input) => {
        // Another writer advances the counter between every read and write.
        bumps += 1;
        await table.put({
          TableName: tableName,
          Item: { ...keys.counter(f.scope), next: 100 + bumps },
        });
        return table.transactWrite(input);
      }),
    });
    await expect(ledger.stamp(f.scope, first?.eventId as never)).rejects.toThrow(
      /after 3 attempts/,
    );
    expect((await stores.events.listByRun(f.scope)).items.every((e) => e.sequence === null)).toBe(
      true,
    );
  });

  it("numbers two runs independently", async () => {
    const ledger = createDynamoSequenceLedger({ tableName, table });
    const other = createFixtures();
    const a = makeEvent(f, { idempotencyKey: "a" });
    const b = makeEvent(other, { idempotencyKey: "b" });
    await stores.events.append(a);
    await stores.events.append(b);
    expect(await ledger.stamp(f.scope, a.eventId)).toEqual({ kind: "stamped", sequence: 0 });
    expect(await ledger.stamp(other.scope, b.eventId)).toEqual({ kind: "stamped", sequence: 0 });
  });
});
