/**
 * What happens to a machine and its volume when a run ends (P10, D-P10-15,
 * D-P10-18): the reconciler's part, as a function over ports.
 *
 * A dispatch in `stopping` whose runner has not said `stopped` within two
 * heartbeats is terminated; one in `stopped` with a volume still there has its
 * volume snapshotted (when the run's setup passed at least once), the snapshot
 * becomes the project's warm cache, the volume is deleted, superseded snapshots
 * past the kept history are deleted, and the dispatch records all of it. Each
 * call advances the state by what EC2 has done since; the reconciler calls it
 * every minute until `cleanup.volumeDeleted` is true. `cleanup.terminatedAt`
 * is when the stop's terminate was REQUESTED, not an observed ending; the
 * observed ending is each attempt's `terminatedAt`.
 */
import type { Dispatch, WarmCache, WarmSnapshot } from "@nightshift/contracts";
import { WARM_CACHE_HISTORY } from "@nightshift/contracts";
import {
  architectureOf,
  type Clock,
  type ComputeControl,
  HEARTBEAT_INTERVAL_SECONDS,
  type NightshiftStores,
  nowIso,
  SNAPSHOT_RETENTION_DAYS,
  transitionDispatch,
} from "@nightshift/core";

export interface CleanupDeps {
  readonly stores: NightshiftStores;
  readonly compute: ComputeControl;
  readonly clock: Clock;
  readonly stage: string;
}

export type CleanupStep =
  | "terminated"
  | "snapshot_started"
  | "snapshot_pending"
  | "cache_updated"
  | "volume_deleted"
  | "done"
  | "waiting";

const scopeOf = (dispatch: Dispatch) => ({
  projectId: dispatch.projectId,
  programId: dispatch.programId,
  runId: dispatch.runId,
});

const recordFailure = async (
  deps: CleanupDeps,
  dispatch: Dispatch,
  failure: string,
): Promise<Dispatch> => {
  const next: Dispatch = {
    ...dispatch,
    cleanup: {
      ...dispatch.cleanup,
      failures: [...dispatch.cleanup.failures, failure],
    },
    updatedAt: nowIso(deps.clock),
  };
  // On the record for the customer, and in the log for the operator: a
  // cleanup that fails quietly every minute looks exactly like one waiting.
  console.error(`cleanup ${dispatch.runId}: ${failure}`);
  await deps.stores.dispatches.put(next);
  return next;
};

/**
 * What was learned of the current (last) attempt's machine: a terminate
 * request accepted (`terminationRequestedAt`, asynchronous, not an ending), the
 * observed ending (`terminatedAt`: describe said terminated or not found), or a
 * terminate request that failed. An existing `terminatedAt` is never
 * overwritten, a request time never replaces an earlier one, and a failure
 * never replaces either.
 */
export const withMachineEnding = (
  dispatch: Dispatch,
  ending:
    | { readonly terminatedAt: string }
    | { readonly terminationRequestedAt: string }
    | { readonly terminationFailed: true },
): Dispatch => {
  const last = dispatch.attempts.length - 1;
  return {
    ...dispatch,
    attempts: dispatch.attempts.map((attempt, index) => {
      if (index !== last || attempt.terminatedAt !== undefined) return attempt;
      if ("terminationRequestedAt" in ending && attempt.terminationRequestedAt !== undefined)
        return attempt;
      return { ...attempt, ...ending };
    }),
  };
};

/**
 * Confirm the observed ending of every attempt whose machine was asked to
 * terminate (or whose terminate request failed) and has no `terminatedAt`:
 * describe the instance and stamp `terminatedAt` when it is terminated or no
 * longer found. This reaches the machines of earlier, replaced attempts, which
 * nothing else revisits. It never throws: a describe or store failure is
 * logged and left for the next pass.
 */
export const confirmTerminations = async (
  deps: Pick<CleanupDeps, "stores" | "compute" | "clock">,
  dispatch: Dispatch,
): Promise<Dispatch> => {
  try {
    const last = dispatch.attempts.length - 1;
    const confirmed = new Set<number>();
    for (const [index, attempt] of dispatch.attempts.entries()) {
      if (attempt.terminatedAt !== undefined) continue;
      if (attempt.terminationRequestedAt === undefined && attempt.terminationFailed !== true)
        continue;
      const instanceId = attempt.instanceId ?? (index === last ? dispatch.instanceId : undefined);
      if (instanceId === undefined) continue;
      try {
        const described = await deps.compute.describe(instanceId);
        if (described === undefined || described.state === "terminated")
          confirmed.add(attempt.generation);
      } catch (error) {
        console.error(`confirm ${dispatch.runId}: describe ${instanceId}:`, error);
      }
    }
    if (confirmed.size === 0) return dispatch;
    // Re-read so a heartbeat that landed meanwhile is not overwritten.
    const at = nowIso(deps.clock);
    const fresh = (await deps.stores.dispatches.get(scopeOf(dispatch))) ?? dispatch;
    const next: Dispatch = {
      ...fresh,
      attempts: fresh.attempts.map((attempt) =>
        confirmed.has(attempt.generation) && attempt.terminatedAt === undefined
          ? { ...attempt, terminatedAt: at }
          : attempt,
      ),
    };
    await deps.stores.dispatches.put(next);
    return next;
  } catch (error) {
    console.error(`confirm ${dispatch.runId}: terminations:`, error);
    return dispatch;
  }
};

/**
 * A `stopping` dispatch whose runner went quiet: two heartbeat intervals after
 * it was told to stop, the machine is terminated and the dispatch is `stopped`.
 */
export const enforceStop = async (deps: CleanupDeps, dispatch: Dispatch): Promise<CleanupStep> => {
  if (dispatch.status !== "stopping") return "waiting";
  const toldAt = Date.parse(dispatch.updatedAt);
  if (deps.clock.now() - toldAt < 2 * HEARTBEAT_INTERVAL_SECONDS * 1000) return "waiting";
  if (dispatch.instanceId !== undefined) {
    try {
      await deps.compute.terminate(dispatch.instanceId);
    } catch (error) {
      await recordFailure(
        deps,
        withMachineEnding(dispatch, { terminationFailed: true }),
        `terminate ${dispatch.instanceId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return "waiting";
    }
  }
  const at = nowIso(deps.clock);
  const last = dispatch.attempts.length - 1;
  const stopped = transitionDispatch(
    dispatch.instanceId === undefined
      ? dispatch
      : withMachineEnding(dispatch, { terminationRequestedAt: at }),
    "stopped",
    at,
  );
  await deps.stores.dispatches.put({
    ...stopped,
    attempts: stopped.attempts.map((attempt, index) =>
      index === last && attempt.endedAt === undefined
        ? { ...attempt, endedAt: at, endReason: "stopped" as const }
        : attempt,
    ),
    cleanup: {
      ...stopped.cleanup,
      terminatedAt: stopped.cleanup.terminatedAt ?? at,
    },
  });
  return "terminated";
};

/**
 * One step of a `stopped` dispatch's cleanup. The snapshot is taken only when
 * the run's setup passed at least once, which the utilization record says
 * (`setupSeconds`); a run that never got a usable checkout leaves the project's
 * cache as it was.
 */
export const cleanupStopped = async (
  deps: CleanupDeps,
  original: Dispatch,
): Promise<CleanupStep> => {
  let dispatch = original;
  if (dispatch.status !== "stopped" && dispatch.status !== "failed") return "waiting";
  if (dispatch.cleanup.volumeDeleted) return "done";
  const scope = scopeOf(dispatch);
  const at = nowIso(deps.clock);

  // Earlier attempts' machines, and this one's, whose termination was asked
  // for: their observed endings are confirmed before anything else.
  dispatch = await confirmTerminations(deps, dispatch);

  // The machine, if it is somehow still there.
  if (dispatch.instanceId !== undefined) {
    const described = await deps.compute.describe(dispatch.instanceId);
    if (described !== undefined && described.state !== "terminated") {
      if (described.state !== "shutting-down") {
        try {
          await deps.compute.terminate(dispatch.instanceId);
        } catch (error) {
          console.error(`cleanup ${dispatch.runId}: terminate ${dispatch.instanceId}:`, error);
          await deps.stores.dispatches.put({
            ...withMachineEnding(dispatch, { terminationFailed: true }),
            updatedAt: at,
          });
          return "waiting";
        }
        // A request, not an ending: the next pass observes the machine gone.
        await deps.stores.dispatches.put({
          ...withMachineEnding(dispatch, { terminationRequestedAt: at }),
          cleanup: {
            ...dispatch.cleanup,
            terminatedAt: dispatch.cleanup.terminatedAt ?? at,
          },
          updatedAt: at,
        });
      }
      return "waiting";
    }
    // Terminated, or no longer found for an instance this dispatch knew: an
    // observed ending.
    const last = dispatch.attempts[dispatch.attempts.length - 1];
    if (last !== undefined && last.terminatedAt === undefined) {
      dispatch = {
        ...withMachineEnding(dispatch, { terminatedAt: at }),
        updatedAt: at,
      };
      await deps.stores.dispatches.put(dispatch);
    }
  }
  if (dispatch.volumeId === undefined) {
    await deps.stores.dispatches.put({
      ...dispatch,
      cleanup: {
        ...dispatch.cleanup,
        volumeDeleted: true,
        volumeDeletedAt: at,
      },
      updatedAt: at,
    });
    return "done";
  }

  // Snapshot, when the volume is worth keeping.
  if (dispatch.cleanup.snapshotId === undefined) {
    const utilization = await deps.stores.computeUtilizations.get(scope);
    if (utilization?.setupSeconds === undefined) {
      try {
        await deps.compute.deleteVolume(dispatch.volumeId);
      } catch (error) {
        await recordFailure(
          deps,
          dispatch,
          `delete volume ${dispatch.volumeId}: ${error instanceof Error ? error.message : String(error)}`,
        );
        return "waiting";
      }
      await deps.stores.dispatches.put({
        ...dispatch,
        cleanup: {
          ...dispatch.cleanup,
          volumeDeleted: true,
          volumeDeletedAt: at,
        },
        updatedAt: at,
      });
      return "volume_deleted";
    }
    try {
      const { snapshotId } = await deps.compute.snapshot({
        volumeId: dispatch.volumeId,
        tags: {
          "nightshift:managed": "true",
          "nightshift-project": dispatch.projectId,
          "nightshift-run": dispatch.runId,
          Name: `nightshift-${deps.stage}-${dispatch.projectId}`,
        },
      });
      await deps.stores.dispatches.put({
        ...dispatch,
        cleanup: { ...dispatch.cleanup, snapshotId },
        updatedAt: at,
      });
      return "snapshot_started";
    } catch (error) {
      await recordFailure(
        deps,
        dispatch,
        `snapshot ${dispatch.volumeId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return "waiting";
    }
  }

  // The snapshot completes on EC2's clock; until then the volume stays.
  if (dispatch.cleanup.snapshotTakenAt === undefined) {
    const snapshot = await deps.compute.describeSnapshot(dispatch.cleanup.snapshotId);
    if (snapshot === undefined || snapshot.state === "error") {
      // Start again next tick: the snapshot is gone or broken.
      await recordFailure(
        deps,
        {
          ...dispatch,
          cleanup: { ...dispatch.cleanup, snapshotId: undefined },
        },
        `snapshot ${dispatch.cleanup.snapshotId} ${snapshot === undefined ? "vanished" : "errored"}`,
      );
      return "waiting";
    }
    if (snapshot.state !== "completed") return "snapshot_pending";
    const architecture = architectureOf(dispatch.instanceType);
    const existing = await deps.stores.warmCaches.get(dispatch.projectId, architecture);
    const current: WarmSnapshot = {
      snapshotId: dispatch.cleanup.snapshotId,
      amiVersion: dispatch.amiVersion,
      lockfileHashes: dispatch.lockfileHashes ?? {},
      fromRunId: dispatch.runId,
      takenAt: at,
    };
    const history = existing === undefined ? [] : [existing.current, ...existing.history];
    const cache: WarmCache = {
      schemaVersion: 1,
      projectId: dispatch.projectId,
      architecture,
      current,
      history: history.slice(0, WARM_CACHE_HISTORY),
      updatedAt: at,
    };
    await deps.stores.warmCaches.put(cache);
    // Superseded past the kept history, or older than the retention: gone.
    const retentionMs = SNAPSHOT_RETENTION_DAYS * 24 * 3600 * 1000;
    const dropped = [
      ...history.slice(WARM_CACHE_HISTORY),
      ...cache.history.filter(
        (snapshot) => deps.clock.now() - Date.parse(snapshot.takenAt) > retentionMs,
      ),
    ];
    for (const old of dropped) {
      await deps.compute.deleteSnapshot(old.snapshotId).catch(() => undefined);
    }
    if (dropped.length > 0) {
      await deps.stores.warmCaches.put({
        ...cache,
        history: cache.history.filter((snapshot) => !dropped.includes(snapshot)),
      });
    }
    await deps.stores.dispatches.put({
      ...dispatch,
      cleanup: { ...dispatch.cleanup, snapshotTakenAt: at },
      updatedAt: at,
    });
    return "cache_updated";
  }

  try {
    await deps.compute.deleteVolume(dispatch.volumeId);
  } catch (error) {
    await recordFailure(
      deps,
      dispatch,
      `delete volume ${dispatch.volumeId}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return "waiting";
  }
  await deps.stores.dispatches.put({
    ...dispatch,
    cleanup: { ...dispatch.cleanup, volumeDeleted: true, volumeDeletedAt: at },
    updatedAt: at,
  });
  return "volume_deleted";
};
