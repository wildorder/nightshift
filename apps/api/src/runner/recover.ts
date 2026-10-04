/**
 * Recovery (P10, T6; D-P10-18, D-P10-05): a live dispatch whose lease lapsed.
 *
 * Three missed heartbeats and the machine is presumed gone: it is terminated
 * (idempotent; it may already be), and if the run still has an attempt left
 * the dispatch moves to the next generation and back to `provisioning` with no
 * machine, which `provisionDispatch` picks up: a new instance in the volume's
 * zone, the same volume attached, the runner restoring the sidecar's copy onto
 * its disk (D-P10-27) and the root carrying on from the plane's record. The
 * old runner, if it is somehow alive, is fenced by its generation at the API.
 * With no attempt left the dispatch fails as `recovery_exhausted`, and
 * cleanup snapshots and deletes the volume as for any stopped run.
 */
import type { Dispatch } from "@nightshift/contracts";
import {
  attemptsExhausted,
  beginReplacement,
  type Clock,
  type ComputeControl,
  leaseLost,
  type NightshiftStores,
  nowIso,
  transitionDispatch,
} from "@nightshift/core";

export interface RecoverDeps {
  readonly stores: NightshiftStores;
  readonly compute: ComputeControl;
  readonly clock: Clock;
}

export type RecoveryStep = "alive" | "replacing" | "exhausted";

/** One look at a live dispatch: nothing when its lease holds, a replacement or a failure when it lapsed. */
export const recoverLostLease = async (
  deps: RecoverDeps,
  dispatch: Dispatch,
): Promise<RecoveryStep> => {
  const nowMs = deps.clock.now();
  if (!leaseLost(dispatch, nowMs)) return "alive";
  const at = nowIso(deps.clock);
  if (dispatch.instanceId !== undefined) {
    // Gone or going; either way nothing of this generation may keep running.
    await deps.compute.terminate(dispatch.instanceId).catch((error: unknown) => {
      console.error(`recover ${dispatch.runId}: terminate ${dispatch.instanceId}:`, error);
    });
  }
  if (attemptsExhausted(dispatch)) {
    const failed = transitionDispatch(
      {
        ...dispatch,
        failure: {
          code: "recovery_exhausted",
          message: `the lease lapsed on attempt ${dispatch.attempts.length}; no attempts remain`,
        },
      },
      "fail",
      at,
    );
    await deps.stores.dispatches.put(failed);
    return "exhausted";
  }
  await deps.stores.dispatches.put(beginReplacement(dispatch, "lease_lost", at));
  return "replacing";
};
