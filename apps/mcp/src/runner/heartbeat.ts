/**
 * The engine's heartbeat (P10, D-P10-18, D-P10-20).
 *
 * Every interval: the samples since the last, the seconds metered so far, and
 * whatever milestone was reached, to `POST …/dispatch/heartbeat` under the
 * current engine token. The response carries the lease, the next token, and
 * whether to stop. Three missed heartbeats from this side and the process
 * exits non-zero: the lease is lost either way, and a runner that cannot speak
 * to the plane must not keep working as if it could.
 */
import {
  type HeartbeatBody,
  type HeartbeatReport,
  type HeartbeatResponse,
  HeartbeatResponseSchema,
  type UtilizationSample,
} from "@nightshift/contracts";
import { HEARTBEAT_INTERVAL_SECONDS, LEASE_MISSES, type RunScope } from "@nightshift/core";
import { routes, send, type Transport } from "@nightshift/persistence/http";

export interface HeartbeatOptions {
  readonly scope: RunScope;
  readonly generation: number;
  readonly transport: Transport;
  /** Replaces the token the transport sends, when the plane renews it. */
  readonly installToken: (token: string) => void;
  readonly sample: () => Promise<UtilizationSample | undefined>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
  readonly log: (line: string) => void;
  readonly intervalMs?: number;
}

export interface Heartbeat {
  /** Something to tell the plane on the next beat. */
  report(milestone: HeartbeatReport): void;
  /** The last response; `undefined` before the first beat. */
  readonly last: HeartbeatResponse | undefined;
  /** Beats until told to stop or until the plane is lost; resolves with the reason. */
  run(): Promise<"stop" | "lost">;
  /** Ends the loop after the current beat. */
  end(): void;
}

export class HeartbeatLostError extends Error {
  override readonly name = "HeartbeatLostError";
}

export const createHeartbeat = (options: HeartbeatOptions): Heartbeat => {
  const intervalMs = options.intervalMs ?? HEARTBEAT_INTERVAL_SECONDS * 1000;
  const startedAt = options.now();
  // Milestones wait their turn: `ready` then `stopped` arrive as two beats, in
  // order, never one overwriting the other unsent.
  const pending: HeartbeatReport[] = [];
  let last: HeartbeatResponse | undefined;
  let ended = false;
  let misses = 0;

  const beat = async (): Promise<HeartbeatResponse> => {
    const sample = await options.sample();
    // Taken now, so a milestone reported while this beat is in flight waits
    // for the next one rather than being cleared unsent.
    const report = pending.shift();
    const body: HeartbeatBody = {
      generation: options.generation,
      meteredSeconds: Math.max(0, Math.floor((options.now() - startedAt) / 1000)),
      samples: sample === undefined ? [] : [sample],
      ...(report === undefined ? {} : { report }),
    };
    let response: HeartbeatResponse;
    try {
      response = HeartbeatResponseSchema.parse(
        await send(options.transport, {
          method: "POST",
          path: routes.dispatchHeartbeat(options.scope),
          body,
        }),
      );
    } catch (error) {
      // Unsent: say it again next time, ahead of anything reported since.
      if (report !== undefined) pending.unshift(report);
      throw error;
    }
    if (response.token !== undefined) options.installToken(response.token);
    return response;
  };

  return {
    report: (milestone) => {
      pending.push(milestone);
    },
    get last() {
      return last;
    },
    end: () => {
      ended = true;
    },
    run: async () => {
      while (!ended) {
        try {
          last = await beat();
          misses = 0;
          if (last.stop) {
            options.log(`the plane says stop: dispatch is ${last.status}`);
            return "stop";
          }
        } catch (error) {
          misses += 1;
          options.log(
            `heartbeat failed (${misses}/${LEASE_MISSES}): ${error instanceof Error ? error.message : String(error)}`,
          );
          if (misses >= LEASE_MISSES) return "lost";
        }
        await options.sleep(intervalMs);
      }
      // Ended with a milestone unsent (the work finished): one last beat, best
      // effort, so the plane hears `stopped` from the runner rather than from
      // the reconciler's lost lease.
      while (pending.length > 0) {
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
