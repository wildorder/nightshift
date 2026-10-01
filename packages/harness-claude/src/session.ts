/**
 * When a streaming-input session is over.
 *
 * The adapter runs Claude Code with `--input-format stream-json` and keeps its
 * stdin open, because that is what lets a session outlive the end of a turn:
 * the model can start a command in the background, end its turn, and be woken
 * by Claude Code when the command finishes, exactly as in an interactive
 * session. Closing stdin is how the session is ended, and this decides when.
 *
 * - **Idle with nothing in the background**: done. Closed after a short grace,
 *   which any new turn cancels, so a background task's completion and the turn
 *   it starts are never raced (the task list empties a moment before that turn
 *   begins).
 * - **Idle after a finishing call** (`job.complete` and the like): done, even
 *   with something still running. A dev server left up after the work was
 *   reported must not hold the session open forever; it is stopped with it.
 * - **Idle with background work and no finishing call**: waiting to be woken.
 *   Bounded, so a background command that never ends cannot hold a job
 *   forever: after {@link MAX_BACKGROUND_WAIT_MS} idle, the session is closed
 *   and whatever was running is stopped. The execution layer resumes a session
 *   that ended unreported, with a reminder.
 * - **Running**: never closed from here. A turn in progress is the model's.
 */
import type { SessionActivity } from "./stream.js";

/** How long an idle, finished session is left before stdin is closed. */
export const IDLE_GRACE_MS = 2_000;

/** How long a session may sit idle waiting on its background tasks. */
export const MAX_BACKGROUND_WAIT_MS = 2 * 60 * 60 * 1_000;

export interface SessionCloserInput {
  /** Ends the session: closes stdin. Called at most once. */
  readonly close: () => void;
  readonly graceMs?: number;
  readonly maxBackgroundWaitMs?: number;
  /** Injected so a test controls time. */
  readonly setTimer?: (callback: () => void, ms: number) => unknown;
  readonly clearTimer?: (timer: unknown) => void;
}

export interface SessionCloser {
  /** Feed every activity change from the stream interpreter. */
  readonly onActivity: (activity: SessionActivity) => void;
  /** Stops every timer, for a session that ended some other way. */
  readonly dispose: () => void;
}

export const createSessionCloser = (input: SessionCloserInput): SessionCloser => {
  const setTimer =
    input.setTimer ??
    ((callback: () => void, ms: number) => {
      const timer = setTimeout(callback, ms);
      timer.unref?.();
      return timer;
    });
  const clearTimer =
    input.clearTimer ?? ((timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  const graceMs = input.graceMs ?? IDLE_GRACE_MS;
  const maxWaitMs = input.maxBackgroundWaitMs ?? MAX_BACKGROUND_WAIT_MS;

  let closed = false;
  let grace: unknown;
  let waiting: unknown;

  const close = (): void => {
    if (closed) return;
    closed = true;
    dispose();
    input.close();
  };

  const stopGrace = (): void => {
    if (grace !== undefined) clearTimer(grace);
    grace = undefined;
  };
  const stopWaiting = (): void => {
    if (waiting !== undefined) clearTimer(waiting);
    waiting = undefined;
  };
  const dispose = (): void => {
    stopGrace();
    stopWaiting();
  };

  const onActivity = (activity: SessionActivity): void => {
    if (closed) return;
    stopGrace();
    if (!activity.idle) {
      stopWaiting();
      return;
    }
    if (activity.finished || activity.backgroundTasks === 0) {
      grace = setTimer(close, graceMs);
      return;
    }
    waiting ??= setTimer(close, maxWaitMs);
  };

  return { onActivity, dispose };
};
