/**
 * The line run's own lifecycle (Pipkin). A program run is started and ended by
 * its engine through the run routes; a line run has no engine root, so the plane
 * follows its dispatch: the run starts when the owner reports `running`, and
 * ends when the dispatch is terminal, so the line program is free for the next
 * run (one live run per program).
 */
import type { Dispatch } from "@nightshift/contracts";
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

export const followLineRun = async (
  stores: Pick<ProjectStores, "programContracts" | "runs">,
  clock: Clock,
  dispatch: Dispatch,
): Promise<void> => {
  const scope = {
    projectId: dispatch.projectId,
    programId: dispatch.programId,
  };
  const program = await stores.programContracts.get(scope.projectId, scope.programId);
  if (program === undefined || !isLineProgram(program)) return;
  const run = await stores.runs.get(scope, dispatch.runId);
  if (run === undefined || isRunTerminal(run.status)) return;
  const at = nowIso(clock);
  try {
    if (isDispatchTerminal(dispatch.status)) {
      const reason = dispatch.failure?.message;
      const event =
        run.status === "pending" ? "interrupt" : reason === undefined ? "succeed" : "fail";
      await stores.runs.put(
        transitionRun(run, event, {
          endedAt: at,
          outcomeReason: reason ?? "the line's owner stopped",
        }),
      );
    } else if (dispatch.status === "running" && run.status === "pending") {
      await stores.runs.put(transitionRun(run, "start", { endedAt: at }));
    }
  } catch (error) {
    // The run moved on meanwhile (another beat, the reconciler): nothing to do.
    if (!(error instanceof IllegalTransitionError)) throw error;
  }
};
