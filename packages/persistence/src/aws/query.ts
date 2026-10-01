/**
 * Partition queries with the port's pagination contract.
 *
 * DynamoDB returns a `LastEvaluatedKey` whenever `Limit` is reached, even when
 * nothing follows, and may stop short of `Limit` at its 1 MB page cap. The port
 * promises something tighter: a cursor is present exactly when more items exist.
 * So a page asks for one item more than the caller's limit, follows DynamoDB's
 * own pages until it has them, and derives the cursor from the last item it
 * actually returns.
 */
import type { PageRequest } from "@nightshift/core";
import { assertLimit, decodeKeyCursor, encodeCursor } from "./cursor.js";
import type { Item } from "./items.js";
import { NODE_INDEX_NAME } from "./keys.js";
import type { TableClient } from "./table-client.js";

export interface PartitionQuery {
  /** The partition key value: `PK` on the table, `GSI1PK` on `gsi_node`. */
  readonly partition: string;
  /** Only sort keys beginning with this are returned. */
  readonly prefix: string;
  readonly index?: boolean;
  /** Newest sort key first (P10: a project's utilization records, newest run first). */
  readonly descending?: boolean;
}

export interface ItemPage {
  readonly items: readonly Item[];
  readonly cursor?: string;
}

type StartKey = Record<string, string>;

const TABLE_CURSOR = ["PK", "SK"] as const;
const INDEX_CURSOR = ["GSI1PK", "GSI1SK", "PK", "SK"] as const;

const keyNames = (query: PartitionQuery) =>
  query.index === true
    ? { hash: "GSI1PK", range: "GSI1SK", cursor: INDEX_CURSOR }
    : { hash: "PK", range: "SK", cursor: TABLE_CURSOR };

/**
 * The start key a cursor encodes. A cursor minted for another partition cannot
 * redirect this query — the key condition pins the partition — but DynamoDB would
 * throw an opaque validation error for it, so it is refused in the port's terms.
 */
const startKeyFrom = (query: PartitionQuery, cursor: string | undefined): StartKey | undefined => {
  if (cursor === undefined) return undefined;
  const { hash, range, cursor: attributes } = keyNames(query);
  const key = decodeKeyCursor(cursor, attributes);
  if (key[hash] !== query.partition || !key[range]?.startsWith(query.prefix)) {
    throw new RangeError(`invalid cursor: ${cursor}`);
  }
  return key;
};

/** Reads DynamoDB pages until `wanted` items are in hand or the partition ends. */
const collect = async (
  table: TableClient,
  tableName: string,
  query: PartitionQuery,
  wanted: number,
  from: StartKey | undefined,
): Promise<Item[]> => {
  const { hash, range } = keyNames(query);
  const items: Item[] = [];
  let startKey = from;
  do {
    const output = await table.query({
      TableName: tableName,
      // Strongly consistent where DynamoDB allows it, so a read straight after a
      // write sees the write. A global secondary index cannot be read consistently.
      ...(query.index === true ? { IndexName: NODE_INDEX_NAME } : { ConsistentRead: true }),
      KeyConditionExpression: "#hash = :hash AND begins_with(#range, :prefix)",
      ExpressionAttributeNames: { "#hash": hash, "#range": range },
      ExpressionAttributeValues: { ":hash": query.partition, ":prefix": query.prefix },
      ...(Number.isFinite(wanted) ? { Limit: wanted - items.length } : {}),
      ...(query.descending === true ? { ScanIndexForward: false } : {}),
      ...(startKey === undefined ? {} : { ExclusiveStartKey: startKey }),
    });
    items.push(...((output.Items ?? []) as Item[]));
    startKey = output.LastEvaluatedKey as StartKey | undefined;
  } while (startKey !== undefined && items.length < wanted);
  return items;
};

export const queryPage = async (
  table: TableClient,
  tableName: string,
  query: PartitionQuery,
  page: PageRequest = {},
): Promise<ItemPage> => {
  assertLimit(page.limit);
  const from = startKeyFrom(query, page.cursor);
  const wanted = page.limit === undefined ? Number.POSITIVE_INFINITY : page.limit + 1;
  const items = await collect(table, tableName, query, wanted, from);

  if (page.limit === undefined || items.length <= page.limit) return { items };

  const returned = items.slice(0, page.limit);
  const last = returned[returned.length - 1] as Item;
  const { cursor: attributes } = keyNames(query);
  return {
    items: returned,
    cursor: encodeCursor(Object.fromEntries(attributes.map((name) => [name, last[name]]))),
  };
};

/** Every item in the partition, following pages to the end. */
export const queryAll = async (
  table: TableClient,
  tableName: string,
  query: PartitionQuery,
): Promise<readonly Item[]> => (await queryPage(table, tableName, query)).items;
