import type { Duration, HarnessHandle } from "./harness.js";
import { millis } from "./harness.js";

/** How long a line agent gets between the cooperative stop and the hard kill at its deadline. */
export const LINE_DEADLINE_GRACE: Duration = millis(5_000);

/**
 * Stops a line agent at its deadline (strand S-04) through the adapter's own
 * `cancel`, so the kill goes through `runAs` as it does for a worker and `exit`
 * settles once. A deadline already past cancels at once. The timer is cleared
 * when `exit` settles and never holds the event loop open.
 */
export const cancelAtDeadline = (input: {
  readonly handle: HarnessHandle;
  readonly deadline: string;
  readonly nowMs: number;
  readonly cancel: (handle: HarnessHandle, grace: Duration) => Promise<void>;
}): void => {
  const at = Date.parse(input.deadline);
  if (Number.isNaN(at)) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  // A timer cannot wait longer than 2^31-1 ms; a farther deadline is waited for in steps.
  const arm = (waitMs: number): void => {
    timer = setTimeout(
      () => {
        if (settled) return;
        const left = at - input.nowMs - (Date.now() - startedAt);
        if (left > 0) {
          arm(left);
          return;
        }
        void input.cancel(input.handle, LINE_DEADLINE_GRACE).catch(() => {});
      },
      Math.min(Math.max(0, waitMs), MAX_TIMER_MS),
    );
    timer.unref?.();
  };
  const startedAt = Date.now();
  arm(at - input.nowMs);
  void input.handle.exit.then(() => {
    settled = true;
    if (timer !== undefined) clearTimeout(timer);
  });
};

const MAX_TIMER_MS = 2 ** 31 - 1;
