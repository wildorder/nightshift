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

import type { ProgramContract } from "@nightshift/contracts";
import { nowIso, type RunScope, runSettles, settleRunNode } from "@nightshift/core";
import {
  createEventOutbox,
  type ResumeResult,
  type RunSession,
  resumeDeferred,
  verifyRunHead,
} from "@nightshift/execution";
import type { Runtime } from "./compose.js";
import { publishPlannedRun } from "./publish-run.js";
import { routeJob } from "./routing.js";
import { buildEnvironment } from "./session.js";

export interface ResumeInput {
  readonly scope: RunScope;
  /** The operator's clone: what the deferred work lands on. */
  readonly repoPath: string;
}

/** Why a resume could not begin: a run or program the control plane does not hold. */
export class ResumeRefusal extends Error {}

/** A resume's result, and why the run's documents could not be committed when they could not. */
export interface ResumeOutcome extends ResumeResult {
  readonly publicationFailure?: string;
  /** A-63: the run was interrupted, and is now `succeeded`. */
  readonly settled?: boolean;
  /** A-63: why an interrupted run is still interrupted after this resume. */
  readonly unsettled?: string;
}

/**
 * Settles an interrupted run a resume has taken to its end (A-63): its records
 * say every strand succeeded and nothing is still to happen, and its end gates
 * pass on the program head (a deferred ending never ran them). The run becomes
 * `succeeded`, its root with it, and `run.completed` is said. Never a guess: a
 * run that died with unfinished strands does not settle, and neither does one
 * whose end gates fail; each is left as it is, with the reason said.
 */
const settleResumedRun = async (
  runtime: Runtime,
  environment: ReturnType<typeof buildEnvironment>,
  input: { readonly scope: RunScope; readonly program: ProgramContract; readonly repoPath: string },
): Promise<{ readonly settled: boolean; readonly said: string; readonly open?: boolean }> => {
  const { stores, clock } = runtime;
  const { scope, program } = input;
  const run = await stores.runs.get(scope, scope.runId);
  if (run === undefined || run.status !== "interrupted") {
    return {
      settled: false,
      said: `run ${scope.runId} is ${run?.status ?? "gone"}; nothing to settle`,
    };
  }
  const [nodes, jobs] = await Promise.all([
    everyPage((page) => stores.executionNodes.listByRun(scope, page)),
    everyPage((page) => stores.jobContracts.listByRun(scope, page)),
  ]);
  const verdict = runSettles({
    program,
    nodes,
    strandOfJob: new Map(
      jobs.flatMap((job) =>
        job.strandId === undefined ? [] : [[job.jobContractId, job.strandId]],
      ),
    ),
    carried: run.carriedStrands ?? [],
  });
  if (!verdict.settles) {
    return {
      settled: false,
      open: true,
      said: `run ${scope.runId} stays interrupted: ${verdict.why}`,
    };
  }
  const session = {
    scope,
    program,
    repoPath: input.repoPath,
    run,
    rootNodeId: run.rootNodeId,
  } as unknown as RunSession;
  const gates = await verifyRunHead(environment, session);
  if (gates.status !== "none" && gates.status !== "passed") {
    return {
      settled: false,
      open: true,
      said: `run ${scope.runId} stays interrupted: its end gates ${gates.status === "failed" ? `failed (${gates.failing.map((step) => step.stepId).join(", ")})` : `are ${gates.status}`} on the program head`,
    };
  }
  const at = nowIso(clock);
  const { outcomeReason: _was, ...rest } = run;
  await stores.runs.put({ ...rest, status: "succeeded", endedAt: at });
  const root = await stores.executionNodes.get(scope, run.rootNodeId);
  if (root !== undefined) {
    const settledRoot = settleRunNode(root, at);
    if (settledRoot !== root) await stores.executionNodes.put(settledRoot);
  }
  environment.outbox.emit({
    type: "run.completed",
    source: "control-plane",
    payload: { settledBy: "resume" },
    executionNodeId: run.rootNodeId,
  });
  return {
    settled: true,
    said: `run ${scope.runId} is succeeded: every strand succeeded, nothing is still to happen, and its end gates ${gates.status === "none" ? "are none" : "passed"}`,
  };
};

const everyPage = async <T>(
  list: (page: {
    cursor?: string;
  }) => Promise<{ items: readonly T[]; cursor?: string | undefined }>,
): Promise<T[]> => {
  const items: T[] = [];
  let cursor: string | undefined;
  do {
    const page = await list(cursor === undefined ? {} : { cursor });
    items.push(...page.items);
    cursor = page.cursor;
  } while (cursor !== undefined);
  return items;
};

export const runResume = async (runtime: Runtime, input: ResumeInput): Promise<ResumeOutcome> => {
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
  let settled = false;
  let unsettled: string | undefined;
  try {
    // A check that fails here is retried as the run would retry it (P9,
    // D-P9-07): routed by the run's own policy, one rung up, a worker of its own.
    const result = await resumeDeferred(
      environment,
      { scope, program, repoPath: input.repoPath },
      {
        route: (job, context) => routeJob(run, program, job, context),
        mcp: (identity) => runtime.workerLaunch(identity),
      },
    );
    // The run ends again here (P21, D-03): the program branch gets the updated
    // report as a new publication commit, or nothing if no published file
    // changed. This process runs in the operator's checkout, which has no
    // publication hook: the CLI pushes what it committed (F-01).
    if (result.blocked === undefined) {
      // The run ends true (A-63): an interrupted run its records say is
      // finished, whose end gates pass on the program head, is settled as
      // `succeeded` before its report is published; anything short of that
      // stays interrupted, and says why.
      const settling =
        result.stoppedAt === undefined && result.failed.length === 0
          ? await settleResumedRun(runtime, environment, {
              scope,
              program,
              repoPath: input.repoPath,
            })
          : undefined;
      if (settling !== undefined) {
        process.stderr.write(`[nightshift-resume] ${settling.said}\n`);
        settled = settling.settled;
        if (settling.open === true) unsettled = settling.said;
      }
      const name = (await runtime.stores.planDrafts.get(scope.projectId, scope.programId))?.name;
      const { failure } = await publishPlannedRun(runtime, {
        scope,
        program,
        repoPath: input.repoPath,
        name,
        rootNodeId: run.rootNodeId,
      });
      if (failure !== undefined) {
        process.stderr.write(`[nightshift-resume] could not publish: ${failure}\n`);
        return {
          ...result,
          publicationFailure: failure,
          ...(settled ? { settled } : {}),
          ...(unsettled === undefined ? {} : { unsettled }),
        };
      }
    }
    return {
      ...result,
      ...(settled ? { settled } : {}),
      ...(unsettled === undefined ? {} : { unsettled }),
    };
  } finally {
    await outbox.flush(5_000).catch(() => {});
  }
};
