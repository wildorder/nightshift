/**
 * The publisher's lock on a run (P10, D-P10-22), as a row in the table: taken
 * with a conditional put that succeeds when the row is absent or its lease has
 * lapsed, released by deleting it. A new account's Lambda concurrency quota
 * leaves nothing to reserve, so the serial order lives here, where it works at
 * any quota.
 */
import { isConditionalCheckFailure, keys, type TableClient } from "@nightshift/persistence/aws";
import { isLineScope, type PublishLock, type PublishTarget } from "../runner/publisher.js";

const lockKeyOf = (target: PublishTarget) =>
  isLineScope(target)
    ? keys.linePublishLock(target.projectId, target.branch)
    : keys.publishLock(target.runId);

export const createDynamoPublishLock = (table: TableClient, tableName: string): PublishLock => ({
  acquire: async (scope, leaseMs) => {
    const now = Date.now();
    try {
      await table.put({
        TableName: tableName,
        Item: {
          ...lockKeyOf(scope),
          entity: "PublishLock",
          ...(isLineScope(scope)
            ? { projectId: scope.projectId, branch: scope.branch }
            : { runId: scope.runId }),
          takenAt: new Date(now).toISOString(),
          expiresAtMs: now + leaseMs,
        },
        ConditionExpression: "attribute_not_exists(#pk) OR #expires < :now",
        ExpressionAttributeNames: { "#pk": "PK", "#expires": "expiresAtMs" },
        ExpressionAttributeValues: { ":now": now },
      });
      return true;
    } catch (error) {
      if (isConditionalCheckFailure(error)) return false;
      throw error;
    }
  },
  release: async (scope) => {
    await table.delete({ TableName: tableName, Key: lockKeyOf(scope) });
  },
});
