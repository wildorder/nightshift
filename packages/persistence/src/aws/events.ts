/**
 * The event store on DynamoDB (contract §4.4, A-22).
 *
 * `append` is synchronous and durable, and never numbers the event: it writes
 * `sequence: null`, and the Streams consumer numbers it afterwards through the
 * `SequenceLedger`. Idempotency is a write condition, not a read-then-write: the
 * event and a marker keyed by its idempotency key are written in one transaction,
 * conditional on the marker not existing (D-P2-17), so two concurrent duplicates
 * cannot both land, even with different event identifiers.
 */
import { type Event, type EventId, EventSchema } from "@nightshift/contracts";
import {
  type AppendResult,
  type EventStore,
  orderEvents,
  type PageRequest,
  type RunScope,
  runScopeOf,
} from "@nightshift/core";
import { assertLimit, decodeCursor, encodeCursor } from "./cursor.js";
import { fromItem, toItem } from "./items.js";
import { keys } from "./keys.js";
import { queryAll } from "./query.js";
import { conditionFailures, type TableClient } from "./table-client.js";

export interface EventStoreConfig {
  readonly tableName: string;
  readonly table: TableClient;
}

/** The counter item's attribute holding the next number to assign. */
export const COUNTER_ATTRIBUTE = "next";

/** A position in `orderEvents` order: numbered by sequence, then unnumbered by identifier. */
interface EventPosition {
  readonly sequence: number | null;
  readonly eventId: string;
}

const positionOf = (event: Event): EventPosition => ({
  sequence: event.sequence,
  eventId: event.eventId,
});

const comesAfter = (event: Event, position: EventPosition): boolean => {
  if (position.sequence !== null) {
    return event.sequence === null || event.sequence > position.sequence;
  }
  return event.sequence === null && event.eventId > position.eventId;
};

const decodePosition = (cursor: string): EventPosition => {
  const decoded = decodeCursor(cursor);
  const sequence = decoded.sequence;
  const eventId = decoded.eventId;
  if (
    typeof eventId !== "string" ||
    !(sequence === null || (typeof sequence === "number" && Number.isInteger(sequence)))
  ) {
    throw new RangeError(`invalid cursor: ${cursor}`);
  }
  return { sequence, eventId };
};

export const createEventStore = ({ tableName, table }: EventStoreConfig): EventStore => {
  const getEvent = async (scope: RunScope, eventId: string): Promise<Event | undefined> => {
    const output = await table.get({
      TableName: tableName,
      Key: keys.event(scope, eventId),
      ConsistentRead: true,
    });
    return output.Item === undefined ? undefined : fromItem(EventSchema, output.Item);
  };

  const findByIdempotencyKey = async (scope: RunScope, idempotencyKey: string): Promise<Event> => {
    const marker = await table.get({
      TableName: tableName,
      Key: keys.idempotency(scope, idempotencyKey),
      ConsistentRead: true,
    });
    const eventId = marker.Item?.eventId;
    const event = typeof eventId === "string" ? await getEvent(scope, eventId) : undefined;
    if (event === undefined) {
      throw new Error(
        `idempotency key ${JSON.stringify(idempotencyKey)} is recorded but its event is missing`,
      );
    }
    return event;
  };

  return {
    append: async (event): Promise<AppendResult> => {
      const parsed = EventSchema.parse(event);
      const scope = runScopeOf(parsed);
      // Numbering belongs to the Streams consumer, never to the caller (A-22).
      const stored: Event = { ...parsed, sequence: null };
      const notExists = {
        ConditionExpression: "attribute_not_exists(#pk)",
        ExpressionAttributeNames: { "#pk": "PK" },
      };

      try {
        await table.transactWrite({
          TransactItems: [
            {
              Put: {
                TableName: tableName,
                Item: {
                  ...keys.idempotency(scope, parsed.idempotencyKey),
                  eventId: parsed.eventId,
                },
                ...notExists,
              },
            },
            {
              Put: {
                TableName: tableName,
                Item: toItem("Event", keys.event(scope, parsed.eventId), stored),
                ...notExists,
              },
            },
          ],
        });
        return { stored: true, event: stored };
      } catch (error) {
        const failures = conditionFailures(error);
        if (failures === undefined) throw error;
        if (failures[0] !== true) {
          throw new Error(
            `event ${parsed.eventId} already exists under a different idempotency key; ` +
              "event identifiers must be unique",
          );
        }
        return { stored: false, event: await findByIdempotencyKey(scope, parsed.idempotencyKey) };
      }
    },

    listByRun: async (scope, options: PageRequest & { readonly afterSequence?: number } = {}) => {
      assertLimit(options.limit);
      // The order a reader needs is by sequence, which the sort key (the ULID)
      // cannot give: two writers may commit out of identifier order, and numbering
      // follows commit order. So the partition is read whole and ordered here. That
      // is linear in the run's event count per page; a run's events are bounded by
      // its jobs, and a sparse index on `sequence` is the upgrade if a run outgrows it.
      const partition = keys.eventPartition(scope);
      const items = await queryAll(table, tableName, {
        partition: partition.PK,
        prefix: partition.prefix,
      });
      const ordered = orderEvents(items.map((item) => fromItem(EventSchema, item)));

      const after = options.afterSequence;
      // A sequence cursor cannot see unnumbered events: it lags, never skips.
      const visible =
        after === undefined
          ? ordered
          : ordered.filter((event) => event.sequence !== null && event.sequence > after);

      const start = options.cursor === undefined ? undefined : decodePosition(options.cursor);
      const remaining = start === undefined ? visible : visible.filter((e) => comesAfter(e, start));

      if (options.limit === undefined || remaining.length <= options.limit) {
        return { items: remaining };
      }
      const page = remaining.slice(0, options.limit);
      const last = page[page.length - 1] as Event;
      return { items: page, cursor: encodeCursor({ ...positionOf(last) }) };
    },

    nextSequence: async (scope) => {
      const output = await table.get({
        TableName: tableName,
        Key: keys.counter(scope),
        ConsistentRead: true,
      });
      const next = output.Item?.[COUNTER_ATTRIBUTE];
      return typeof next === "number" ? next : 0;
    },
  };
};

export type { EventId };
