/**
 * Reading an event stream whose numbering lags its durability (A-22).
 *
 * An event is written synchronously with a ULID identifier, then an ordered
 * consumer stamps its `sequence` a moment later. So at any instant the tail of a
 * run's stream may be durable and unnumbered, and **every consumer has to handle
 * that**. This module is the one place that logic lives, so P3 onward does not
 * each invent its own handling and disagree.
 *
 * ## Which cursor to resume from
 *
 * There are two, and picking the wrong one is the trap this module exists to
 * prevent.
 *
 * - **Sequence cursor** (`afterSequence`). Gap-free and totally ordered, but it
 *   cannot see unnumbered events, so it lags. Correct for rebuilding state,
 *   auditing, and analytics — anything that must not miss an event and must see
 *   them in the real order.
 * - **Identifier cursor** (`afterEventId`). Sees events the instant they are
 *   durable, but two events written in the same millisecond by different writers
 *   may arrive in an order that later numbering disagrees with. Correct for
 *   low-latency tailing where being a beat early matters more than final order.
 *
 * A sequence cursor never *skips* an event, because numbering is applied in
 * order: event N is stamped before N+1. It only ever waits.
 */
import type { Event } from "@nightshift/contracts";

/** An event that has been numbered. The narrowed form most logic wants. */
export type SequencedEvent = Event & { readonly sequence: number };

/** An event that is durable but not yet numbered. */
export type PendingEvent = Event & { readonly sequence: null };

/** Whether `event` has been numbered yet. */
export const isSequenced = (event: Event): event is SequencedEvent => event.sequence !== null;

/** Whether `event` is still awaiting a number. */
export const isPending = (event: Event): event is PendingEvent => event.sequence === null;

/**
 * Splits a batch into the numbered and the not-yet-numbered.
 *
 * `pending` is always the newest tail of the stream, because numbering is applied
 * in order.
 */
export const partitionBySequencing = (
  events: readonly Event[],
): {
  readonly sequenced: readonly SequencedEvent[];
  readonly pending: readonly PendingEvent[];
} => ({
  sequenced: events.filter(isSequenced),
  pending: events.filter(isPending),
});

/** Whether every event in the batch has been numbered. */
export const isCaughtUp = (events: readonly Event[]): boolean => events.every(isSequenced);

/**
 * Total order over a mixed batch: numbered events first by `sequence`, then
 * unnumbered ones by identifier.
 *
 * Putting pending events last is correct rather than arbitrary — they are by
 * construction the newest, since an event cannot be numbered before an earlier
 * one. Ordering them by ULID is the best available approximation until their real
 * numbers arrive.
 */
export const orderEvents = (events: readonly Event[]): readonly Event[] => {
  const { sequenced, pending } = partitionBySequencing(events);
  return [
    ...[...sequenced].sort((a, b) => a.sequence - b.sequence),
    ...[...pending].sort((a, b) => (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0)),
  ];
};

/** The highest number assigned so far, or `undefined` when nothing is numbered. */
export const highestSequence = (events: readonly Event[]): number | undefined => {
  const numbers = events.filter(isSequenced).map((event) => event.sequence);
  return numbers.length === 0 ? undefined : Math.max(...numbers);
};

/** How many events are still waiting for a number. */
export const pendingCount = (events: readonly Event[]): number => events.filter(isPending).length;

/**
 * Missing sequence numbers between 0 and the highest seen, ascending.
 *
 * This is the completeness check dense numbering buys. A gap means an event was
 * lost, or numbering died mid-run — never that one is merely late, because a late
 * event has no number at all and is reported by {@link pendingCount} instead.
 *
 * Pass `from` when checking a window rather than a whole run, so events before
 * the window are not reported as missing.
 */
export const findSequenceGaps = (events: readonly Event[], from = 0): readonly number[] => {
  const present = new Set(events.filter(isSequenced).map((event) => event.sequence));
  const highest = highestSequence(events);
  if (highest === undefined) return [];

  const gaps: number[] = [];
  for (let n = from; n < highest; n += 1) {
    if (!present.has(n)) gaps.push(n);
  }
  return gaps;
};

/** Whether the numbered events form an unbroken run from `from`. */
export const isDense = (events: readonly Event[], from = 0): boolean =>
  findSequenceGaps(events, from).length === 0;

/**
 * A cursor for resuming a read.
 *
 * `afterSequence` lags but never misses; `afterEventId` is immediate but may
 * reorder. See the module comment before choosing.
 */
export type EventCursor =
  | { readonly kind: "sequence"; readonly afterSequence: number }
  | { readonly kind: "eventId"; readonly afterEventId: string }
  | { readonly kind: "beginning" };

/**
 * The cursor to resume from after consuming `events`, for a reader that must not
 * miss anything. Deliberately ignores pending events: they will be picked up once
 * numbered.
 */
export const nextSequenceCursor = (events: readonly Event[]): EventCursor => {
  const highest = highestSequence(events);
  return highest === undefined
    ? { kind: "beginning" }
    : { kind: "sequence", afterSequence: highest };
};

/**
 * The cursor to resume from for a reader that wants events as soon as they are
 * durable, accepting that late numbering may reorder them.
 */
export const nextEventIdCursor = (events: readonly Event[]): EventCursor => {
  const ordered = orderEvents(events);
  const last = ordered.at(-1);
  return last === undefined
    ? { kind: "beginning" }
    : { kind: "eventId", afterEventId: last.eventId };
};

/**
 * How far numbering trails durability, as a count.
 *
 * Worth surfacing rather than hiding: a lag that grows without bound means the
 * consumer stamping numbers has stalled, which looks identical to a quiet run if
 * nobody is watching it.
 */
export const sequencingLag = (events: readonly Event[]): number => pendingCount(events);
