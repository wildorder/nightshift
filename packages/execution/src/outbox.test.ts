import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Event } from "@nightshift/contracts";
import { MAX_INLINE_PAYLOAD_BYTES } from "@nightshift/contracts";
import {
  type AppendResult,
  createCountingIdGenerator,
  createFixtures,
  createSteppingClock,
  type EventStore,
  type Fixtures,
  type Page,
} from "@nightshift/core";
import { afterEach, describe, expect, it } from "vitest";
import { createEventOutbox, type EventOutbox } from "./outbox.js";

/** An event store that records what it was given, and can be made to fail. */
const recordingStore = (): {
  readonly store: EventStore;
  readonly appended: Event[];
  failNext(count: number): void;
} => {
  const appended: Event[] = [];
  let failures = 0;
  return {
    appended,
    failNext: (count) => {
      failures = count;
    },
    store: {
      append: async (event): Promise<AppendResult> => {
        if (failures > 0) {
          failures -= 1;
          throw new Error("the control plane is unreachable");
        }
        // Idempotent, like the real one: a duplicate key stores nothing.
        const existing = appended.find((e) => e.idempotencyKey === event.idempotencyKey);
        if (existing !== undefined) return { stored: false, event: existing };
        appended.push(event);
        return { stored: true, event };
      },
      listByRun: async (): Promise<Page<Event>> => ({ items: appended }),
      nextSequence: async () => appended.length,
    },
  };
};

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const tempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "nightshift-outbox-"));
  dirs.push(dir);
  return dir;
};

interface World {
  readonly outbox: EventOutbox;
  readonly appended: Event[];
  failNext(count: number): void;
  readonly f: Fixtures;
}

const world = (writerId = "agent_writer"): World => {
  const backing = recordingStore();
  const f = createFixtures();
  return {
    appended: backing.appended,
    failNext: backing.failNext,
    f,
    outbox: createEventOutbox({
      events: backing.store,
      scope: f.scope,
      clock: createSteppingClock(Date.parse("2026-09-15T12:00:00.000Z")),
      ids: createCountingIdGenerator(),
      writerId,
      initialDelayMs: 1,
      maxDelayMs: 2,
      sleep: async () => {},
    }),
  };
};

describe("idempotency keys", () => {
  it("are <source>:<writerId>:<n>, with a counter per source", async () => {
    const w = world("agent_abc");
    w.outbox.emit({ type: "node.progress", source: "mcp", payload: {} });
    w.outbox.emit({ type: "node.progress", source: "mcp", payload: {} });
    w.outbox.emit({ type: "tool.called", source: "hook", payload: {} });
    w.outbox.emit({ type: "node.queued", source: "control-plane", payload: {} });
    await w.outbox.flush();

    // Each source counts independently, so one writer's three channels cannot
    // collide and none of them has a gap.
    expect(w.appended.map((e) => e.idempotencyKey)).toEqual([
      "mcp:agent_abc:1",
      "mcp:agent_abc:2",
      "hook:agent_abc:1",
      "control-plane:agent_abc:1",
    ]);
  });

  it("leaves sequence null: numbering is the control plane's (A-22)", () => {
    const w = world();
    const event = w.outbox.emit({ type: "node.progress", source: "mcp", payload: {} });
    expect(event.sequence).toBeNull();
  });
});

describe("delivery", () => {
  /**
   * The property that matters: a caller gets its event back and carries on even
   * when the control plane never answers. An adapter parsing a harness's output
   * stream cannot afford to wait, and a worker's tool call must not fail because
   * a laptop's connection blinked.
   */
  it("returns without waiting for delivery, even when the store never answers", () => {
    const f = createFixtures();
    let started = 0;
    const outbox = createEventOutbox({
      events: {
        append: () => {
          started += 1;
          // A request that is in flight forever.
          return new Promise(() => {});
        },
        listByRun: async () => ({ items: [] }),
        nextSequence: async () => 0,
      },
      scope: f.scope,
      clock: createSteppingClock(0),
      ids: createCountingIdGenerator(),
      writerId: "agent_blocked",
    });

    const event = outbox.emit({ type: "node.progress", source: "mcp", payload: { n: 1 } });
    expect(event.type).toBe("node.progress");
    expect(outbox.pending).toBe(1);
    expect(started).toBe(1);

    // And a second emit does not wait on the first, nor reorder behind it.
    outbox.emit({ type: "node.progress", source: "mcp", payload: { n: 2 } });
    expect(outbox.pending).toBe(2);
    expect(started, "the queue is serial: the second waits its turn").toBe(1);
  });

  it("delivers in emission order", async () => {
    const w = world();
    for (let n = 0; n < 10; n += 1) {
      w.outbox.emit({ type: "node.progress", source: "mcp", payload: { n } });
    }
    await w.outbox.flush();
    expect(w.appended.map((e) => e.payload.n)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("retries a failure and keeps the order", async () => {
    const w = world();
    w.failNext(2);
    w.outbox.emit({ type: "node.progress", source: "mcp", payload: { n: 0 } });
    w.outbox.emit({ type: "node.progress", source: "mcp", payload: { n: 1 } });
    await w.outbox.flush();
    expect(w.appended.map((e) => e.payload.n)).toEqual([0, 1]);
  });

  it("keeps an undeliverable event queued rather than dropping it", async () => {
    const w = world();
    // More failures than attempts: the event stays in the queue for the spool.
    w.failNext(100);
    w.outbox.emit({ type: "node.progress", source: "mcp", payload: { n: 0 } });
    await w.outbox.flush(50);
    expect(w.appended).toHaveLength(0);
    expect(w.outbox.pending).toBe(1);
  });

  it("reports how many it has delivered", async () => {
    const w = world();
    w.outbox.emit({ type: "node.progress", source: "mcp", payload: {} });
    w.outbox.emit({ type: "node.progress", source: "mcp", payload: {} });
    await w.outbox.flush();
    expect(w.outbox.delivered).toBe(2);
    expect(w.outbox.pending).toBe(0);
  });

  it("flush returns at its deadline rather than waiting forever", async () => {
    const w = world();
    w.failNext(1_000);
    w.outbox.emit({ type: "node.progress", source: "mcp", payload: {} });
    const started = Date.now();
    await w.outbox.flush(30);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe("the inline payload bound (A-08)", () => {
  it("replaces an oversized payload with one that says so, rather than failing", () => {
    const w = world();
    const event = w.outbox.emit({
      type: "tool.called",
      source: "hook",
      payload: { blob: "x".repeat(MAX_INLINE_PAYLOAD_BYTES * 2) },
    });
    // The event still arrives — an adapter that over-shares loses its payload,
    // not the event stream.
    expect(event.payload.truncated).toBe(true);
    expect(event.payload.keys).toEqual(["blob"]);
    expect(String(event.payload.reason)).toContain("artifact");
  });

  it("leaves a payload within the bound untouched", () => {
    const w = world();
    const event = w.outbox.emit({
      type: "tool.called",
      source: "hook",
      payload: { tool: "Edit", path: "src/a.ts" },
    });
    expect(event.payload).toEqual({ tool: "Edit", path: "src/a.ts" });
  });
});

describe("the spool", () => {
  it("spills what could not be delivered and replays it without duplicating", async () => {
    const dir = await tempDir();
    const path = join(dir, "runs", "r", "spool.ndjson");

    const first = world();
    first.failNext(1_000);
    first.outbox.emit({ type: "node.progress", source: "mcp", payload: { n: 0 } });
    first.outbox.emit({ type: "node.progress", source: "mcp", payload: { n: 1 } });
    await first.outbox.flush(30);
    expect(await first.outbox.spill(path)).toBe(2);

    // A new server for the same run, with a working connection.
    const second = world();
    expect(await second.outbox.replay(path)).toBe(2);
    await second.outbox.flush();
    expect(second.appended.map((e) => e.payload.n)).toEqual([0, 1]);

    // The spool is gone, and replaying again is a no-op rather than an error.
    expect(await second.outbox.replay(path)).toBe(0);
  });

  it("replaying twice stores one event per key, because the keys are deterministic", async () => {
    const dir = await tempDir();
    const path = join(dir, "spool.ndjson");

    const source = world("agent_stable");
    source.failNext(1_000);
    source.outbox.emit({ type: "node.progress", source: "mcp", payload: { n: 0 } });
    await source.outbox.flush(30);
    await source.outbox.spill(path);
    const spilled = await readFile(path, "utf8");

    const target = world();
    await writeFile(path, spilled, "utf8");
    await target.outbox.replay(path);
    await target.outbox.flush();
    // The same spool again: the store is idempotent on the key, so nothing doubles.
    await writeFile(path, spilled, "utf8");
    await target.outbox.replay(path);
    await target.outbox.flush();
    expect(target.appended).toHaveLength(1);
  });

  it("appends to an existing spool rather than replacing it", async () => {
    const dir = await tempDir();
    const path = join(dir, "spool.ndjson");

    const earlier = world("agent_one");
    earlier.failNext(1_000);
    earlier.outbox.emit({ type: "node.progress", source: "mcp", payload: { n: 0 } });
    await earlier.outbox.flush(30);
    await earlier.outbox.spill(path);

    // A second server for the same run that also could not deliver. Overwriting
    // here would lose the first server's events, which is the exact failure the
    // spool exists to prevent.
    const later = world("agent_two");
    later.failNext(1_000);
    later.outbox.emit({ type: "node.progress", source: "mcp", payload: { n: 1 } });
    await later.outbox.flush(30);
    await later.outbox.spill(path);

    const replayer = world();
    expect(await replayer.outbox.replay(path)).toBe(2);
  });

  it("spills nothing when there is nothing queued", async () => {
    const dir = await tempDir();
    const w = world();
    w.outbox.emit({ type: "node.progress", source: "mcp", payload: {} });
    await w.outbox.flush();
    expect(await w.outbox.spill(join(dir, "spool.ndjson"))).toBe(0);
  });

  it("skips a truncated final line rather than stranding every event before it", async () => {
    const dir = await tempDir();
    const path = join(dir, "spool.ndjson");
    const w = world("agent_x");
    w.failNext(1_000);
    w.outbox.emit({ type: "node.progress", source: "mcp", payload: { n: 0 } });
    await w.outbox.flush(30);
    await w.outbox.spill(path);
    // A write that died mid-line, as a killed process leaves it.
    await writeFile(path, `${(await readFile(path, "utf8")).trim()}\n{"eventId":"evt_`, "utf8");

    const replayer = world();
    expect(await replayer.outbox.replay(path)).toBe(1);
  });

  it("replays nothing when there is no spool", async () => {
    const dir = await tempDir();
    expect(await world().outbox.replay(join(dir, "absent.ndjson"))).toBe(0);
  });
});
