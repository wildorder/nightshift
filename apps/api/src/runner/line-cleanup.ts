/**
 * What happens to the line's machine when its dispatch ends (Pipkin M1b, J5):
 * the reconciler's part, as a function over ports.
 *
 * A `stopping` dispatch whose owner went quiet is terminated and `stopped`. A
 * `stopped` or `failed` one has its instance terminated and its volume deleted,
 * with NO warm snapshot (the line's checkout is not a run's cache), and then
 * `cleanup.settledAt` is set: a new dispatch of the line is stored only after
 * that. A dispatch that never launched anything is settled at once. Once
 * settled, a line that still has work gets its next dispatch.
 */
import type { LineDispatch } from "@nightshift/contracts";
import {
  type Clock,
  type ComputeControl,
  type EnsureLineDispatchDeps,
  ensureLineDispatch,
  HEARTBEAT_INTERVAL_SECONDS,
  lineHasWork,
  nowIso,
  type ProjectStores,
  transitionDispatch,
} from "@nightshift/core";
import { lineCapUsd } from "./line-support.js";

export interface LineCleanupDeps {
  readonly stores: EnsureLineDispatchDeps["stores"] & Pick<ProjectStores, "programContracts">;
  readonly compute: ComputeControl;
  readonly clock: Clock;
  readonly ids: EnsureLineDispatchDeps["ids"];
  /** Brings the machine up for the dispatch just stored `requested`. */
  readonly startMachine: EnsureLineDispatchDeps["startMachine"];
}

export type LineCleanupStep =
  | "terminating"
  | "terminated"
  | "volume_deleted"
  | "settled"
  | "restarted"
  | "waiting"
  | "done";

const instancesOf = (dispatch: LineDispatch): readonly string[] => [
  ...new Set([
    ...dispatch.attempts.flatMap((attempt) =>
      attempt.instanceId === undefined ? [] : [attempt.instanceId],
    ),
    ...(dispatch.instanceId === undefined ? [] : [dispatch.instanceId]),
  ]),
];

const keep = (
  deps: LineCleanupDeps,
  dispatch: LineDispatch,
  change: (current: LineDispatch) => LineDispatch | undefined,
): Promise<LineDispatch | undefined> =>
  deps.stores.lineDispatches.update(dispatch.projectId, dispatch.branch, (current) =>
    current.generation === dispatch.generation ? change(current) : undefined,
  );

const recordFailure = async (
  deps: LineCleanupDeps,
  dispatch: LineDispatch,
  failure: string,
): Promise<void> => {
  console.error(`line cleanup ${dispatch.projectId}/${dispatch.branch}: ${failure}`);
  await keep(deps, dispatch, (current) => ({
    ...current,
    cleanup: { ...current.cleanup, failures: [...current.cleanup.failures, failure] },
    updatedAt: nowIso(deps.clock),
  }));
};

/** A `stopping` dispatch whose owner went quiet: two heartbeat intervals after it was told to stop, it is terminated and `stopped`. */
export const enforceLineStop = async (
  deps: LineCleanupDeps,
  dispatch: LineDispatch,
): Promise<LineCleanupStep> => {
  if (dispatch.status !== "stopping") return "waiting";
  if (deps.clock.now() - Date.parse(dispatch.updatedAt) < 2 * HEARTBEAT_INTERVAL_SECONDS * 1000) {
    return "waiting";
  }
  const at = nowIso(deps.clock);
  for (const instanceId of instancesOf(dispatch)) {
    try {
      await deps.compute.terminate(instanceId);
    } catch (error) {
      await recordFailure(
        deps,
        dispatch,
        `terminate ${instanceId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return "waiting";
    }
  }
  await keep(deps, dispatch, (current) => {
    if (current.status !== "stopping") return undefined;
    const last = current.attempts.length - 1;
    const stopped = transitionDispatch(current, "stopped", at);
    return {
      ...stopped,
      attempts: stopped.attempts.map((attempt, index) =>
        index === last && attempt.endedAt === undefined
          ? { ...attempt, endedAt: at, endReason: "stopped" as const }
          : attempt,
      ),
      cleanup: { ...stopped.cleanup, terminatedAt: stopped.cleanup.terminatedAt ?? at },
    };
  });
  return "terminated";
};

/** Starts the next dispatch of a settled line that still has work. */
const restartIfWork = async (
  deps: LineCleanupDeps,
  dispatch: LineDispatch,
): Promise<LineCleanupStep> => {
  const record = await deps.stores.lines.get(dispatch.projectId, dispatch.branch);
  if (record === undefined || !lineHasWork(record)) return "done";
  const result = await ensureLineDispatch(deps, {
    projectId: dispatch.projectId,
    branch: dispatch.branch,
    capUsd: await lineCapUsd(deps.stores, dispatch.projectId, dispatch.branch),
  });
  return result.kind === "started" ? "restarted" : "done";
};

/**
 * One step of an ended dispatch's cleanup, called every minute until it is
 * settled, and then until the line has no work left for a new dispatch.
 */
export const cleanupLineDispatch = async (
  deps: LineCleanupDeps,
  original: LineDispatch,
): Promise<LineCleanupStep> => {
  if (original.status === "stopping") return enforceLineStop(deps, original);
  if (original.status !== "stopped" && original.status !== "failed") return "waiting";
  let dispatch = original;
  if (dispatch.cleanup.settledAt !== undefined) return restartIfWork(deps, dispatch);
  const at = nowIso(deps.clock);

  // Every machine this dispatch ever launched is gone before its volume is.
  for (const instanceId of instancesOf(dispatch)) {
    // Only "not found" (undefined) is proof the machine is gone; an error is not.
    let described: Awaited<ReturnType<ComputeControl["describe"]>>;
    try {
      described = await deps.compute.describe(instanceId);
    } catch (error) {
      await recordFailure(
        deps,
        dispatch,
        `describe ${instanceId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return "waiting";
    }
    if (described === undefined || described.state === "terminated") continue;
    if (described.state !== "shutting-down") {
      try {
        await deps.compute.terminate(instanceId);
      } catch (error) {
        await recordFailure(
          deps,
          dispatch,
          `terminate ${instanceId}: ${error instanceof Error ? error.message : String(error)}`,
        );
        return "waiting";
      }
      await keep(deps, dispatch, (current) => ({
        ...current,
        cleanup: { ...current.cleanup, terminatedAt: current.cleanup.terminatedAt ?? at },
        updatedAt: at,
      }));
    }
    // A request, not an ending: the next pass observes the machine gone.
    return "terminating";
  }

  if (dispatch.volumeId !== undefined && !dispatch.cleanup.volumeDeleted) {
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
    dispatch =
      (await keep(deps, dispatch, (current) => ({
        ...current,
        cleanup: { ...current.cleanup, volumeDeleted: true, volumeDeletedAt: at },
        updatedAt: at,
      }))) ?? dispatch;
  }

  const settled = await keep(deps, dispatch, (current) => ({
    ...current,
    cleanup: {
      ...current.cleanup,
      volumeDeleted: current.volumeId === undefined ? current.cleanup.volumeDeleted : true,
      settledAt: at,
    },
    updatedAt: at,
  }));
  if (settled === undefined) return "waiting";
  const restarted = await restartIfWork(deps, settled);
  return restarted === "restarted" ? "restarted" : "settled";
};
