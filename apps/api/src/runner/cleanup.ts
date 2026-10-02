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
 * every minute until `cleanup.volumeDeleted` is true.
 */
import type { Dispatch, WarmCache, WarmSnapshot } from "@nightshift/contracts";
import { WARM_CACHE_HISTORY } from "@nightshift/contracts";
import {
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
    cleanup: { ...dispatch.cleanup, failures: [...dispatch.cleanup.failures, failure] },
    updatedAt: nowIso(deps.clock),
  };
  await deps.stores.dispatches.put(next);
  return next;
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
        dispatch,
        `terminate ${dispatch.instanceId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return "waiting";
    }
  }
  await deps.stores.dispatches.put(transitionDispatch(dispatch, "stopped", nowIso(deps.clock)));
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
  dispatch: Dispatch,
): Promise<CleanupStep> => {
  if (dispatch.status !== "stopped" && dispatch.status !== "failed") return "waiting";
  if (dispatch.cleanup.volumeDeleted) return "done";
  const scope = scopeOf(dispatch);
  const at = nowIso(deps.clock);

  // The machine, if it is somehow still there.
  if (dispatch.instanceId !== undefined) {
    const described = await deps.compute.describe(dispatch.instanceId);
    if (described !== undefined && described.state !== "terminated") {
      if (described.state !== "shutting-down") await deps.compute.terminate(dispatch.instanceId);
      return "waiting";
    }
  }
  if (dispatch.volumeId === undefined) {
    await deps.stores.dispatches.put({
      ...dispatch,
      cleanup: { ...dispatch.cleanup, volumeDeleted: true },
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
        cleanup: { ...dispatch.cleanup, volumeDeleted: true },
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
        { ...dispatch, cleanup: { ...dispatch.cleanup, snapshotId: undefined } },
        `snapshot ${dispatch.cleanup.snapshotId} ${snapshot === undefined ? "vanished" : "errored"}`,
      );
      return "waiting";
    }
    if (snapshot.state !== "completed") return "snapshot_pending";
    const existing = await deps.stores.warmCaches.get(dispatch.projectId, "arm64");
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
      architecture: "arm64",
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
    cleanup: { ...dispatch.cleanup, volumeDeleted: true },
    updatedAt: at,
  });
  return "volume_deleted";
};
