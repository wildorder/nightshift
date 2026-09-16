/**
 * The event outbox (D-P3-10, A-06, A-30).
 *
 * Events are how a run is observable, and the two things that would make them
 * useless are losing them and reordering them. So this is one ordered queue per
 * server process, and it refuses to drop:
 *
 * - `emit` is **synchronous and never throws**. An adapter parsing a harness's
 *   output stream cannot afford to await a network write, and a worker's
 *   progress report must not fail its tool call because a laptop's connection
 *   blinked.
 * - Delivery is **in order, one at a time**, with bounded retry. Two events from
 *   one writer never swap places.
 * - On shutdown the queue **spills to a spool file**, which the next server for
 *   that run replays. The spool is a buffer, not a store: nothing reads it to
 *   answer a question about run state, because the control plane is the only
 *   authority for that (A-06).
 *
 * ## Why replay is safe
 *
 * Every event carries `<source>:<writerId>:<n>` as its idempotency key — the
 * writer's own monotonic counter, per source (A-30). The control plane stores at
 * most one event per key per run, so replaying a spool converges rather than
 * duplicating. That is also why the counter lives beside the queue rather than
 * being derived from what has been delivered: a key must be stable from the
 * moment the event is created, not assigned when it happens to be sent.
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  AgentId,
  Event,
  EventSource,
  EventType,
  ExecutionNodeId,
  IsoTimestamp,
} from "@nightshift/contracts";
import { EventSchema, inlinePayloadBytes, MAX_INLINE_PAYLOAD_BYTES } from "@nightshift/contracts";
import type { Clock, EventStore, IdGenerator, RunScope } from "@nightshift/core";
import { nowIso } from "@nightshift/core";

export interface EmitInput {
  readonly type: EventType;
  readonly source: EventSource;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly executionNodeId?: ExecutionNodeId | null;
  readonly agentId?: AgentId | null;
  /** When the thing happened, if that differs from when it was emitted. */
  readonly occurredAt?: IsoTimestamp;
}

export interface OutboxOptions {
  readonly events: EventStore;
  readonly scope: RunScope;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /**
   * This writer's identity, the middle part of every idempotency key. The
   * agent id of the server process: the orchestrator's for its own events and
   * for the execution layer's, the worker's for a worker's.
   */
  readonly writerId: string;
  /** Total delivery attempts per event. */
  readonly attempts?: number;
  readonly initialDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  /**
   * Told about an event that could not be delivered after every attempt. It
   * stays queued and is spilled on shutdown; this is for logging, never for
   * deciding anything.
   */
  readonly onDeliveryFailure?: (event: Event, error: unknown) => void;
}

export interface EventOutbox {
  /** Queues an event. Returns the event as it will be stored. Never throws. */
  emit(input: EmitInput): Event;
  /** Resolves when the queue is empty, or when `deadlineMs` has passed. */
  flush(deadlineMs?: number): Promise<void>;
  /** Writes whatever is still queued to `path` as NDJSON. Returns how many. */
  spill(path: string): Promise<number>;
  /** Re-queues a spool's events and removes the file. Returns how many. */
  replay(path: string): Promise<number>;
  readonly pending: number;
  /** How many events this outbox has delivered. For assertions and diagnostics. */
  readonly delivered: number;
}

const DEFAULT_ATTEMPTS = 5;
const DEFAULT_INITIAL_DELAY_MS = 100;
const DEFAULT_MAX_DELAY_MS = 5_000;

const sleepFor = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A payload that would exceed the inline bound, replaced by one that says so.
 *
 * The bound is what keeps large output out of DynamoDB (A-08), and the schema
 * refuses a payload over it — so an adapter that over-shares would otherwise
 * take down the event stream rather than its own event. Truncating loudly is the
 * better failure: the event still arrives, and it says what happened.
 */
const boundPayload = (
  payload: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> => {
  if (inlinePayloadBytes(payload) <= MAX_INLINE_PAYLOAD_BYTES) return payload;
  return {
    truncated: true,
    reason: `the payload exceeded the ${MAX_INLINE_PAYLOAD_BYTES}-byte inline bound and was dropped; large output belongs in an artifact (A-08)`,
    keys: Object.keys(payload),
  };
};

export const createEventOutbox = (options: OutboxOptions): EventOutbox => {
  const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
  const initialDelayMs = options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const sleep = options.sleep ?? sleepFor;

  /** One counter per source, so each writer's keys are dense and independent. */
  const counters = new Map<EventSource, number>();
  const queue: Event[] = [];
  const idle: (() => void)[] = [];
  let draining = false;
  let delivered = 0;

  const nextKey = (source: EventSource): string => {
    const n = (counters.get(source) ?? 0) + 1;
    counters.set(source, n);
    return `${source}:${options.writerId}:${n}`;
  };

  const wake = (): void => {
    for (const resolve of idle.splice(0)) resolve();
  };

  /** Delivers one event with bounded retry. Resolves whether or not it succeeded. */
  const deliver = async (event: Event): Promise<boolean> => {
    let delay = initialDelayMs;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        await options.events.append(event);
        return true;
      } catch (error) {
        if (attempt >= attempts) {
          options.onDeliveryFailure?.(event, error);
          return false;
        }
        await sleep(delay);
        delay = Math.min(delay * 3, maxDelayMs);
      }
    }
    return false;
  };

  const drain = async (): Promise<void> => {
    if (draining) return;
    draining = true;
    try {
      // One at a time, from the head: order within a writer is the guarantee.
      while (queue.length > 0) {
        const event = queue[0];
        if (event === undefined) break;
        const sent = await deliver(event);
        if (!sent) break;
        queue.shift();
        delivered += 1;
      }
    } finally {
      draining = false;
      if (queue.length === 0) wake();
    }
  };

  const enqueue = (event: Event): void => {
    queue.push(event);
    // Fire and forget: `emit` must not block, and a rejection here would be an
    // unhandled promise. `deliver` already swallows and reports.
    void drain();
  };

  return {
    get pending() {
      return queue.length;
    },
    get delivered() {
      return delivered;
    },

    emit: (input) => {
      const at = nowIso(options.clock);
      const event = EventSchema.parse({
        schemaVersion: 1,
        ...options.scope,
        eventId: options.ids.next("evt"),
        idempotencyKey: nextKey(input.source),
        // Assigned by the control plane after durability (A-22).
        sequence: null,
        type: input.type,
        source: input.source,
        executionNodeId: input.executionNodeId ?? null,
        agentId: input.agentId ?? null,
        payload: boundPayload(input.payload),
        occurredAt: input.occurredAt ?? at,
        recordedAt: at,
      });
      enqueue(event);
      return event;
    },

    flush: async (deadlineMs) => {
      void drain();
      if (queue.length === 0) return;
      const waitForIdle = new Promise<void>((resolve) => idle.push(resolve));
      if (deadlineMs === undefined) {
        await waitForIdle;
        return;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const expiry = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, deadlineMs);
      });
      try {
        await Promise.race([waitForIdle, expiry]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },

    spill: async (path) => {
      if (queue.length === 0) return 0;
      await mkdir(dirname(path), { recursive: true });
      const lines = queue.map((event) => JSON.stringify(event)).join("\n");
      // Appending rather than replacing: a spool may already hold events from an
      // earlier server for this run that were never replayed, and losing them to
      // make room for these would be the exact failure this file exists to avoid.
      await writeFile(path, `${lines}\n`, { encoding: "utf8", flag: "a" });
      return queue.length;
    },

    replay: async (path) => {
      let text: string;
      try {
        text = await readFile(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
        throw error;
      }
      const lines = text.split("\n").filter((line) => line.trim() !== "");
      let replayed = 0;
      for (const line of lines) {
        // A malformed line is skipped rather than failing the whole replay: a
        // spill that died mid-write leaves a truncated final line, and stranding
        // every event before it would be the worse outcome. `JSON.parse` throws
        // on such a line, so the parse is guarded as well as the schema check.
        let raw: unknown;
        try {
          raw = JSON.parse(line) as unknown;
        } catch {
          continue;
        }
        const parsed = EventSchema.safeParse(raw);
        if (!parsed.success) continue;
        enqueue(parsed.data);
        replayed += 1;
      }
      // Removed only after every line is queued. The idempotency keys make a
      // second replay harmless, so erring towards replaying twice is right.
      await rm(path, { force: true });
      return replayed;
    },
  };
};
