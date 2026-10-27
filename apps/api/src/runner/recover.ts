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
  type DispatchMachine,
  leaseLost,
  type NightshiftStores,
  nowIso,
  transitionDispatch,
} from "@nightshift/core";
import { confirmTerminations, withMachineEnding } from "./cleanup.js";

export interface RecoverDeps {
  readonly stores: NightshiftStores;
  readonly compute: ComputeControl;
  readonly clock: Clock;
}

export type RecoveryStep = "alive" | "replacing" | "exhausted" | "refused";

/**
 * How a record is kept. `save` answers whether the write took: a line's is a
 * compare-and-swap, so a heartbeat that landed since the read refuses it and
 * the dispatch is left alone.
 */
export interface RecoverPorts<D extends DispatchMachine> {
  readonly compute: ComputeControl;
  readonly clock: Clock;
  readonly save: (next: D, original: D) => Promise<boolean>;
  /** Called when the lease holds, to confirm earlier attempts' endings. */
  readonly whenAlive?: (dispatch: D) => Promise<void>;
  /** Names the record in the log. */
  readonly label: string;
}

/**
 * One look at a live dispatch, over how it is saved: nothing when its lease
 * holds, a replacement or a failure when it lapsed. `replacing` carries the
 * dispatch as saved, with the next generation.
 */
export const recoverLease = async <D extends DispatchMachine>(
  ports: RecoverPorts<D>,
  original: D,
  options: {
    /** Asked before a replacement is made; a refusal ends the dispatch failed with it instead. */
    readonly refuseReplacement?: (
      dispatch: D,
    ) => Promise<{ readonly code: string; readonly message: string } | undefined>;
    /** The caller already observed the machine gone and recorded it: terminate is not asked again. */
    readonly machineGone?: boolean;
  } = {},
): Promise<{ readonly step: RecoveryStep; readonly dispatch: D }> => {
  let dispatch = original;
  const nowMs = ports.clock.now();
  if (!leaseLost(dispatch, nowMs)) {
    await ports.whenAlive?.(dispatch);
    return { step: "alive", dispatch };
  }
  const at = nowIso(ports.clock);
  if (dispatch.instanceId !== undefined && options.machineGone !== true) {
    // Gone or going; either way nothing of this generation may keep running.
    try {
      await ports.compute.terminate(dispatch.instanceId);
      dispatch = withMachineEnding(dispatch, { terminationRequestedAt: at });
    } catch (error) {
      console.error(`recover ${ports.label}: terminate ${dispatch.instanceId}:`, error);
      // The machine may still be running: no observed ending.
      dispatch = withMachineEnding(dispatch, { terminationFailed: true });
    }
  }
  if (attemptsExhausted(dispatch)) {
    const last = dispatch.attempts.length - 1;
    const failed = transitionDispatch(
      {
        ...dispatch,
        attempts: dispatch.attempts.map((attempt, index) =>
          index === last && attempt.endedAt === undefined
            ? { ...attempt, endedAt: at, endReason: "failed" as const }
            : attempt,
        ),
        failure: {
          code: "recovery_exhausted",
          message: `the lease lapsed on attempt ${dispatch.attempts.length}; no attempts remain`,
        },
      },
      "fail",
      at,
    );
    await ports.save(failed, original);
    return { step: "exhausted", dispatch: failed };
  }
  const refusal = await options.refuseReplacement?.(dispatch);
  if (refusal !== undefined) {
    const last = dispatch.attempts.length - 1;
    const refused = transitionDispatch(
      {
        ...dispatch,
        attempts: dispatch.attempts.map((attempt, index) =>
          index === last && attempt.endedAt === undefined
            ? { ...attempt, endedAt: at, endReason: "failed" as const }
            : attempt,
        ),
        failure: refusal,
      },
      "fail",
      at,
    );
    await ports.save(refused, original);
    return { step: "refused", dispatch: refused };
  }
  const replacement = beginReplacement(dispatch, "lease_lost", at, "lease_lost");
  if (!(await ports.save(replacement, original))) return { step: "alive", dispatch: original };
  return { step: "replacing", dispatch: replacement };
};

/** One look at a live run dispatch: nothing when its lease holds, a replacement or a failure when it lapsed. */
export const recoverLostLease = async (
  deps: RecoverDeps,
  original: Dispatch,
): Promise<RecoveryStep> =>
  (
    await recoverLease<Dispatch>(
      {
        compute: deps.compute,
        clock: deps.clock,
        label: original.runId,
        save: async (next) => {
          await deps.stores.dispatches.put(next);
          return true;
        },
        whenAlive: async (dispatch) => {
          // The run goes on; an earlier, replaced attempt's machine may still owe its observed ending.
          await confirmTerminations(deps, dispatch);
        },
      },
      original,
    )
  ).step;
