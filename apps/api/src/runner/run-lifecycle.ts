/**
 * A program run that follows its dispatch, where its engine cannot end it.
 *
 * A program run is started and ended by its engine through the run routes. Two
 * endings have no engine to say them: a machine that ended before the engine
 * started the run, and an operator's `cancel` (`remote pause` stops a machine
 * and keeps its run, to be resumed; `remote cancel` ends the run). The plane
 * ends the run with its dispatch, so the program's one live run is free for the
 * next `nightshift run`.
 */
import type { Dispatch, DispatchFailureCode } from "@nightshift/contracts";
import {
  type Clock,
  IllegalTransitionError,
  isDispatchTerminal,
  isLineProgram,
  isRunTerminal,
  nowIso,
  type ProjectStores,
  transitionRun,
} from "@nightshift/core";

/** The failure code `remote cancel` leaves on a dispatch: its run ends with it. */
export const CANCELLED_BY_OPERATOR = "cancelled" satisfies DispatchFailureCode;
/** The failure code `remote pause` leaves on a dispatch: its run is kept, to be resumed. */
export const PAUSED_BY_OPERATOR = "paused" satisfies DispatchFailureCode;

/**
 * A run whose machine ended before its engine started it (2026-11-06: setup
 * failed on a warm volume, and the run stayed `pending`, holding its program's
 * one live run so no new run could start). When a program run is still
 * `pending` and its dispatch has ended for any reason but a pause, the run is
 * interrupted with the machine's own reason.
 */
export const followUnstartedRun = async (
  stores: Pick<ProjectStores, "programContracts" | "runs">,
  clock: Clock,
  dispatch: Dispatch,
): Promise<boolean> => {
  if (!isDispatchTerminal(dispatch.status)) return false;
  if (dispatch.failure?.code === PAUSED_BY_OPERATOR) return false;
  const scope = { projectId: dispatch.projectId, programId: dispatch.programId };
  const program = await stores.programContracts.get(scope.projectId, scope.programId);
  if (program === undefined || isLineProgram(program)) return false;
  const run = await stores.runs.get(scope, dispatch.runId);
  if (run === undefined || run.status !== "pending") return false;
  const why = dispatch.failure?.message ?? "its machine stopped";
  try {
    await stores.runs.put(
      transitionRun(run, "interrupt", {
        endedAt: nowIso(clock),
        outcomeReason: `The run never started: ${why}. Start it again with \`nightshift run\` once the cause is fixed.`,
      }),
    );
    return true;
  } catch (error) {
    if (!(error instanceof IllegalTransitionError)) throw error;
    return false;
  }
};

/**
 * A run the operator cancelled, once its machine has stopped: ended
 * `cancelled`, with the dispatch's reason. Its unlanded strands are at GitHub
 * and the next run of the program continues them (A-60).
 */
export const followCancelledRun = async (
  stores: Pick<ProjectStores, "programContracts" | "runs">,
  clock: Clock,
  dispatch: Dispatch,
): Promise<boolean> => {
  if (!isDispatchTerminal(dispatch.status)) return false;
  if (dispatch.failure?.code !== CANCELLED_BY_OPERATOR) return false;
  const scope = { projectId: dispatch.projectId, programId: dispatch.programId };
  const program = await stores.programContracts.get(scope.projectId, scope.programId);
  if (program === undefined || isLineProgram(program)) return false;
  const run = await stores.runs.get(scope, dispatch.runId);
  if (run === undefined || isRunTerminal(run.status)) return false;
  try {
    await stores.runs.put(
      transitionRun(run, "cancel", {
        endedAt: nowIso(clock),
        outcomeReason: dispatch.failure.message,
      }),
    );
    return true;
  } catch (error) {
    if (!(error instanceof IllegalTransitionError)) throw error;
    return false;
  }
};
