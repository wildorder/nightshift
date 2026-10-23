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
  type Page,
  type PageRequest,
  type RunScope,
  runScopeOf,
} from "@nightshift/core";
import { assertLimit, decodeCursor, encodeCursor } from "./cursor.js";
import { fromItem, toItem } from "./items.js";
import {
  EVENT_SEQUENCE_ATTRIBUTE,
  EVENT_SEQUENCE_INDEX_NAME,
  EVENT_SEQUENCE_PARTITION_ATTRIBUTE,
  keys,
} from "./keys.js";
import { queryAll } from "./query.js";
import { conditionFailures, type TableClient } from "./table-client.js";

export interface EventStoreConfig {
  readonly tableName: string;
  readonly table: TableClient;
}

/** The counter item's attribute holding the next number to assign. */
export const COUNTER_ATTRIBUTE = "next";

/**
 * A position in `orderEvents` order: numbered by sequence, then unnumbered by
 * identifier. `through`, on a position among the unnumbered, is the last
 * sequence the index had given in order when that page was read: the next page's
 * tail starts after it (2026-10-22). Absent on cursors from before.
 */
interface EventPosition {
  readonly sequence: number | null;
  readonly eventId: string;
  readonly through?: number;
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
  const through = decoded.through;
  if (
    typeof eventId !== "string" ||
    !(sequence === null || (typeof sequence === "number" && Number.isInteger(sequence))) ||
    !(through === undefined || (typeof through === "number" && Number.isInteger(through)))
  ) {
    throw new RangeError(`invalid cursor: ${cursor}`);
  }
  return through === undefined ? { sequence, eventId } : { sequence, eventId, through };
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

  const nextSequence = async (scope: RunScope): Promise<number> => {
    const output = await table.get({
      TableName: tableName,
      Key: keys.counter(scope),
      ConsistentRead: true,
    });
    const next = output.Item?.[COUNTER_ATTRIBUTE];
    return typeof next === "number" ? next : 0;
  };

  /**
   * Numbered events after `after`, in sequence order, from the event-sequence
   * index, until `wanted` are in hand. The index trails the table: an event
   * numbered a moment ago may be missing while a later one is there. So the read
   * stops at the first gap, and `through` is the last sequence given in order: a
   * reader lags behind the gap and never skips it (A-22). Numbers are dense by
   * construction, so a gap is only ever the index catching up.
   */
  const numberedAfter = async (
    partition: string,
    after: number,
    wanted: number,
  ): Promise<{ readonly events: readonly Event[]; readonly through: number }> => {
    const events: Event[] = [];
    let through = after;
    let startKey: Record<string, unknown> | undefined;
    do {
      const output = await table.query({
        TableName: tableName,
        IndexName: EVENT_SEQUENCE_INDEX_NAME,
        KeyConditionExpression: "#partition = :partition AND #sequence > :after",
        ExpressionAttributeNames: {
          "#partition": EVENT_SEQUENCE_PARTITION_ATTRIBUTE,
          "#sequence": EVENT_SEQUENCE_ATTRIBUTE,
        },
        ExpressionAttributeValues: { ":partition": partition, ":after": after },
        ...(Number.isFinite(wanted) ? { Limit: wanted - events.length } : {}),
        ...(startKey === undefined ? {} : { ExclusiveStartKey: startKey }),
      });
      for (const item of output.Items ?? []) {
        const event = fromItem(EventSchema, item);
        if (event.sequence !== through + 1) return { events, through };
        events.push(event);
        through = event.sequence;
      }
      startKey = output.LastEvaluatedKey;
    } while (startKey !== undefined && events.length < wanted);
    return { events, through };
  };

  /**
   * The events the index has not given in order: unnumbered ones, and any
   * numbered after `through` (numbered, but not yet in the index). Read from the
   * table, strongly consistent, in `orderEvents` order. A filter does not spare
   * the read, so this reads the partition: it is asked once, by a reader of the
   * whole log, on its last page.
   */
  const tailAfter = async (
    partition: { readonly PK: string; readonly prefix: string },
    through: number,
  ): Promise<readonly Event[]> => {
    const found: Event[] = [];
    let startKey: Record<string, unknown> | undefined;
    do {
      const output = await table.query({
        TableName: tableName,
        ConsistentRead: true,
        KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :prefix)",
        FilterExpression: "attribute_type(#sequence, :null) OR #sequence > :through",
        ExpressionAttributeNames: { "#pk": "PK", "#sk": "SK", "#sequence": "sequence" },
        ExpressionAttributeValues: {
          ":pk": partition.PK,
          ":prefix": partition.prefix,
          ":null": "NULL",
          ":through": through,
        },
        ...(startKey === undefined ? {} : { ExclusiveStartKey: startKey }),
      });
      for (const item of output.Items ?? []) found.push(fromItem(EventSchema, item));
      startKey = output.LastEvaluatedKey;
    } while (startKey !== undefined);
    return orderEvents(found);
  };

  /** The first `limit` of `items`, and the cursor after the last of them. */
  const pageOf = (items: readonly Event[], limit: number, through: number): Page<Event> => {
    const page = items.slice(0, limit);
    const last = page[page.length - 1] as Event;
    return {
      items: page,
      cursor: encodeCursor(
        last.sequence === null ? { ...positionOf(last), through } : { ...positionOf(last) },
      ),
    };
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
                Item: toItem(
                  "Event",
                  keys.event(scope, parsed.eventId),
                  stored,
                  parsed.executionNodeId === null
                    ? undefined
                    : keys.eventByNode(scope, parsed.executionNodeId, parsed.type, parsed.eventId),
                ),
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

    // The order a reader needs is by sequence, which the table's sort key (the
    // ULID) cannot give: numbering follows commit order, and an event is written
    // before it has a number. So numbered events are read from the event-sequence
    // index, from where the reader stands, and only a reader of the whole log also
    // reads the unnumbered tail from the table, once, on its last page
    // (2026-10-22). Until then every page, and every poll from a sequence, read the
    // run's whole event partition.
    listByRun: async (scope, options: PageRequest & { readonly afterSequence?: number } = {}) => {
      assertLimit(options.limit);
      const partition = keys.eventPartition(scope);
      const start = options.cursor === undefined ? undefined : decodePosition(options.cursor);
      const limit = options.limit;
      const items: Event[] = [];
      let through: number;
      if (start === undefined || start.sequence !== null) {
        const after = Math.max(options.afterSequence ?? -1, start?.sequence ?? -1);
        const numbered = await numberedAfter(
          partition.PK,
          after,
          limit === undefined ? Number.POSITIVE_INFINITY : limit + 1,
        );
        items.push(...numbered.events);
        through = numbered.through;
        if (limit !== undefined && items.length > limit) return pageOf(items, limit, through);
        // A sequence cursor cannot see unnumbered events: it lags, never skips.
        if (options.afterSequence !== undefined) return { items };
      } else {
        // A cursor from before `through` was kept: everything numbered had been
        // given before the reader reached the unnumbered tail.
        through = start.through ?? (await nextSequence(scope)) - 1;
      }
      const tail = (await tailAfter(partition, through)).filter(
        (event) => start === undefined || start.sequence !== null || comesAfter(event, start),
      );
      items.push(...tail);
      if (limit === undefined || items.length <= limit) return { items };
      return pageOf(items, limit, through);
    },

    // A node's events from the node index, by type when one is named; few, so
    // read whole, ordered as `listByRun` orders them, and paged here.
    listByNode: async (scope, executionNodeId, options = {}) => {
      assertLimit(options.limit);
      const items = await queryAll(table, tableName, {
        partition: `NODE#${scope.projectId}#${scope.programId}#${scope.runId}#${executionNodeId}`,
        prefix: options.type === undefined ? "EVT#" : `EVT#${options.type}#`,
        index: true,
      });
      const ordered = orderEvents(items.map((item) => fromItem(EventSchema, item)));
      const start = options.cursor === undefined ? undefined : decodePosition(options.cursor);
      const remaining =
        start === undefined ? ordered : ordered.filter((event) => comesAfter(event, start));
      if (options.limit === undefined || remaining.length <= options.limit) {
        return { items: remaining };
      }
      const page = remaining.slice(0, options.limit);
      const last = page[page.length - 1] as Event;
      return { items: page, cursor: encodeCursor({ ...positionOf(last) }) };
    },

    nextSequence,
  };
};

export type { EventId };
