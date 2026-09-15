/**
 * Phase 4: removing what the smoke suite wrote (T7). Records and S3 prefixes
 * only — never a stack (A-18). With teardown testing dropped, litter in the only
 * environment matters more, not less.
 */
import { DeleteObjectsCommand, ListObjectsV2Command, type S3Client } from "@aws-sdk/client-s3";
import type { TableClient } from "@nightshift/persistence/aws";

type Key = { PK: string; SK: string };

const keysIn = async (table: TableClient, tableName: string, partition: string): Promise<Key[]> => {
  const found: Key[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await table.query({
      TableName: tableName,
      ConsistentRead: true,
      KeyConditionExpression: "#pk = :pk",
      ProjectionExpression: "#pk, #sk",
      ExpressionAttributeNames: { "#pk": "PK", "#sk": "SK" },
      ExpressionAttributeValues: { ":pk": partition },
      ...(startKey === undefined ? {} : { ExclusiveStartKey: startKey }),
    });
    for (const item of page.Items ?? []) found.push({ PK: String(item.PK), SK: String(item.SK) });
    startKey = page.LastEvaluatedKey;
  } while (startKey !== undefined);
  return found;
};

/**
 * Deletes every item in each partition and confirms each is empty afterwards,
 * re-reading a few times in case a late write landed between the read and the
 * delete. Returns how many items were deleted.
 */
export const deletePartitions = async (
  table: TableClient,
  tableName: string,
  partitions: Iterable<string>,
): Promise<number> => {
  let deleted = 0;
  for (const partition of partitions) {
    for (let pass = 0; pass < 5; pass += 1) {
      const found = await keysIn(table, tableName, partition);
      if (found.length === 0) break;
      for (const key of found) {
        await table.delete({ TableName: tableName, Key: key });
        deleted += 1;
      }
    }
    if ((await keysIn(table, tableName, partition)).length > 0) {
      throw new Error(`partition ${partition} still holds items after five passes`);
    }
  }
  return deleted;
};

/**
 * The conformance suite mints identifiers from a counting generator, so every one
 * encodes a ULID timestamp of zero — the Unix epoch — which no real identifier in
 * this table can. That is what makes its litter safe to find by scanning.
 */
const CONFORMANCE_MARKERS = ["_0000000000", "-0000000000"] as const;

export const deleteConformanceLitter = async (
  table: TableClient,
  tableName: string,
): Promise<number> => {
  const litter: Key[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await table.scan({
      TableName: tableName,
      ConsistentRead: true,
      FilterExpression: "contains(#pk, :underscore) OR contains(#pk, :hyphen)",
      ProjectionExpression: "#pk, #sk",
      ExpressionAttributeNames: { "#pk": "PK", "#sk": "SK" },
      ExpressionAttributeValues: {
        ":underscore": CONFORMANCE_MARKERS[0],
        ":hyphen": CONFORMANCE_MARKERS[1],
      },
      ...(startKey === undefined ? {} : { ExclusiveStartKey: startKey }),
    });
    for (const item of page.Items ?? []) litter.push({ PK: String(item.PK), SK: String(item.SK) });
    startKey = page.LastEvaluatedKey;
  } while (startKey !== undefined);

  for (const key of litter) await table.delete({ TableName: tableName, Key: key });
  return litter.length;
};

/** Deletes every object under `prefix`. Returns how many were deleted. */
export const deleteObjectsUnder = async (
  s3: S3Client,
  bucket: string,
  prefix: string,
): Promise<number> => {
  let deleted = 0;
  let continuation: string | undefined;
  do {
    const listed = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ...(continuation === undefined ? {} : { ContinuationToken: continuation }),
      }),
    );
    const objects = (listed.Contents ?? []).flatMap((object) =>
      object.Key === undefined ? [] : [{ Key: object.Key }],
    );
    if (objects.length > 0) {
      await s3.send(
        new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects, Quiet: true } }),
      );
      deleted += objects.length;
    }
    continuation = listed.IsTruncated === true ? listed.NextContinuationToken : undefined;
  } while (continuation !== undefined);
  return deleted;
};
