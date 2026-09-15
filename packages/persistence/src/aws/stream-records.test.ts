import { createFixtures, makeEvent } from "@nightshift/core";
import { describe, expect, it } from "vitest";
import { createDynamoSequenceLedger } from "./sequence-ledger.js";
import { createAwsStores } from "./stores.js";
import { parseStreamRecord } from "./stream-records.js";
import { FakeTable } from "./testing/fake-table.js";
import { toStreamRecord } from "./testing/index.js";

const tableName = "nightshift-test";

describe("parseStreamRecord", () => {
  it("finds exactly the event among an append's two inserts", async () => {
    const table = new FakeTable({ tableName });
    const f = createFixtures();
    const event = makeEvent(f, { idempotencyKey: "k" });
    await createAwsStores({ tableName, table }).events.append(event);

    const parsed = table.drainStream().map((record) => parseStreamRecord(toStreamRecord(record)));
    expect(parsed.map((p) => p.kind)).toEqual(["ignored", "event"]);
    expect(parsed[1]).toMatchObject({ kind: "event", scope: f.scope, eventId: event.eventId });
  });

  it("ignores the stamp and the counter it writes, so the consumer cannot feed itself", async () => {
    const table = new FakeTable({ tableName });
    const f = createFixtures();
    const event = makeEvent(f, { idempotencyKey: "k" });
    await createAwsStores({ tableName, table }).events.append(event);
    table.drainStream();

    await createDynamoSequenceLedger({ tableName, table }).stamp(f.scope, event.eventId);
    const kinds = table
      .drainStream()
      .map((record) => parseStreamRecord(toStreamRecord(record)).kind);
    expect(kinds.length).toBeGreaterThan(0);
    expect(kinds.every((kind) => kind === "ignored")).toBe(true);
  });

  it("reports an event insert it cannot attribute to a run as malformed", () => {
    const record = toStreamRecord({
      eventName: "INSERT",
      sequenceNumber: "9",
      keys: { PK: "EVT#x", SK: "ULID#evt_x" },
      newImage: { PK: "EVT#x", SK: "ULID#evt_x", projectId: "not-an-id" },
    });
    expect(parseStreamRecord(record)).toMatchObject({ kind: "malformed", recordId: "9" });
    expect(
      parseStreamRecord({
        eventName: "INSERT",
        dynamodb: { Keys: { SK: { S: "ULID#e" } }, SequenceNumber: "10" },
      }),
    ).toMatchObject({ kind: "malformed", recordId: "10" });
  });
});
