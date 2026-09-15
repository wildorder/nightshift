/**
 * The fake's own fidelity checks. The adapter's offline conformance run is only
 * as good as these: each asserts a DynamoDB behaviour the adapter relies on.
 */
import { describe, expect, it } from "vitest";
import { FakeTable } from "./fake-table.js";

const TableName = "t";
const table = (pageItemCap?: number) =>
  new FakeTable(
    pageItemCap === undefined ? { tableName: TableName } : { tableName: TableName, pageItemCap },
  );

const notExists = {
  ConditionExpression: "attribute_not_exists(#pk)",
  ExpressionAttributeNames: { "#pk": "PK" },
};

describe("FakeTable", () => {
  it("fails a conditional put the way DynamoDB names it", async () => {
    const t = table();
    await t.put({ TableName, Item: { PK: "a", SK: "1" }, ...notExists });
    await expect(
      t.put({ TableName, Item: { PK: "a", SK: "1" }, ...notExists }),
    ).rejects.toMatchObject({
      name: "ConditionalCheckFailedException",
    });
  });

  it("applies a transaction all or nothing, reporting reasons by position", async () => {
    const t = table();
    await t.put({ TableName, Item: { PK: "a", SK: "2" } });
    const attempt = t.transactWrite({
      TransactItems: [
        { Put: { TableName, Item: { PK: "a", SK: "1" }, ...notExists } },
        { Put: { TableName, Item: { PK: "a", SK: "2" }, ...notExists } },
      ],
    });
    await expect(attempt).rejects.toMatchObject({
      name: "TransactionCanceledException",
      CancellationReasons: [{ Code: "None" }, { Code: "ConditionalCheckFailed" }],
    });
    expect((await t.get({ TableName, Key: { PK: "a", SK: "1" } })).Item).toBeUndefined();
  });

  it("refuses two operations on one item in a transaction", async () => {
    const t = table();
    await expect(
      t.transactWrite({
        TransactItems: [
          { Put: { TableName, Item: { PK: "a", SK: "1" } } },
          { Put: { TableName, Item: { PK: "a", SK: "1", x: 1 } } },
        ],
      }),
    ).rejects.toMatchObject({ name: "ValidationException" });
  });

  it("returns LastEvaluatedKey whenever Limit is reached, even with nothing after", async () => {
    const t = table();
    await t.put({ TableName, Item: { PK: "a", SK: "x#1" } });
    const out = await t.query({
      TableName,
      KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :p)",
      ExpressionAttributeNames: { "#pk": "PK", "#sk": "SK" },
      ExpressionAttributeValues: { ":pk": "a", ":p": "x#" },
      Limit: 1,
    });
    expect(out.Items).toHaveLength(1);
    expect(out.LastEvaluatedKey).toEqual({ PK: "a", SK: "x#1" });
  });

  it("caps pages like the 1 MB limit when asked", async () => {
    const t = table(2);
    for (const sk of ["1", "2", "3"]) await t.put({ TableName, Item: { PK: "a", SK: sk } });
    const out = await t.query({
      TableName,
      KeyConditionExpression: "#pk = :pk",
      ExpressionAttributeNames: { "#pk": "PK" },
      ExpressionAttributeValues: { ":pk": "a" },
    });
    expect(out.Items).toHaveLength(2);
    expect(out.LastEvaluatedKey).toEqual({ PK: "a", SK: "2" });
  });

  it("refuses a starting key outside the query's key condition", async () => {
    const t = table();
    await expect(
      t.query({
        TableName,
        KeyConditionExpression: "#pk = :pk",
        ExpressionAttributeNames: { "#pk": "PK" },
        ExpressionAttributeValues: { ":pk": "a" },
        ExclusiveStartKey: { PK: "b", SK: "1" },
      }),
    ).rejects.toMatchObject({ name: "ValidationException" });
  });

  it("refuses unused placeholders and bare attribute names", async () => {
    const t = table();
    await expect(
      t.put({
        TableName,
        Item: { PK: "a", SK: "1" },
        ...notExists,
        ExpressionAttributeValues: { ":x": 1 },
      }),
    ).rejects.toMatchObject({ name: "ValidationException" });
    await expect(
      t.put({
        TableName,
        Item: { PK: "a", SK: "1" },
        ConditionExpression: "attribute_not_exists(PK)",
      }),
    ).rejects.toMatchObject({ name: "ValidationException" });
  });

  it("distinguishes a NULL attribute from an absent one", async () => {
    const t = table();
    await t.put({ TableName, Item: { PK: "a", SK: "1", sequence: null } });
    const stamp = (value: number) =>
      t.update({
        TableName,
        Key: { PK: "a", SK: "1" },
        UpdateExpression: "SET #s = :v",
        ConditionExpression: "attribute_type(#s, :null)",
        ExpressionAttributeNames: { "#s": "sequence" },
        ExpressionAttributeValues: { ":v": value, ":null": "NULL" },
      });
    await stamp(0);
    await expect(stamp(1)).rejects.toMatchObject({ name: "ConditionalCheckFailedException" });
    expect((await t.get({ TableName, Key: { PK: "a", SK: "1" } })).Item?.sequence).toBe(0);
  });

  it("serves the index only from items that carry its keys, and never consistently", async () => {
    const t = table();
    await t.put({ TableName, Item: { PK: "a", SK: "1", GSI1PK: "n", GSI1SK: "X#1" } });
    await t.put({ TableName, Item: { PK: "a", SK: "2" } });
    const query = {
      TableName,
      IndexName: "gsi_node",
      KeyConditionExpression: "#h = :h",
      ExpressionAttributeNames: { "#h": "GSI1PK" },
      ExpressionAttributeValues: { ":h": "n" },
    };
    expect((await t.query(query)).Items).toHaveLength(1);
    await expect(t.query({ ...query, ConsistentRead: true })).rejects.toMatchObject({
      name: "ValidationException",
    });
  });

  it("streams committed writes in order, and nothing for a cancelled transaction", async () => {
    const t = table();
    await t.put({ TableName, Item: { PK: "a", SK: "1" } });
    await t.put({ TableName, Item: { PK: "a", SK: "1", v: 2 } });
    await t.delete({ TableName, Key: { PK: "a", SK: "1" } });
    await t
      .transactWrite({
        TransactItems: [
          { Put: { TableName, Item: { PK: "b", SK: "1" } } },
          {
            Put: {
              TableName,
              Item: { PK: "b", SK: "2" },
              ConditionExpression: "attribute_exists(#pk)",
              ExpressionAttributeNames: { "#pk": "PK" },
            },
          },
        ],
      })
      .catch(() => undefined);
    expect(t.drainStream().map((record) => record.eventName)).toEqual([
      "INSERT",
      "MODIFY",
      "REMOVE",
    ]);
  });
});
