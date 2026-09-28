/**
 * `nightshift resume`'s landing, with an examiner (P8, D-P8-14).
 *
 * Deferred work whose risk the run's policy says to examine is examined at
 * resume, once its deferred checks pass. The CLI may not construct a harness
 * adapter (A-31), so it cannot start an examiner; it starts this, in a process
 * of its own, exactly as `nightshift run` starts the headless root. The
 * environment is the one an attached session works a run in (`buildEnvironment`),
 * so an examination at resume is routed, identified and recorded as one in the
 * run.
 *
 * No orchestrator is started. The only agents are the examiners (and, after two
 * fixes, arbiters) the deferred work needs, and a worker for a check that fails
 * here, retried as the run would retry it (P9, D-P9-07).
 */

import type { RunScope } from "@nightshift/core";
import { createEventOutbox, type ResumeResult, resumeDeferred } from "@nightshift/execution";
import type { Runtime } from "./compose.js";
import { routeJob } from "./routing.js";
import { buildEnvironment } from "./session.js";

export interface ResumeInput {
  readonly scope: RunScope;
  /** The operator's clone: what the deferred work lands on. */
  readonly repoPath: string;
}

/** Why a resume could not begin: a run or program the control plane does not hold. */
export class ResumeRefusal extends Error {}

export const runResume = async (runtime: Runtime, input: ResumeInput): Promise<ResumeResult> => {
  const { scope } = input;
  const run = await runtime.stores.runs.get(scope, scope.runId);
  if (run === undefined) throw new ResumeRefusal(`no run ${scope.runId} in this program`);
  const program = await runtime.stores.programContracts.get(scope.projectId, scope.programId);
  if (program === undefined) throw new ResumeRefusal(`no program ${scope.programId}`);

  const outbox = createEventOutbox({
    events: runtime.stores.events,
    scope,
    clock: runtime.clock,
    ids: runtime.ids,
    // Its own writer: a resume is not the run's orchestrator, and says so (A-30).
    writerId: `resume-${runtime.ids.next("evt")}`,
  });
  const environment = buildEnvironment(runtime, outbox, run, program);
  try {
    // A check that fails here is retried as the run would retry it (P9,
    // D-P9-07): routed by the run's own policy, one rung up, a worker of its own.
    return await resumeDeferred(
      environment,
      { scope, program, repoPath: input.repoPath },
      {
        route: (job, context) => routeJob(run, program, job, context),
        mcp: (identity) => runtime.workerLaunch(identity),
      },
    );
  } finally {
    await outbox.flush(5_000).catch(() => {});
  }
};
