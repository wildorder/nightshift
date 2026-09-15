/**
 * Numbering events on DynamoDB (A-22, T6).
 *
 * T6 describes two steps — advance the run's counter, then stamp the event on
 * the condition it is still unnumbered. Run as two separate writes, a crash
 * between them consumes a number no event carries, and redelivery consumes
 * another: exactly the gap A-22 says cannot happen. So both are one
 * transaction here. The counter is advanced conditionally on the value just read
 * (optimistic concurrency) and the event is stamped conditionally on still being
 * unnumbered; DynamoDB applies both or neither.
 *
 * A redelivered record then finds its event numbered and changes nothing. A
 * record whose event was deleted finds nothing and changes nothing. A concurrent
 * consumer that moved the counter first makes the transaction fail, and the
 * attempt is simply re-read and retried.
 */
import type { TransactWriteCommandInput } from "@aws-sdk/lib-dynamodb";
import type { SequenceLedger, StampOutcome } from "@nightshift/core";
import { COUNTER_ATTRIBUTE } from "./events.js";
import type { Item } from "./items.js";
import { keys, type TableKey } from "./keys.js";
import { conditionFailures, type TableClient } from "./table-client.js";

export interface SequenceLedgerConfig {
  readonly tableName: string;
  readonly table: TableClient;
  /** How many times to re-read and retry when the counter moves underneath. */
  readonly maxAttempts?: number;
}

type TransactItem = NonNullable<TransactWriteCommandInput["TransactItems"]>[number];

/** Advances the counter from `current`, creating it if it does not exist yet. */
const advanceCounter = (
  tableName: string,
  key: TableKey,
  counter: Item | undefined,
  current: number,
): TransactItem =>
  counter === undefined
    ? {
        Put: {
          TableName: tableName,
          Item: { ...key, [COUNTER_ATTRIBUTE]: current + 1 },
          ConditionExpression: "attribute_not_exists(#pk)",
          ExpressionAttributeNames: { "#pk": "PK" },
        },
      }
    : {
        Update: {
          TableName: tableName,
          Key: key,
          UpdateExpression: "SET #next = :advanced",
          ConditionExpression: "#next = :current",
          ExpressionAttributeNames: { "#next": COUNTER_ATTRIBUTE },
          ExpressionAttributeValues: { ":advanced": current + 1, ":current": current },
        },
      };

/** Stamps `sequence` on the event, only if it still exists and is unnumbered. */
const stampEvent = (tableName: string, key: TableKey, sequence: number): TransactItem => ({
  Update: {
    TableName: tableName,
    Key: key,
    UpdateExpression: "SET #sequence = :sequence",
    ConditionExpression: "attribute_exists(#pk) AND attribute_type(#sequence, :null)",
    ExpressionAttributeNames: { "#pk": "PK", "#sequence": "sequence" },
    ExpressionAttributeValues: { ":sequence": sequence, ":null": "NULL" },
  },
});

export const createDynamoSequenceLedger = ({
  tableName,
  table,
  maxAttempts = 5,
}: SequenceLedgerConfig): SequenceLedger => {
  const read = async (key: TableKey): Promise<Item | undefined> =>
    (await table.get({ TableName: tableName, Key: key, ConsistentRead: true })).Item;

  /**
   * One read-decide-write attempt. `undefined` means a condition failed because
   * the world moved — the counter advanced, or the event was numbered or deleted —
   * so the caller should re-read and decide again.
   */
  const attempt = async (
    ...[scope, eventId]: Parameters<SequenceLedger["stamp"]>
  ): Promise<StampOutcome | undefined> => {
    const eventKey = keys.event(scope, eventId);
    const event = await read(eventKey);
    if (event === undefined) return { kind: "missing" };
    if (typeof event.sequence === "number") {
      return { kind: "already_numbered", sequence: event.sequence };
    }

    const counterKey = keys.counter(scope);
    const counter = await read(counterKey);
    const stored = counter?.[COUNTER_ATTRIBUTE];
    const current = typeof stored === "number" ? stored : 0;

    try {
      await table.transactWrite({
        TransactItems: [
          advanceCounter(tableName, counterKey, counter, current),
          stampEvent(tableName, eventKey, current),
        ],
      });
      return { kind: "stamped", sequence: current };
    } catch (error) {
      if (conditionFailures(error) === undefined) throw error;
      return undefined;
    }
  };

  return {
    stamp: async (scope, eventId): Promise<StampOutcome> => {
      for (let tries = 1; tries <= maxAttempts; tries += 1) {
        const outcome = await attempt(scope, eventId);
        if (outcome !== undefined) return outcome;
      }

      throw new Error(
        `could not number event ${eventId} after ${maxAttempts} attempts: the run's counter kept moving`,
      );
    },
  };
};
