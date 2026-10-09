/**
 * The engine's heartbeat (P10, D-P10-18, D-P10-20).
 *
 * Every interval: the samples since the last, the seconds metered so far, and
 * whatever milestone was reached, to `POST …/dispatch/heartbeat` under the
 * current engine token. The response carries the lease, the next token, and
 * whether to stop. Three missed heartbeats from this side and the process
 * exits non-zero: the lease is lost either way, and a runner that cannot speak
 * to the plane must not keep working as if it could.
 *
 * It also carries where the runner has got to (P16 S-03): the latest progress,
 * on the next beat. A new stage, or the audit's verdict, does not wait out the
 * interval: it wakes the loop and goes at once, so the developer waiting at
 * `nightshift run --remote` hears it as it happens. A progress that only says
 * more of the same stage wakes the loop too, but no more often than every
 * `PROGRESS_MIN_GAP_MS`. Within a stage only the newest progress is sent; a
 * stage the runner moved on from before a beat carried it still goes, ahead of
 * the next, so the plane hears every stage in order. One that could not be
 * sent is sent again, unless a newer one has replaced it.
 */
import {
  type HeartbeatBody,
  type HeartbeatReport,
  type HeartbeatResponse,
  HeartbeatResponseSchema,
  type RunnerFailure,
  type RunnerProgress,
  type UtilizationSample,
} from "@nightshift/contracts";
import { HEARTBEAT_INTERVAL_SECONDS, LEASE_MISSES } from "@nightshift/core";

export interface HeartbeatOptions {
  readonly generation: number;
  /** One heartbeat to the plane, under the current engine token. */
  readonly post: (body: HeartbeatBody) => Promise<unknown>;
  /** Replaces the token the transport sends, when the plane renews it. */
  readonly installToken: (token: string) => void;
  readonly sample: () => Promise<UtilizationSample | undefined>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
  readonly log: (line: string) => void;
  readonly intervalMs?: number;
}

export interface Heartbeat {
  /**
   * Something to tell the plane on the next beat. `stopped` may carry why the
   * runner could not go on (P16 SC-07, D-07): the plane then ends the dispatch
   * `failed` with it.
   */
  report(milestone: HeartbeatReport, failure?: RunnerFailure): void;
  /**
   * Where the runner has got to (P16 S-03), on the next beat. A new stage or a
   * new verdict wakes the loop at once; anything else, at most every
   * `PROGRESS_MIN_GAP_MS`.
   */
  progress(progress: RunnerProgress): void;
  /** The last response; `undefined` before the first beat. */
  readonly last: HeartbeatResponse | undefined;
  /** Beats until told to stop or until the plane is lost; resolves with the reason. */
  run(): Promise<"stop" | "lost">;
  /** Ends the loop after the current beat. */
  end(): void;
  /** One more beat carrying `milestone`, after the loop has ended: the runner's last word. */
  farewell(milestone: HeartbeatReport, failure?: RunnerFailure): Promise<void>;
  /** What setup took and which lockfiles the checkout has, sent once on the next beat (T3). */
  describeSetup(setupSeconds: number, lockfileHashes: Readonly<Record<string, string>>): void;
}

/** The least time between beats woken by a progress that is not a new stage or verdict. */
export const PROGRESS_MIN_GAP_MS = 2000;

/** A progress the plane should hear at once: another stage, or a verdict it has not had. */
const isNews = (before: RunnerProgress | undefined, after: RunnerProgress): boolean =>
  before === undefined ||
  before.stage !== after.stage ||
  (after.verdict !== undefined && after.verdict !== before.verdict);

export class HeartbeatLostError extends Error {
  override readonly name = "HeartbeatLostError";
}

export const createHeartbeat = (options: HeartbeatOptions): Heartbeat => {
  const intervalMs = options.intervalMs ?? HEARTBEAT_INTERVAL_SECONDS * 1000;
  const startedAt = options.now();
  // Milestones wait their turn: `ready` then `stopped` arrive as two beats, in
  // order, never one overwriting the other unsent.
  const pending: { report: HeartbeatReport; failure?: RunnerFailure }[] = [];
  let setup: { setupSeconds: number; lockfileHashes: Record<string, string> } | undefined;
  // The progress the plane has not yet had, the newest of each stage in turn,
  // and the last one given.
  const unsent: RunnerProgress[] = [];
  let given: RunnerProgress | undefined;
  // The loop's wait between beats ends early when woken: `woken` says a beat
  // is wanted now, and `rouse` ends the wait under way, if there is one.
  let woken = false;
  let rouse: (() => void) | undefined;
  let lastBeatAt: number | undefined;
  let last: HeartbeatResponse | undefined;
  let ended = false;
  let misses = 0;

  const wake = (): void => {
    woken = true;
    rouse?.();
  };

  /**
   * The interval, or less: until a progress wakes the loop, or it is ended.
   * After a missed beat, the whole interval unless ended: a busy audit's
   * progress must not spend the misses a lease allows in seconds.
   */
  const pause = async (missed: boolean): Promise<void> => {
    if (ended || (woken && !missed)) return;
    const slept = options.sleep(intervalMs).then(() => true);
    for (;;) {
      const done = await Promise.race([
        slept,
        new Promise<boolean>((resolve) => {
          rouse = () => resolve(false);
        }),
      ]);
      rouse = undefined;
      if (done || ended || !missed) return;
    }
  };

  const beat = async (): Promise<HeartbeatResponse> => {
    woken = false;
    lastBeatAt = options.now();
    // Taken now, so a milestone or progress reported while this beat is in
    // flight waits for the next one rather than being cleared unsent.
    const next = pending.shift();
    const described = setup;
    setup = undefined;
    // `stopped` ends the dispatch, so it carries the newest progress (an
    // audit's `fault`) and nothing is left to follow it.
    const progress = next?.report === "stopped" ? unsent.splice(0).at(-1) : unsent.shift();
    // A stage still waiting behind this one follows as soon as this beat returns.
    if (unsent.length > 0) woken = true;
    let response: HeartbeatResponse;
    try {
      const sample = await options.sample();
      const body: HeartbeatBody = {
        generation: options.generation,
        meteredSeconds: Math.max(0, Math.floor((options.now() - startedAt) / 1000)),
        samples: sample === undefined ? [] : [sample],
        ...(next === undefined ? {} : { report: next.report }),
        ...(next?.failure === undefined ? {} : { failure: next.failure }),
        ...(described === undefined ? {} : described),
        ...(progress === undefined ? {} : { progress }),
      };
      response = HeartbeatResponseSchema.parse(await options.post(body));
    } catch (error) {
      // Unsent, whether the sample, the post or the answer failed: say it
      // again next time, ahead of anything reported since. Progress is the
      // exception: a newer one given meanwhile is the one to send.
      if (next !== undefined) pending.unshift(next);
      setup ??= described;
      if (progress !== undefined && unsent.length === 0) unsent.push(progress);
      throw error;
    }
    if (response.token !== undefined) options.installToken(response.token);
    return response;
  };

  return {
    report: (milestone, failure) => {
      pending.push(failure === undefined ? { report: milestone } : { report: milestone, failure });
    },
    progress: (progress) => {
      const news = isNews(given, progress);
      given = progress;
      if (unsent.at(-1)?.stage === progress.stage) unsent[unsent.length - 1] = progress;
      else unsent.push(progress);
      if (news || lastBeatAt === undefined || options.now() - lastBeatAt >= PROGRESS_MIN_GAP_MS) {
        wake();
      }
    },
    describeSetup: (setupSeconds, lockfileHashes) => {
      setup = { setupSeconds, lockfileHashes: { ...lockfileHashes } };
    },
    get last() {
      return last;
    },
    end: () => {
      ended = true;
      // The wait under way need not run out: the loop ends, and flushes, now.
      wake();
    },
    farewell: async (milestone, failure) => {
      // Everything still queued goes first, in order: a `ready` the loop had
      // not yet carried when the plane said stop is not lost to the farewell,
      // and nor is a progress (an audit's `fault`) not yet sent.
      pending.push(failure === undefined ? { report: milestone } : { report: milestone, failure });
      while (pending.length > 0 || unsent.length > 0) {
        try {
          last = await beat();
        } catch (error) {
          options.log(
            `the farewell heartbeat failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          return;
        }
      }
    },
    run: async () => {
      while (!ended) {
        let missed = false;
        try {
          last = await beat();
          misses = 0;
          if (last.stop) {
            options.log(`the plane says stop: dispatch is ${last.status}`);
            return "stop";
          }
        } catch (error) {
          misses += 1;
          missed = true;
          options.log(
            `heartbeat failed (${misses}/${LEASE_MISSES}): ${error instanceof Error ? error.message : String(error)}`,
          );
          if (misses >= LEASE_MISSES) return "lost";
        }
        await pause(missed);
      }
      // Ended with a milestone or a progress unsent (the work finished): one
      // last beat, best effort, so the plane hears `stopped` from the runner
      // rather than from the reconciler's lost lease, and the progress with or
      // before it.
      while (pending.length > 0 || unsent.length > 0) {
        try {
          last = await beat();
        } catch (error) {
          options.log(
            `the last heartbeat failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          break;
        }
      }
      return "stop";
    },
  };
};
