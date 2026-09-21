/**
 * The shared harness conformance suite (T1 deliverable 3).
 *
 * This is the seed of P5's suite, and it deliberately asserts only what version 0
 * of the contract promises. Anything an adapter does beyond this — how it frames
 * its prompt, which flags it passes, how it names its tools to a model — is its
 * own business and its own tests.
 *
 * Five properties, each of which the execution layer depends on:
 *
 * 1. A handle carries the identity it was given, never one it invented (A-04).
 * 2. `exit` settles exactly once. The runner awaits it and then writes a terminal
 *    status; a second settlement would be a second terminal write.
 * 3. `cancel` on a running agent settles `exit` as `cancelled`. Shutdown depends
 *    on this (contract §4.3, last failure path).
 * 4. `status` agrees with `exit`, forever. P10 asks `status` about an agent this
 *    process did not spawn; an adapter whose two answers can disagree is not one
 *    P10 can build on.
 * 5. Every event that reached the sink carries a hook-sourced `EventType`, and a
 *    completed run produced both a start and an end (D-P3-09).
 *
 * An adapter that cannot pass this unchanged is a conversation, not a reason to
 * edit the suite (AGENTS.md).
 */
import {
  agentStatusForExit,
  type Duration,
  type Harness,
  type HarnessExit,
  type HarnessStartInput,
  type HookEvent,
  isHookEventType,
  millis,
} from "@nightshift/harness";
import { afterEach, describe, expect, it } from "vitest";

/** Everything a start input needs except the sink, which the suite supplies. */
export type ConformanceStartInput = Omit<HarnessStartInput, "sink">;

export interface HarnessConformanceFixture {
  /**
   * A worker that finishes on its own, promptly. What it does in the worktree is
   * irrelevant here; only that it starts and ends.
   */
  completing(): Promise<ConformanceStartInput> | ConformanceStartInput;
  /**
   * A worker that keeps running until something stops it. The cancel assertions
   * are meaningless without one: cancelling a worker that had already finished
   * proves nothing.
   */
  longRunning(): Promise<ConformanceStartInput> | ConformanceStartInput;
  /** Torn down after every case, whether it passed or failed. */
  cleanup?(): Promise<void> | void;
  /** How long `cancel` waits before a hard kill. Defaults to two seconds. */
  readonly cancelGrace?: Duration;
  /** How long the suite waits for a completing worker. Defaults to thirty seconds. */
  readonly completionTimeout?: Duration;
}

const withTimeout = async <T>(work: Promise<T>, limit: Duration, what: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${what} did not settle within ${limit.ms} ms`)),
      limit.ms,
    );
  });
  try {
    return await Promise.race([work, expiry]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

export const describeHarnessConformance = (
  name: string,
  harness: Harness,
  fixture: HarnessConformanceFixture,
): void => {
  const cancelGrace = fixture.cancelGrace ?? millis(2_000);
  const completionTimeout = fixture.completionTimeout ?? millis(30_000);

  describe(`${name} — harness adapter conformance (version 0)`, () => {
    afterEach(async () => {
      await fixture.cleanup?.();
    });

    /** Starts a worker with a sink the suite can read back. */
    const start = async (which: "completing" | "longRunning") => {
      const events: HookEvent[] = [];
      const base = await fixture[which]();
      const input: HarnessStartInput = {
        ...base,
        sink: { emit: (event) => void events.push(event) },
      };
      const handle = await harness.start(input);
      return { handle, events, input };
    };

    it("returns a handle carrying the identity it was given, not one it minted", async () => {
      const { handle, input } = await start("completing");
      expect(handle.agentId).toBe(input.agent.agentId);
      await withTimeout(handle.exit, completionTimeout, "exit");
    });

    it("settles exit exactly once, with the same value every time it is awaited", async () => {
      const { handle } = await start("completing");
      const first = await withTimeout(handle.exit, completionTimeout, "exit");
      const second = await handle.exit;
      const third = await handle.exit;
      expect(second).toEqual(first);
      expect(third).toEqual(first);
    });

    it("reports a terminal status that agrees with the exit, and keeps reporting it", async () => {
      const { handle } = await start("completing");
      const exit = await withTimeout(handle.exit, completionTimeout, "exit");
      const expected = agentStatusForExit(exit);
      expect(await harness.status(handle)).toBe(expected);
      // Asked again, long after settlement: P10 reads this from a different place
      // in the lifecycle than the runner does, and must get the same answer.
      expect(await harness.status(handle)).toBe(expected);
    });

    it("emits only hook-sourced event types", async () => {
      const { handle, events } = await start("completing");
      await withTimeout(handle.exit, completionTimeout, "exit");
      expect(events.length).toBeGreaterThan(0);
      for (const event of events) {
        expect(isHookEventType(event.type), `${event.type} is not a hook-sourced event type`).toBe(
          true,
        );
        expect(Date.parse(event.occurredAt)).not.toBeNaN();
      }
    });

    it("reports a start and exactly one ending, without the worker's cooperation", async () => {
      const { handle, events } = await start("completing");
      const exit = await withTimeout(handle.exit, completionTimeout, "exit");
      // Give an adapter that emits its ending from the exit handler a turn.
      await new Promise((resolve) => setImmediate(resolve));

      expect(events.filter((event) => event.type === "agent.started")).toHaveLength(1);
      const endings = events.filter((event) =>
        (
          ["agent.completed", "agent.failed", "agent.cancelled", "agent.interrupted"] as const
        ).includes(event.type as never),
      );
      expect(endings).toHaveLength(1);
      expect(endings[0]?.type).toBe(
        exit.kind === "completed"
          ? "agent.completed"
          : exit.kind === "failed"
            ? "agent.failed"
            : exit.kind === "cancelled"
              ? "agent.cancelled"
              : "agent.interrupted",
      );
    });

    it("cancels a running agent, settling exit as cancelled", async () => {
      const { handle } = await start("longRunning");
      await harness.cancel(handle, cancelGrace);
      const exit: HarnessExit = await withTimeout(
        handle.exit,
        millis(cancelGrace.ms + 10_000),
        "exit after cancel",
      );
      expect(exit.kind).toBe("cancelled");
      expect(await harness.status(handle)).toBe("cancelled");
    });

    it("treats a second cancel as a no-op rather than an error", async () => {
      const { handle } = await start("longRunning");
      await harness.cancel(handle, cancelGrace);
      await withTimeout(handle.exit, millis(cancelGrace.ms + 10_000), "exit after cancel");
      await expect(harness.cancel(handle, cancelGrace)).resolves.toBeUndefined();
    });
  });
};
