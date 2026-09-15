/**
 * Waiting for the materializer, without mistaking silence for slowness (T7).
 *
 * The failure worth designing against is a materializer that numbers nothing
 * while the suite waits patiently. So a timeout says which of two things
 * happened: numbers were still appearing (slow), or none appeared in the whole
 * window (broken), with where to look next.
 */
import { type EventStore, pendingCount, type RunScope } from "@nightshift/core";

export interface WaitOptions {
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
}

export const waitForNumbering = async (
  events: EventStore,
  scopes: readonly RunScope[],
  { timeoutMs = 60_000, intervalMs = 250 }: WaitOptions = {},
): Promise<{ readonly elapsedMs: number }> => {
  const started = Date.now();
  let firstPending: number | undefined;
  let fewestPending = Number.POSITIVE_INFINITY;

  for (;;) {
    let pending = 0;
    for (const scope of scopes) pending += pendingCount((await events.listByRun(scope)).items);
    const elapsedMs = Date.now() - started;
    if (pending === 0) return { elapsedMs };

    firstPending ??= pending;
    fewestPending = Math.min(fewestPending, pending);
    if (elapsedMs > timeoutMs) {
      throw new Error(
        fewestPending < firstPending
          ? `the materializer is slow: ${pending} events are still unnumbered after ${elapsedMs} ms, ` +
              `though ${firstPending - fewestPending} were numbered while waiting`
          : `the materializer looks broken: ${pending} events are unnumbered and none was numbered ` +
              `in ${elapsedMs} ms. Check the materializer's log group and its dead-letter queue.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
};
