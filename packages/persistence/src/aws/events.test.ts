/**
 * What reading a run's events costs on DynamoDB, and that the event-sequence
 * index never lets a reader skip one (2026-10-22). The conformance suite proves
 * the order and the paging; these prove a poll reads what it returns, a paged
 * read of the whole log reads each event about once, and an event the index has
 * not caught up with is waited for, not jumped.
 */
import type { QueryCommandInput } from "@aws-sdk/lib-dynamodb";
import { createFixtures, makeEvent } from "@nightshift/core";
import { beforeEach, describe, expect, it } from "vitest";
import { EVENT_SEQUENCE_ATTRIBUTE, EVENT_SEQUENCE_INDEX_NAME, keys } from "./keys.js";
import { createDynamoSequenceLedger } from "./sequence-ledger.js";
import { createAwsStores } from "./stores.js";
import type { TableClient } from "./table-client.js";
import { FakeTable } from "./testing/fake-table.js";

const tableName = "nightshift-test";

/** Every query the store makes, and the items each returned, over `inner`. */
const counting = (inner: TableClient, hidden: Set<number> = new Set()) => {
  const queries: { readonly input: QueryCommandInput; readonly returned: number }[] = [];
  const client: TableClient = {
    get: (input) => inner.get(input),
    put: (input) => inner.put(input),
    update: (input) => inner.update(input),
    delete: (input) => inner.delete(input),
    scan: (input) => inner.scan(input),
    transactWrite: (input) => inner.transactWrite(input),
    query: async (input) => {
      const output = await inner.query(input);
      // The index trailing the table: a hidden sequence is not in it yet.
      const items =
        input.IndexName === EVENT_SEQUENCE_INDEX_NAME
          ? (output.Items ?? []).filter(
              (item) => !hidden.has(item[EVENT_SEQUENCE_ATTRIBUTE] as number),
            )
          : (output.Items ?? []);
      queries.push({ input, returned: items.length });
      return { ...output, Items: items };
    },
  };
  return { client, queries };
};

describe("reading a run's events through the event-sequence index", () => {
  let table: FakeTable;
  let f: ReturnType<typeof createFixtures>;

  beforeEach(() => {
    table = new FakeTable({ tableName, pageItemCap: 50 });
    f = createFixtures();
  });

  /** `count` events appended and numbered, as the materializer would. */
  const seed = async (count: number) => {
    const stores = createAwsStores({ tableName, table });
    const ledger = createDynamoSequenceLedger({ tableName, table });
    for (let i = 0; i < count; i += 1) {
      const event = makeEvent(f, { idempotencyKey: `k${i}` });
      await stores.events.append(event);
      await ledger.stamp(f.scope, event.eventId);
    }
  };

  it("puts a numbered event in the index, and an unnumbered one never", async () => {
    await seed(2);
    const stores = createAwsStores({ tableName, table });
    await stores.events.append(makeEvent(f, { idempotencyKey: "unnumbered" }));
    const indexed = await table.query({
      TableName: tableName,
      IndexName: EVENT_SEQUENCE_INDEX_NAME,
      KeyConditionExpression: "#p = :p",
      ExpressionAttributeNames: { "#p": "SEQPK" },
      ExpressionAttributeValues: { ":p": keys.eventPartition(f.scope).PK },
    });
    expect(indexed.Items?.map((item) => item.SEQ)).toEqual([0, 1]);
    // The index keys are not fields of the event.
    const [first] = (await stores.events.listByRun(f.scope, { afterSequence: -1 })).items;
    expect(first).not.toHaveProperty("SEQ");
    expect(first).not.toHaveProperty("SEQPK");
  });

  it("answers a poll from a sequence from the index alone, reading what it returns", async () => {
    await seed(200);
    const { client, queries } = counting(table);
    const stores = createAwsStores({ tableName, table: client });
    const page = await stores.events.listByRun(f.scope, { afterSequence: 195 });
    expect(page.items.map((e) => e.sequence)).toEqual([196, 197, 198, 199]);
    expect(queries.every((q) => q.input.IndexName === EVENT_SEQUENCE_INDEX_NAME)).toBe(true);
    expect(queries.reduce((sum, q) => sum + q.returned, 0)).toBe(4);
  });

  it("reads each event about once when the whole log is paged, not once per page", async () => {
    await seed(300);
    const { client, queries } = counting(table);
    const stores = createAwsStores({ tableName, table: client });
    const sequences: (number | null)[] = [];
    let cursor: string | undefined;
    do {
      const page = await stores.events.listByRun(
        f.scope,
        cursor === undefined ? { limit: 100 } : { limit: 100, cursor },
      );
      sequences.push(...page.items.map((e) => e.sequence));
      cursor = page.cursor;
    } while (cursor !== undefined);
    expect(sequences).toEqual([...Array(300).keys()]);
    const fromIndex = queries
      .filter((q) => q.input.IndexName === EVENT_SEQUENCE_INDEX_NAME)
      .reduce((sum, q) => sum + q.returned, 0);
    // Each page asks one beyond its limit, to know whether another follows.
    expect(fromIndex).toBeLessThanOrEqual(300 + 3);
    // The table is read once, for the unnumbered tail, on the last page.
    expect(queries.filter((q) => q.input.IndexName === undefined)).toHaveLength(
      Math.ceil(300 / 50),
    );
  });

  it("waits at an event the index has not caught up with, and never skips it", async () => {
    await seed(6);
    const hidden = new Set([3]);
    const { client } = counting(table, hidden);
    const stores = createAwsStores({ tableName, table: client });
    // A poll lags behind the gap rather than jumping it…
    const poll = await stores.events.listByRun(f.scope, { afterSequence: 0 });
    expect(poll.items.map((e) => e.sequence)).toEqual([1, 2]);
    // …and a reader of the whole log gets the rest, in order, from the table.
    const whole = await stores.events.listByRun(f.scope);
    expect(whole.items.map((e) => e.sequence)).toEqual([0, 1, 2, 3, 4, 5]);
    // Once the index has it, the poll moves on.
    hidden.clear();
    expect(
      (await stores.events.listByRun(f.scope, { afterSequence: 2 })).items.map((e) => e.sequence),
    ).toEqual([3, 4, 5]);
  });

  it("gives the unnumbered tail after the numbered events, and pages through it", async () => {
    await seed(3);
    const stores = createAwsStores({ tableName, table });
    for (let i = 0; i < 3; i += 1) {
      await stores.events.append(makeEvent(f, { idempotencyKey: `pending-${i}` }));
    }
    const first = await stores.events.listByRun(f.scope, { limit: 4 });
    expect(first.items.map((e) => e.sequence)).toEqual([0, 1, 2, null]);
    const rest = await stores.events.listByRun(f.scope, {
      limit: 4,
      ...(first.cursor === undefined ? {} : { cursor: first.cursor }),
    });
    expect(rest.items.map((e) => e.sequence)).toEqual([null, null]);
    expect(rest.cursor).toBeUndefined();
    // A poll from a sequence does not see them: it lags, never skips.
    expect((await stores.events.listByRun(f.scope, { afterSequence: 2 })).items).toEqual([]);
  });
});
