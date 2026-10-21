/**
 * The job runner: a validated Job Contract becomes an integrated, checkpointed
 * commit (contract §4.3).
 *
 * ## The order of writes is the whole of SC-P3-02
 *
 * Every transition is written through the stores **before** the thing it
 * describes happens, in exactly the order the lifecycle table lists. The job
 * contract is persisted before a node exists; the node is `queued` and the agent
 * `created` before `harness.start` is called; the node is `running` and the
 * agent `started` before anything waits for the worker.
 *
 * That ordering is what makes "nothing executes without a Nightshift execution
 * identity" (A-04) true rather than aspirational: if the process dies between
 * any two of those writes, the central record already knows more than the
 * machine does, never less. The test that fails if `start` is called before the
 * node is `queued` is in `test/src/execution/`, and it was written before this
 * file was.
 *
 * ## What the runner does not decide
 *
 * It does not decide whether a delegation is legal — `core`'s `checkDelegation`
 * does, and `apps/mcp` calls it. It does not choose a model — `packages/routing`
 * does. It does not know what a harness is beyond `@nightshift/harness`. It
 * takes a plan and drives it.
 *
 * `delegate` returns as soon as the worker is running (D-P3-04); the rest of the
 * lifecycle continues on `completion`, which the server keeps so that shutdown
 * can wait for it.
 */

import { existsSync } from "node:fs";
import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  Agent,
  AgentId,
  AttemptCause,
  CommitSha,
  ExecutionNode,
  ExecutionNodeId,
  JobContract,
  JobContractId,
  LaunchRef,
  MeasurementCounters,
  RouteChoice,
  RouteOutcome,
  RouteTarget,
  RoutingDecision,
  RoutingDecisionId,
  Verification,
} from "@nightshift/contracts";
import { lifecycleOperationId } from "@nightshift/contracts";
import {
  baselineFor,
  labelCost,
  markVerificationFailed,
  nowIso,
  routeOutcomeForNodeStatus,
  routeUsageFromCounters,
  transition,
  transitionAgent,
} from "@nightshift/core";
import type { RunAs } from "@nightshift/harness";
import {
  type AgentTask,
  agentStatusForExit,
  type CarriedOverWork,
  commandAs,
  describeExit,
  type HarnessExit,
  type HarnessHandle,
  type HarnessStartInput,
  hookTypeForExit,
  type McpLaunch,
  millis,
  refusingWorkerTools,
  type StrandContinuation,
} from "@nightshift/harness";
import type { StepInvocation } from "@nightshift/verification";
import { continueUnfinishedStrand } from "./carry-over.js";
import {
  DEFAULT_CANCEL_GRACE_MS,
  type ExecutionEnvironment,
  type RunSession,
  type WorkerLaunchIdentity,
} from "./environment.js";
import { examine, skipReview } from "./examine.js";
import { gateDefinitions, withGateDefinitions } from "./gate-repair.js";
import {
  addWorktree,
  applyUnfinished,
  baseRef,
  cleanCheckout,
  collectUnfinished,
  effectiveHead,
  jobBranch,
  pruneWorktrees,
  tryRevParse,
  type UnfinishedWork,
  unfinishedPatch,
  unfinishedRef,
  updateRef,
} from "./git/index.js";
import { createHookSink, type RecordingHookSink } from "./hook-sink.js";
import { integrateNode } from "./integrate.js";
import { type LifecycleInput, observeLifecycle } from "./lifecycle.js";
import {
  createMeasurementRecorder,
  type MeasurementRecorder,
  publishedSummaryFor,
} from "./measurement/recorder.js";
import { releaseWorktree } from "./release-worktree.js";
import { unavailableUntil } from "./route-availability.js";
import { programRulings } from "./rulings.js";
import { discardScratch, ensureScratch } from "./scratch.js";
import { prepareCheckout } from "./setup.js";
import { stampSettledDecisions } from "./stamp.js";
import { mergeInto, strandBase, strandHead, strandMoved, strandOf } from "./strand.js";
import { verifyNode } from "./verify.js";
import { createWorkerTools } from "./worker.js";
import { startTokenRenewal, type TokenRenewal } from "./worker-tokens.js";

export interface RunJobInput {
  readonly session: RunSession;
  /** Validated by the caller, not yet persisted. */
  readonly job: JobContract;
  readonly depth: number;
  readonly parentNodeId: ExecutionNodeId;
  readonly route: RouteChoice;
  /** Builds the worker's MCP server launch, given the identity it must carry. */
  readonly mcp: (identity: WorkerLaunchIdentity) => McpLaunch;
  /**
   * How an `implemented` node reaches the program branch. Absent, it is verified
   * and integrated inline, which is only safe with one job in flight; the engine
   * supplies its merge queue (P6, D-P6-05), the one route to the branch when
   * there are several.
   */
  readonly integrate?: IntegrateCandidate;
}

/** What a finished worker hands on: everything the merge queue needs, and no more. */
export interface IntegrationCandidate {
  readonly session: RunSession;
  readonly job: JobContract;
  readonly nodeId: ExecutionNodeId;
  readonly agentId: AgentId;
  readonly worktree: string;
  readonly branch: string;
  /** The commit the worktree was cut from. */
  readonly base: CommitSha;
  /** The work attempt this candidate is the product of (P20): the lifecycle's operation identity. */
  readonly attempt: number;
  /** That attempt's routing decision, so the verification it gets names the attempt it judged (P20). */
  readonly routingDecisionId?: RoutingDecisionId;
  /** Where the candidate came from when it is not a worker's first hand-in (P20). */
  readonly origin?: "recovered" | "readmitted";
  /** The commit the candidate holds, when the hand-over knows it. */
  readonly commitSha?: CommitSha;
}

/** Settles when the candidate is integrated, or durably is not. Never rejects. */
export type IntegrateCandidate = (candidate: IntegrationCandidate) => Promise<void>;

/**
 * Where a job goes next when its route could not start (P8, D-P8-06), or
 * `undefined` when nothing is left. The engine supplies it: it holds the run's
 * list of unavailable routes and the router. `until` is when a limited route
 * may serve again; absent, it is out for the run.
 */
export type Reroute = (failed: RouteTarget, until?: string) => RouteChoice | undefined;

/**
 * An attempt's agent time (P20): the work intervals of its harness launches,
 * each opened as its process starts and closed as it exits, summed across resumes.
 */
interface WorkClock {
  /** Closed intervals so far. */
  ms: number;
  /** When the open interval began, while a launch is running. */
  openedAtMs?: number;
}

/** The instant a lifecycle observation names, else `fallbackMs`. */
const instantOf = (
  observation: { readonly occurredAt?: string | undefined } | undefined,
  fallbackMs: number,
) => {
  const at =
    observation?.occurredAt === undefined ? Number.NaN : Date.parse(observation.occurredAt);
  return Number.isNaN(at) ? fallbackMs : at;
};

/** Closes the open interval at `nowMs`; a second close is a no-op. */
const closeWork = (work: WorkClock, nowMs: number): void => {
  if (work.openedAtMs === undefined) return;
  work.ms += Math.max(0, nowMs - work.openedAtMs);
  delete work.openedAtMs;
};

/** One attempt's records, before its process exists. */
interface AttemptIdentity {
  readonly agent: Agent;
  readonly executionToken: string;
  /** P10 (T4): the file the worker reads its token from on a machine, kept fresh. */
  readonly executionTokenFile?: string;
  readonly renewal?: TokenRenewal;
  readonly routingDecision: RoutingDecision;
  /** P20: one recorder per agent, spanning its launches and resumes. */
  readonly recorder: MeasurementRecorder;
  /** When the attempt first launched; a resume does not reset it. */
  startedAtMs?: number;
  /** Agent time across the attempt's launches. */
  readonly work: WorkClock;
}

/** An earlier attempt's unfinished work, kept: the commit, and what the next worker is told of it. */
interface Kept {
  readonly work: UnfinishedWork;
  readonly carried: Omit<CarriedOverWork, "applied" | "conflicts">;
}

/**
 * What a start adds to the plain launch: a fresh start carries the job's task
 * and any unfinished work it starts from; a resumed session carries its
 * reminder and the session to continue.
 */
const launchExtras = (
  task: AgentTask | undefined,
  resumed: { readonly sessionId: string; readonly task: AgentTask } | undefined,
  carriedOver: CarriedOverWork | undefined,
): Pick<HarnessStartInput, "task" | "resume" | "carriedOver"> => {
  if (resumed !== undefined)
    return { task: resumed.task, resume: { sessionId: resumed.sessionId } };
  return {
    ...(task === undefined ? {} : { task }),
    ...(carriedOver === undefined ? {} : { carriedOver }),
  };
};

/** One attempt, running: its agent, its process, and its routing decision. */
interface Attempt {
  readonly agentId: AgentId;
  readonly handle: HarnessHandle;
  /** The sink the adapter was given, so the ending is emitted once. */
  readonly sink: RecordingHookSink;
  /** As recorded before the work began: `usage` empty, `outcome` pending (A-13). */
  readonly routingDecision: RoutingDecision;
  readonly recorder: MeasurementRecorder;
  readonly startedAtMs: number;
  /** Agent time across this attempt's launches, shared by its resumes. */
  readonly work: WorkClock;
  /** The launch this process is: a resume of the session is a launch of its own. */
  readonly launch: LaunchRef;
}

/** What it takes to record a delegation: the first half of {@link runJob}. */
export interface DelegateJobInput
  extends Pick<RunJobInput, "session" | "job" | "depth" | "parentNodeId"> {
  /** `job` unless said otherwise. A sub-program is delegated the same way (D-P6-03). */
  readonly kind?: "job" | "sub-program";
}

/** What it takes to start a delegated job: the second half. */
export interface StartJobInput
  extends Pick<RunJobInput, "session" | "job" | "route" | "mcp" | "integrate"> {
  /** The node as {@link delegateJob} left it: `queued`. */
  readonly node: ExecutionNode;
  /** P8 (D-P8-06): where to go when the route cannot start. Absent, the job fails. */
  readonly reroute?: Reroute;
  /** P8 (D-P8-13): a fix, carrying what the examiner found into the worker's brief. */
  readonly task?: AgentTask;
  /**
   * P18 (D-P18-05): continue this session rather than start one, with `task`
   * as what it is told: a strand's orchestrator, resumed with its landing's
   * failures to fix.
   */
  readonly resume?: { readonly sessionId: string };
  /** P20: why this attempt is made, when it follows another. Never recorded on the first. */
  readonly causes?: readonly AttemptCause[];
  /** Called once the slot is claimed: the moment the node leaves the queue. Must not throw. */
  readonly claimed?: () => void;
}

export interface StartedJob {
  readonly jobContractId: JobContractId;
  readonly nodeId: ExecutionNodeId;
  readonly agentId: AgentId;
  readonly worktree: string;
  readonly pid: number | undefined;
  /**
   * Settles when the whole lifecycle has finished, whatever the outcome. Never
   * rejects: every failure is a durable status, not an exception. The server
   * keeps it so shutdown can wait for it.
   */
  readonly completion: Promise<void>;
  /**
   * Stops the worker and settles the lifecycle.
   *
   * The mode is the difference between "a human decided to stop this" and "the
   * session ended underneath it", and it is not cosmetic: `cancelled` is
   * terminal, `interrupted` is retryable (`RETRYABLE_STATUSES` in `core`). The
   * adapter is asked to cancel either way — a process does not know why.
   * Idempotent.
   */
  stop(mode: "cancelled" | "interrupted"): Promise<void>;
  /** `stop("cancelled")`, for the `job.cancel` tool. */
  cancel(): Promise<void>;
}

/**
 * A node's own attempts, in order: the routes its work ran on. An examiner's,
 * an answerer's or an arbiter's route (P8) is recorded beside them and is not
 * one of them.
 */
export const attemptsOf = (decisions: readonly RoutingDecision[]): RoutingDecision[] =>
  decisions
    .filter((decision) => decision.purpose === undefined)
    .sort((a, b) => a.attempt - b.attempt);

/**
 * Delegate and start in one step: what P3 did, and what a caller with exactly
 * one job still wants. The engine calls the two halves separately, because
 * between them a node may wait in the queue for as long as it has to (P6,
 * D-P6-02).
 */
export const runJob = async (
  environment: ExecutionEnvironment,
  input: RunJobInput,
): Promise<StartedJob> => {
  const node = await delegateJob(environment, input);
  return startJob(environment, { ...input, node });
};

/**
 * Records a delegation: the Job Contract, then its node, `validated` and then
 * `queued`. Nothing runs, and nothing that could run exists yet: a queued node
 * has no agent, no token and no worktree until it starts.
 */
export const delegateJob = async (
  environment: ExecutionEnvironment,
  input: DelegateJobInput,
): Promise<ExecutionNode> => {
  const { stores, clock, ids, outbox } = environment;
  const { session } = input;
  const nodeId = ids.next("node");

  // --- 1. The Job Contract, before anything exists to execute it (A-03) --------
  await stores.jobContracts.put(input.job);

  // --- 2. The node, validated then queued -------------------------------------
  const at = nowIso(clock);
  const validated: ExecutionNode = {
    schemaVersion: 1,
    ...session.scope,
    executionNodeId: nodeId,
    kind: input.kind ?? "job",
    parentNodeId: input.parentNodeId,
    depth: input.depth,
    status: "validated",
    jobContractId: input.job.jobContractId,
    commitSha: null,
    createdAt: at,
    updatedAt: at,
  };
  await stores.executionNodes.put(validated);
  outbox.emit({
    type: "node.delegated",
    source: "mcp",
    payload: { jobContractId: input.job.jobContractId, objective: input.job.objective },
    executionNodeId: nodeId,
    agentId: session.orchestratorAgentId,
  });

  const queued = transition(validated, "enqueue", nowIso(clock));
  await stores.executionNodes.put(queued);
  outbox.emit({
    type: "node.queued",
    source: "control-plane",
    payload: { jobContractId: input.job.jobContractId },
    executionNodeId: nodeId,
  });
  return queued;
};

/**
 * Starts a queued job: claims its slot, then identity, credential, route,
 * worktree and worker, in that order.
 *
 * Throws `ConcurrencyLimitExceededError` when the API refuses the slot, having
 * written nothing: the node is still `queued`, and "not yet" is the whole of it.
 */
export const startJob = async (
  environment: ExecutionEnvironment,
  input: StartJobInput,
): Promise<StartedJob> => {
  const { stores, clock, ids, outbox } = environment;
  const { session } = input;
  const queued = input.node;
  const nodeId = queued.executionNodeId;
  // A sub-program's node is started the same way as a job's, by the same
  // adapters (D-P6-03). What differs is what its agent is: an orchestrator,
  // with a delegating token, a checkout to read rather than a worktree to
  // change, and nothing to verify or integrate when it ends.
  const orchestrates = queued.kind === "sub-program";
  const role = orchestrates ? "orchestrator" : "worker";

  // --- 2a. The slot, claimed first (D-P6-02) --------------------------------------
  //
  // The record leads the process, as it always has, and it now leads the agent
  // and the worktree too. The API decides whether a slot is free, so this is the
  // one write that can be refused for a reason that is not a failure; making it
  // first means a refusal leaves nothing behind to clean up.
  const started = transition(queued, "start", nowIso(clock));
  await stores.executionNodes.put(started);
  try {
    input.claimed?.();
  } catch {
    // Observation only.
  }
  // The startup interval runs from the slot write (P20), read after the wait it
  // follows has ended so that the wait's end is never later than its start.
  const startupAt = nowIso(clock);
  /** Startup attempts begun and not yet ended, so each ends once. */
  const startupOpen = new Set<number>();
  /** The attempt a failure before its startup began is told as (P20). */
  let startupAttempt = 1;
  const observe = (rest: Omit<LifecycleInput, "scope" | "nodeId">) =>
    observeLifecycle(environment, { scope: session.scope, nodeId, ...rest });
  const beginStartup = (attempt: number, routingDecisionId: string | undefined, at: string) => {
    startupOpen.add(attempt);
    observe({
      operationId: lifecycleOperationId("startup", nodeId, String(attempt)),
      attempt,
      phase: "startup",
      transition: "start",
      occurredAt: at,
      ...(routingDecisionId === undefined
        ? {}
        : { refs: [{ kind: "routing_decision", ref: routingDecisionId }] }),
    });
  };
  const endStartup = (
    attempt: number,
    reason: string,
    extra: Pick<LifecycleInput, "agentId" | "launch" | "recorder"> = {},
  ) => {
    if (!startupOpen.delete(attempt)) return;
    observe({
      operationId: lifecycleOperationId("startup", nodeId, String(attempt)),
      attempt,
      phase: "startup",
      transition: "end",
      reason,
      ...extra,
    });
  };
  /** The attempts of this node whose startup began, so a failure before it began can still be told. */
  const startupBegun = new Set<number>();
  /** The strand this job builds in (P18), once `launch` has read it. */
  let landsOnStrand = false;
  /** A-60: what an earlier run left of this strand, continued here, once `launch` has found it. */
  let strandContinued: StrandContinuation | undefined;

  try {
    return await launch();
  } catch (error) {
    // The launch failed: whatever startup is open ends with why (P20).
    const why = error instanceof Error ? error.message : String(error);
    if (!startupBegun.has(startupAttempt)) beginStartup(startupAttempt, undefined, startupAt);
    for (const attempt of [...startupOpen]) endStartup(attempt, why);
    await failStart(error);
    throw error;
  }

  // Everything after the slot. A throw from here ends the node durably, because
  // it already says `running` and nothing else will ever move it.
  async function launch(): Promise<StartedJob> {
    // --- 3 … 4. The first attempt's identity, credential and route (A-04, A-13) ---
    const earlier = attemptsOf(await stores.routingDecisions.listByNode(session.scope, nodeId));
    startupAttempt = earlier.length + 1;
    const first = await createAttempt(
      input.route,
      earlier.length + 1,
      earlier.at(-1)?.routingDecisionId ?? null,
      input.causes,
    );
    startupBegun.add(first.routingDecision.attempt);
    beginStartup(first.routingDecision.attempt, first.routingDecision.routingDecisionId, startupAt);

    // --- 5. The worktree, cut from the program branch head ------------------------
    // The provisional head once anything has been deferred (D-P7-10), so a
    // dependent builds on the work it depends on rather than on a branch that
    // does not have it yet. A strand's job is cut from its strand's branch
    // instead, and lands back on it (P18, D-P18-03).
    const worktree = environment.paths.worktree(session.scope.runId, nodeId);
    const branch = jobBranch(session.scope.runId, nodeId);
    const strand = await strandOf(environment, session, queued);
    landsOnStrand = strand !== undefined;
    const strandTip =
      strand === undefined
        ? undefined
        : await strandHead(
            environment.git,
            session.repoPath,
            session.scope.runId,
            strand.executionNodeId,
          );
    if (strand !== undefined && strandTip === undefined) {
      throw new Error(`strand ${strand.executionNodeId} has no branch to build on`);
    }
    // A strand's own checkout outlives each of its orchestrator's attempts: its
    // branch holds every job that merged, and a fix round continues there
    // (D-P18-05). Its base is the program head it last took in.
    const strandCheckout =
      orchestrates &&
      existsSync(worktree) &&
      (await strandHead(environment.git, session.repoPath, session.scope.runId, nodeId)) !==
        undefined;
    const base: CommitSha =
      strandTip ??
      (strandCheckout
        ? ((await strandBase(environment.git, session.repoPath, nodeId)) ??
          (
            await effectiveHead(
              environment.git,
              session.repoPath,
              session.program.repository.programBranch,
              session.scope.runId,
            )
          ).head)
        : (
            await effectiveHead(
              environment.git,
              session.repoPath,
              session.program.repository.programBranch,
              session.scope.runId,
            )
          ).head);
    await mkdir(dirname(worktree), { recursive: true });
    await pruneWorktrees(environment.git, session.repoPath);
    let unfinished: Kept | undefined;
    if (earlier.length > 0 && !strandCheckout) {
      // What the last attempt left and never handed in is kept first: a worker
      // that died mid-job did real work, and its worktree is about to go.
      if (!orchestrates) unfinished = await keepUnfinished(worktree, earlier.at(-1)?.attempt ?? 1);
      // The last attempt's worktree was kept for whoever had to read a failure.
      // This attempt starts from the current head, so it goes now, and not before.
      // A worktree that will not go fails this launch with git's reason, rather
      // than leaving its branch for the new worktree to collide with.
      await releaseWorktree(environment, session.repoPath, worktree, branch, nodeId);
      await discardScratch(environment.paths, worktree, environment.reclaim);
      await pruneWorktrees(environment.git, session.repoPath);
    }
    // A strand's orchestrator gets its strand's branch checked out, which its
    // jobs merge onto as they finish (P18, D-P18-03); it reads it, and writes
    // nothing there.
    if (!strandCheckout) {
      await addWorktree(environment.git, { repo: session.repoPath, path: worktree, branch, base });
      // The base, recorded in the repository rather than carried through three
      // processes. `completeJob` reads it back to parent the snapshot; a
      // strand's queue turn reads it as the program head it took in.
      await updateRef(environment.git, session.repoPath, baseRef(nodeId), base);
    }
    // A strand an earlier run of this plan built and never landed is continued
    // from its branch on its first start here, not built again (A-60).
    if (
      orchestrates &&
      !strandCheckout &&
      earlier.length === 0 &&
      input.job.strandId !== undefined
    ) {
      strandContinued = await continueUnfinishedStrand(environment, {
        program: session.program,
        repoPath: session.repoPath,
        runId: session.scope.runId,
        strandId: input.job.strandId,
        strandNodeId: nodeId,
        worktree,
        base,
      });
      if (strandContinued !== undefined) {
        outbox.emit({
          type: "node.progress",
          source: "control-plane",
          payload: {
            message:
              strandContinued.conflict === undefined
                ? `continues run ${strandContinued.fromRunId}'s strand from ${strandContinued.head.slice(0, 12)} (${strandContinued.work.length} commits of work kept)`
                : `could not continue run ${strandContinued.fromRunId}'s strand in place (${strandContinued.conflict}); starts from the program head, told where that work is`,
          },
          executionNodeId: nodeId,
        });
      }
    }
    const carryInto = async (): Promise<CarriedOverWork | undefined> => {
      if (unfinished === undefined) return undefined;
      const { applied, conflicts } = await applyUnfinished(
        environment.git,
        worktree,
        unfinished.work.commit,
        clock.now(),
      );
      return { ...unfinished.carried, applied, conflicts };
    };
    const carriedOver = await carryInto();
    // A new worktree holds only what is committed; the program's setup makes it
    // usable before the agent starts in it. After the carried work, which may
    // change what setup installs.
    const startupOperation = lifecycleOperationId(
      "startup",
      nodeId,
      String(first.routingDecision.attempt),
    );
    const setupOperation = lifecycleOperationId(
      "setup",
      nodeId,
      String(first.routingDecision.attempt),
    );
    const setupSteps = await gateDefinitions(environment, session).then(
      (gates) => gates.setup.length,
      () => undefined,
    );
    observe({
      operationId: setupOperation,
      attempt: first.routingDecision.attempt,
      phase: "setup",
      transition: "start",
      parentOperationId: startupOperation,
    });
    let setupPassed: boolean;
    try {
      setupPassed = await prepareCheckout(environment, {
        session,
        nodeId,
        checkout: worktree,
        purpose: orchestrates ? "orchestrator" : "worker",
      });
    } catch (error) {
      observe({
        operationId: setupOperation,
        attempt: first.routingDecision.attempt,
        phase: "setup",
        transition: "end",
        reason: "failed",
        parentOperationId: startupOperation,
      });
      throw error;
    }
    observe({
      operationId: setupOperation,
      attempt: first.routingDecision.attempt,
      phase: "setup",
      transition: "end",
      reason: setupSteps === 0 ? "none" : setupPassed ? "passed" : "failed",
      parentOperationId: startupOperation,
    });

    // --- 6. Running, before the process exists -----------------------------------
    //
    // The record leads the process, deliberately. The alternative — start, then
    // write `running` — leaves a window in which a worker is working and the
    // control plane says it is merely queued, and a worker fast enough to report
    // inside that window would be refused by the transition table. So the node is
    // `running` and the agent `started` the moment Nightshift commits to starting
    // one, and a launch that then fails is recorded as a failure (below) rather
    // than avoided by writing late. The node took `running` with its slot, above.
    let currentIdentity = first;
    let carried = carriedOver;
    let current = await startAttempt(
      first,
      worktree,
      input.resume === undefined || input.task === undefined
        ? undefined
        : { sessionId: input.resume.sessionId, task: input.task },
      carried,
    );

    outbox.emit({
      type: "node.started",
      source: "control-plane",
      payload: { worktree, branch, base, pid: current.handle.pid ?? null },
      executionNodeId: nodeId,
      agentId: current.agentId,
    });

    let stopMode: "cancelled" | "interrupted" | undefined;

    /**
     * P8 (D-P8-06): the route could not start. The same job, the same node and
     * the same worktree, cleaned back to its base, on the next route the router
     * gives; the node stays `running` throughout, so nobody waiting on it sees a
     * failure that was not the work's. `undefined` when there is nowhere left.
     */
    const relaunch = async (
      failed: RouteTarget,
      stopped: { readonly until?: string; readonly workBegan: boolean; readonly detail?: string },
    ): Promise<Attempt | undefined> => {
      if (input.reroute === undefined || stopMode !== undefined) return undefined;
      const next = input.reroute(failed, stopped.until);
      if (next === undefined) return undefined;
      const last = attemptsOf(await stores.routingDecisions.listByNode(session.scope, nodeId)).at(
        -1,
      );
      const fallbackAt = nowIso(clock);
      const identity = await createAttempt(
        next,
        (last?.attempt ?? 0) + 1,
        last?.routingDecisionId ?? null,
        [
          {
            kind: "route_unavailable",
            ...(last === undefined ? {} : { previousRoutingDecisionId: last.routingDecisionId }),
            ...(stopped.detail === undefined ? {} : { detail: stopped.detail.slice(0, 400) }),
          },
        ],
      );
      startupBegun.add(identity.routingDecision.attempt);
      beginStartup(
        identity.routingDecision.attempt,
        identity.routingDecision.routingDecisionId,
        fallbackAt,
      );
      try {
        // A limit that stopped the route mid-job (D-P8-06, as amended 2026-10-12):
        // what it did so far is kept, and the next route carries on from it.
        if (stopped.workBegan && !orchestrates) {
          unfinished = (await keepUnfinished(worktree, last?.attempt ?? 1)) ?? unfinished;
        }
        await cleanCheckout(environment.git, worktree, base);
        // The clean took the carried work with it; the next route starts from it too.
        carried = await carryInto();
        currentIdentity = identity;
        current = await startAttempt(identity, worktree, undefined, carried);
      } catch (error) {
        endStartup(
          identity.routingDecision.attempt,
          error instanceof Error ? error.message : String(error),
        );
        throw error;
      }
      return current;
    };

    /**
     * The same attempt, its session resumed with a reminder, because it ended its
     * turn without reporting. Same agent, same token, same worktree as it was
     * left: nothing is cleaned, because what it did so far is the work.
     */
    const resumeSession = async (
      sessionId: string,
      reminder: number,
      of: number,
    ): Promise<Attempt | undefined> => {
      if (stopMode !== undefined) return undefined;
      current = await startAttempt(currentIdentity, worktree, {
        sessionId,
        task: { kind: "continue", reminder, of },
      });
      observe({
        operationId: lifecycleOperationId(
          "work",
          nodeId,
          String(currentIdentity.routingDecision.attempt),
        ),
        attempt: currentIdentity.routingDecision.attempt,
        phase: "work",
        transition: "note",
        reason: `resumed: reminder ${reminder} of ${of}`,
        agentId: current.agentId,
        launch: current.launch,
        recorder: current.recorder,
      });
      return current;
    };

    const completion = (orchestrates ? finishSubProgram : finishJob)(environment, {
      session,
      job: input.job,
      nodeId,
      worktree,
      branch,
      base,
      current: () => current,
      stopMode: () => stopMode,
      relaunch,
      resumeSession,
      ...(input.integrate === undefined ? {} : { integrate: input.integrate }),
      ...(strand === undefined
        ? {}
        : {
            strand: {
              nodeId: strand.executionNodeId,
              worktree: environment.paths.worktree(session.scope.runId, strand.executionNodeId),
            },
          }),
    });

    const stop = async (mode: "cancelled" | "interrupted"): Promise<void> => {
      // Set before the cancel, so the lifecycle knows why the process stopped by
      // the time it observes the exit.
      stopMode ??= mode;
      await environment.harness.cancel(
        current.handle,
        millis(environment.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS),
      );
      await completion;
    };

    return {
      jobContractId: input.job.jobContractId,
      nodeId,
      agentId: current.agentId,
      worktree,
      pid: current.handle.pid,
      completion,
      stop,
      cancel: () => stop("cancelled"),
    };
  }

  /**
   * Keeps what the last attempt left in `worktree` without handing it in: a ref
   * holding it as one commit, and a patch beside the worktree. Never stands in
   * the retry's way: when it cannot be kept, the activity says so and the retry
   * starts from the head as it always did.
   */
  async function keepUnfinished(worktree: string, attempt: number): Promise<Kept | undefined> {
    try {
      await access(worktree);
    } catch {
      return undefined; // Somebody tidied it away; nothing is left to keep.
    }
    try {
      const oldBase = await tryRevParse(environment.git, session.repoPath, baseRef(nodeId));
      if (oldBase === undefined) return undefined;
      const work = await collectUnfinished(environment.git, {
        worktree,
        base: oldBase,
        nodeId,
        attempt,
        atMs: clock.now(),
      });
      if (work === undefined) return undefined;
      const ref = unfinishedRef(nodeId, attempt);
      await updateRef(environment.git, session.repoPath, ref, work.commit);
      const patchPath = `${worktree}.attempt-${attempt}.patch`;
      await writeFile(patchPath, await unfinishedPatch(environment.git, session.repoPath, work));
      outbox.emit({
        type: "node.progress",
        source: "control-plane",
        payload: {
          message: `kept attempt ${attempt}'s unfinished work (${work.paths.length} paths) for the retry`,
          ref,
        },
        executionNodeId: nodeId,
      });
      return { work, carried: { fromAttempt: attempt, ref, paths: work.paths, patchPath } };
    } catch (error) {
      outbox.emit({
        type: "node.progress",
        source: "control-plane",
        payload: {
          message: `could not keep attempt ${attempt}'s unfinished work: ${
            error instanceof Error ? error.message : String(error)
          }`,
        },
        executionNodeId: nodeId,
      });
      return undefined;
    }
  }

  /**
   * One attempt's identity (A-04), its credential (D-P4-06) and why it runs
   * where it runs (A-13), in that order and before any process exists.
   */
  async function createAttempt(
    route: RouteChoice,
    attempt: number,
    previousRouteId: RoutingDecision["routingDecisionId"] | null,
    causes?: readonly AttemptCause[],
  ): Promise<AttemptIdentity> {
    const agentId = ids.next("agent");
    const agent: Agent = {
      schemaVersion: 1,
      ...session.scope,
      agentId,
      executionNodeId: nodeId,
      role,
      harness: route.target.harness,
      provider: route.target.provider,
      model: route.target.model,
      status: "created",
      createdAt: nowIso(clock),
    };
    await stores.agents.put(agent);
    outbox.emit({
      type: "agent.created",
      source: "control-plane",
      payload: { role, ...route.target },
      executionNodeId: nodeId,
      agentId,
    });

    // Minted the moment the identity exists, and before anything the worker could
    // act with. Held in this frame and handed to the launch; never stored, never
    // logged, and never in an event payload.
    const minted = await environment.tokens.mint(session.scope, agentId);
    const executionToken = minted.token;
    // On a machine the token goes in a file the worker's server reads on every
    // request, and the engine rewrites it before it expires (P10, T4).
    const executionTokenFile = await environment.workerTokens?.place(
      session.scope,
      agentId,
      executionToken,
    );
    const renewal =
      environment.workerTokens === undefined
        ? undefined
        : startTokenRenewal({
            scope: session.scope,
            agentId,
            minted,
            tokens: environment.tokens,
            files: environment.workerTokens,
            now: () => clock.now(),
            log: (line) =>
              outbox.emit({
                type: "node.progress",
                source: "control-plane",
                payload: { message: line },
                executionNodeId: nodeId,
                agentId,
              }),
          });

    // A retry, or a fallback, is a new attempt at the same node (D-P6-06, D-P8-06):
    // its decision says which it is and links the one before, so the record
    // reads as a chain.
    const routingDecision: RoutingDecision = {
      schemaVersion: 1,
      ...session.scope,
      routingDecisionId: ids.next("route"),
      executionNodeId: nodeId,
      attempt,
      eligibleOptions: [...route.eligibleOptions],
      chosen: route.target,
      ruleId: route.ruleId,
      wasOverride: route.wasOverride,
      usage: {},
      outcome: "pending",
      previousRouteId: attempt === 1 ? null : previousRouteId,
      ...(route.role === undefined ? {} : { role: route.role }),
      ...(route.position === undefined ? {} : { position: route.position }),
      ...(route.classification === undefined ? {} : { classification: route.classification }),
      ...(route.policyVersion === undefined ? {} : { policyVersion: route.policyVersion }),
      // Why this attempt follows another (P20). The first has nothing to follow.
      ...(attempt === 1
        ? {}
        : {
            causes:
              causes === undefined || causes.length === 0
                ? [{ kind: "unknown" as const }]
                : causes.slice(0, 8),
          }),
      createdAt: nowIso(clock),
    };
    const price = session.run.policy?.routingPolicy.prices[route.target.model];
    await stores.routingDecisions.put(routingDecision);
    outbox.emit({
      type: "routing.decided",
      source: "control-plane",
      payload: {
        ruleId: routingDecision.ruleId,
        wasOverride: routingDecision.wasOverride,
        chosen: routingDecision.chosen,
        ...(route.role === undefined ? {} : { role: route.role }),
        ...(route.position === undefined ? {} : { position: route.position }),
        attempt,
      },
      executionNodeId: nodeId,
    });
    const recorder = createMeasurementRecorder(environment, {
      scope: session.scope,
      executionNodeId: nodeId,
      agent,
      route: route.target,
      routingDecisionId: routingDecision.routingDecisionId,
      ...(price === undefined ? {} : { price }),
    });
    return {
      agent,
      recorder,
      executionToken,
      ...(executionTokenFile === undefined ? {} : { executionTokenFile }),
      ...(renewal === undefined ? {} : { renewal }),
      routingDecision,
      work: { ms: 0 },
    };
  }

  /**
   * What an earlier agent of this node had consumed of `sessionId`, from its
   * published summary; undefined when none is found, which the recorder records
   * as an unknown baseline.
   */
  async function earlierSessionBaseline(
    sessionId: string,
    exceptAgentId: string,
  ): Promise<MeasurementCounters | undefined> {
    const earlier = (await stores.agents.listByNode(session.scope, nodeId))
      .filter(
        (candidate) => candidate.sessionId === sessionId && candidate.agentId !== exceptAgentId,
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .at(-1);
    if (earlier === undefined) return undefined;
    const summary = await publishedSummaryFor(stores, session.scope, nodeId, earlier.agentId);
    return summary === undefined ? undefined : baselineFor(summary, sessionId);
  }

  /** The agent started and its process launched, on the worktree already prepared. */
  async function startAttempt(
    identity: AttemptIdentity,
    worktree: string,
    resumed?: { readonly sessionId: string; readonly task: AgentTask },
    carriedOver?: CarriedOverWork,
  ): Promise<Attempt> {
    const { agent, executionToken, routingDecision } = identity;
    const agentId = agent.agentId;
    // A resumed session is the same agent, already started: its record is not
    // moved again, and its earlier segment's transcript is already kept.
    // A new attempt that continues an earlier session (D-P18-05) is a new agent
    // all the same: its record starts here.
    const stored =
      resumed === undefined ? undefined : await stores.agents.get(session.scope, agentId);
    const fresh = resumed === undefined || stored === undefined || stored.status === "created";
    const startedAgent = fresh
      ? transitionAgent(stored ?? agent, "start", { at: nowIso(clock) })
      : stored;
    if (fresh) await stores.agents.put(startedAgent);

    const sink = createHookSink({ outbox, executionNodeId: nodeId, agentId });
    const transcript = environment.paths.transcript(session.scope.runId, agentId);
    await mkdir(dirname(transcript), { recursive: true });

    // One identity, two transports (A-37). The launch is for an adapter that can be
    // handed a process to spawn; the tools are the same four operations as
    // functions, over stores that hold this worker's token and nothing else. Which
    // one a worker's calls arrive through is the adapter's business, and never both.
    const launchIdentity: WorkerLaunchIdentity = {
      projectId: session.scope.projectId,
      programId: session.scope.programId,
      runId: session.scope.runId,
      nodeId,
      agentId,
      jobContractId: input.job.jobContractId,
      worktree,
      role: orchestrates ? "sub-orchestrator" : "worker",
      executionToken,
      ...(identity.executionTokenFile === undefined
        ? {}
        : { executionTokenFile: identity.executionTokenFile }),
    };
    // The function transport is a worker's four operations. A sub-orchestrator's
    // surface is a different one, and it reaches it through its MCP launch, as
    // every local harness does (rule 6).
    const tools = orchestrates
      ? refusingWorkerTools(
          "a sub-program's orchestrator reaches Nightshift through its MCP launch",
        )
      : createWorkerTools(
          environment.workerEnvironment(launchIdentity),
          {
            scope: session.scope,
            executionNodeId: nodeId,
            jobContractId: input.job.jobContractId,
            agentId,
            worktree,
          },
          ids,
        );

    // The worktree is the worker's from here on (D-P10-25): one owner for its
    // whole life, the engine reading but never again writing as itself.
    // Its temp directory too, beside the worktree (scratch.ts).
    const { runAs } = runAsOf(environment, startedAgent);
    const tmpDir = await ensureScratch(environment.paths, worktree);
    if (runAs !== undefined) {
      await runAs.grant(worktree);
      await runAs.grant(tmpDir);
    }
    let handle: HarnessHandle;
    let launchRef: LaunchRef;
    try {
      // Each launch is a measurement segment; a resume continues the same session.
      // Whether a session continues is the resume's doing, not the agent record's:
      // a new agent resuming an earlier agent's session still continues it, and its
      // cumulative counters are measured from where that agent left them.
      const baseline =
        resumed !== undefined && fresh
          ? await earlierSessionBaseline(resumed.sessionId, agentId)
          : undefined;
      const launch = await identity.recorder.startSegment({
        resumedSession: resumed !== undefined,
        ...(resumed === undefined ? {} : { sessionId: resumed.sessionId }),
        ...(baseline === undefined ? {} : { baseline }),
      });
      launchRef = launch;
      handle = await environment.harness.start({
        launch,
        measurements: identity.recorder.sink,
        agent: startedAgent,
        node: started,
        job: input.job,
        program: withGateDefinitions(session.program, await gateDefinitions(environment, session)),
        worktree,
        tmpDir,
        // The program's rulings so far, as memory for the brief (rulings.ts).
        rulings: await programRulings(environment.stores, {
          projectId: session.scope.projectId,
          programId: session.scope.programId,
        }),
        model: routingDecision.chosen,
        mcp: input.mcp(launchIdentity),
        tools,
        sink,
        transcriptPath: transcript,
        ...launchExtras(input.task, resumed, carriedOver),
        ...(landsOnStrand ? { landsOnStrand: true } : {}),
        ...(strandContinued === undefined || resumed !== undefined ? {} : { strandContinued }),
        ...runAsOf(environment, startedAgent),
      });
    } catch (error) {
      // The adapter could not even attempt a launch. The node and agent already
      // exist and already say `running`, so this ends durably rather than leaving
      // them that way forever.
      const reason = `the harness could not start the worker: ${
        error instanceof Error ? error.message : String(error)
      }`;
      if (resumed === undefined || fresh) endStartup(routingDecision.attempt, reason);
      await stores.agents.put(
        transitionAgent(startedAgent, "fail", { at: nowIso(clock), outcomeReason: reason }),
      );
      // The node is ended by `failStart`, like every other failure to launch.
      throw new Error(reason, { cause: error });
    }
    // The token's renewals end with the process; the file goes with them (T4).
    void handle.exit.finally(() => {
      identity.renewal?.stop();
      void environment.workerTokens?.remove(session.scope, agentId);
    });
    identity.startedAtMs ??= clock.now();
    // A new process is the end of startup and the start of work; a resume of a
    // live session is a note on work, told by whoever resumed it (P20).
    if (resumed === undefined || fresh) {
      endStartup(routingDecision.attempt, "process started", {
        agentId,
        launch: launchRef,
        recorder: identity.recorder,
      });
      // The interval opens at the instant the lifecycle says work began.
      const began = observe({
        operationId: lifecycleOperationId("work", nodeId, String(routingDecision.attempt)),
        attempt: routingDecision.attempt,
        phase: "work",
        transition: "start",
        agentId,
        launch: launchRef,
        recorder: identity.recorder,
      });
      identity.work.openedAtMs = instantOf(began, clock.now());
    } else {
      // A resumed segment is a work interval of its own, summed with the others.
      identity.work.openedAtMs = clock.now();
    }
    return {
      agentId,
      handle,
      sink,
      routingDecision,
      recorder: identity.recorder,
      startedAtMs: identity.startedAtMs,
      work: identity.work,
      launch: launchRef,
    };
  }

  /**
   * A launch that failed after the slot was taken: the node ends, durably, and
   * what the launch made goes with it. No agent ran, so the worktree holds
   * nothing to read; the setup's output is already an artifact. A retry then
   * starts from nothing, as a first launch does.
   */
  async function failStart(error: unknown): Promise<void> {
    const reason = error instanceof Error ? error.message : String(error);
    const worktree = environment.paths.worktree(session.scope.runId, nodeId);
    await releaseWorktree(
      environment,
      session.repoPath,
      worktree,
      jobBranch(session.scope.runId, nodeId),
      nodeId,
    )
      .then(() => discardScratch(environment.paths, worktree, environment.reclaim))
      .catch((cleanup: unknown) => {
        // The node still ends; the next launch at this node names the cause.
        console.error(`node ${nodeId}: ${cleanup instanceof Error ? cleanup.message : cleanup}`);
      });
    try {
      const node = await stores.executionNodes.get(session.scope, nodeId);
      if (node === undefined || node.status !== "running") return;
      await stores.executionNodes.put({
        ...transition(node, "fail", nowIso(clock)),
        outcomeReason: reason,
      });
      outbox.emit({
        type: "node.failed",
        source: "control-plane",
        payload: { reason },
        executionNodeId: nodeId,
      });
    } catch {
      // The control plane is unreachable. Shutdown's fallback is what is left.
    }
  }
};

/**
 * A sub-program's orchestrator has stopped (P6, D-P6-03).
 *
 * There is nothing to verify and nothing to integrate: it wrote no code, and
 * whatever is in its checkout is discarded with it. What is left to settle is
 * its node. It ends its own node through `subprogram.complete` or
 * `subprogram.fail`; one that stopped without doing either, or was stopped, is
 * ended here, because a sub-program left `running` with nobody orchestrating it
 * is the state D-P6-08 exists to prevent. Its children are the engine's to stop.
 *
 * Never rejects.
 */
const finishSubProgram = async (
  environment: ExecutionEnvironment,
  input: FinishInput,
): Promise<void> => {
  const { stores, clock, outbox } = environment;
  try {
    const settledExit = await untilReported(environment, input, await input.current().handle.exit);
    const { exit, reason: described } = observed(input, settledExit);
    endWork(environment, input, input.current(), exit.kind);
    // An orchestrator stopped by a limit is not relaunched in place: what it
    // delegated is on the record, and a retry on the next route takes over.
    // Its route is out until the limit resets, and the retry does not climb.
    let reason = described;
    if (exit.kind === "failed" && exit.unavailable !== undefined) {
      environment.routes?.markUnavailable(
        input.current().routingDecision.chosen,
        unavailableUntil(exit, clock),
      );
      reason = `route_unavailable: ${exit.unavailable}`;
    }
    await recordAgentEnd(environment, input, exit, reason);
    await uploadTranscript(environment, input);
    await publishRecorder(input.current());

    const node = await stores.executionNodes.get(input.session.scope, input.nodeId);
    // Completed: the strand lands once, as a job does (P18, D-P18-04). The
    // queue takes its branch at the head the orchestrator completed it on,
    // against the program head it last took in.
    if (
      node !== undefined &&
      node.status === "implemented" &&
      node.commitSha !== null &&
      input.integrate !== undefined
    ) {
      const base =
        (await strandBase(environment.git, input.session.repoPath, input.nodeId)) ?? input.base;
      await input.integrate({
        session: input.session,
        job: input.job,
        nodeId: input.nodeId,
        agentId: input.current().agentId,
        worktree: input.worktree,
        branch: input.branch,
        base,
        attempt: input.current().routingDecision.attempt,
        commitSha: node.commitSha,
      });
      return;
    }
    if (node !== undefined && node.status === "running") {
      const stopped =
        exit.kind === "cancelled" ? "cancel" : exit.kind === "interrupted" ? "interrupt" : "fail";
      const why =
        exit.kind === "completed"
          ? "the sub-program's orchestrator exited without ending its sub-program"
          : reason;
      await stores.executionNodes.put({
        ...transition(node, stopped, nowIso(clock)),
        outcomeReason: why,
      });
      outbox.emit({
        type:
          stopped === "cancel"
            ? "node.cancelled"
            : stopped === "interrupt"
              ? "node.interrupted"
              : "node.failed",
        source: "control-plane",
        payload: { reason: why },
        executionNodeId: input.nodeId,
        agentId: input.current().agentId,
      });
    }
  } catch (error) {
    await failHard(environment, input, error);
  } finally {
    // The strand's checkout and branch hold every job that merged: kept for the
    // next round while the strand may still be fixed (D-P18-05), and for a
    // human after a failure, as a job's worktree is. A landing releases them
    // itself; a cancelled strand has nothing left to keep.
    const ended = await stores.executionNodes
      .get(input.session.scope, input.nodeId)
      .catch(() => undefined);
    if (ended?.status === "cancelled" || ended?.status === "succeeded") {
      await releaseWorktree(
        environment,
        input.session.repoPath,
        input.worktree,
        input.branch,
        input.nodeId,
      ).catch((error: unknown) => {
        console.error(
          `node ${input.nodeId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
      await discardScratch(environment.paths, input.worktree, environment.reclaim);
    }
    await closeRecorder(input.current());
    await recordRouteResult(environment, input);
    // What the strand's decisions produced, now that its work has all landed
    // or stopped (P9, D-P9-01).
    await stampSettledDecisions(environment, input.session, input.nodeId);
  }
};

/**
 * A strand's job, landed on its strand (P18, D-P18-03): its commit merged onto
 * the strand's branch, and the job `merged`. No gate, examination or queue turn
 * of its own; the strand is verified and examined once, whole. A conflict with
 * what merged onto the strand since the job was cut fails it, for its
 * orchestrator to retry from the strand's new head.
 */
const landOnStrand = async (
  environment: ExecutionEnvironment,
  input: FinishInput,
  strand: { readonly nodeId: ExecutionNodeId; readonly worktree: string },
  node: ExecutionNode,
): Promise<void> => {
  const { stores, clock, outbox } = environment;
  const agentId = input.current().agentId;
  if (node.commitSha === null) {
    throw new Error(`node ${input.nodeId} is implemented but carries no commit`);
  }
  const subject = input.job.objective.split("\n")[0]?.trim().slice(0, 120) ?? "";
  const attempt = input.current().routingDecision.attempt;
  const integration = (step: "start" | "end", reason?: string) =>
    observeNode(environment, input, {
      operationId: lifecycleOperationId("integration", input.nodeId, String(attempt)),
      attempt,
      phase: "integration",
      transition: step,
      agentId,
      refs: [{ kind: "commit", ref: node.commitSha as string }],
      ...(reason === undefined ? {} : { reason }),
    });
  integration("start");
  const merged = await mergeInto(environment.git, {
    worktree: strand.worktree,
    commit: node.commitSha,
    message: `Merge job ${input.job.jobContractId}: ${subject}`,
    atMs: clock.now(),
  });
  if (!merged.merged) {
    const where = merged.conflicts.length > 0 ? merged.conflicts.join(", ") : merged.detail;
    const reason =
      `integration_conflict: this job's changes conflict with work merged onto its strand since it started, in ${where}. ` +
      `Nothing was merged. Its worktree is kept at ${input.worktree}; retry it to run it again from the strand's head.`;
    outbox.emit({
      type: "integration.conflict",
      source: "control-plane",
      payload: {
        commitSha: node.commitSha,
        strand: strand.nodeId,
        conflicts: merged.conflicts.slice(0, 50),
      },
      executionNodeId: input.nodeId,
      agentId,
    });
    await stores.executionNodes.put({
      ...transition(node, "fail", nowIso(clock)),
      outcomeReason: reason,
    });
    outbox.emit({
      type: "node.failed",
      source: "control-plane",
      payload: { reason },
      executionNodeId: input.nodeId,
      agentId,
    });
    integration("end", "integration_conflict");
    return;
  }
  await stores.executionNodes.put(transition(node, "merge", nowIso(clock)));
  await strandMoved(
    environment,
    input.session.repoPath,
    input.session.scope.runId,
    strand.nodeId,
    merged.head,
  );
  outbox.emit({
    type: "node.merged",
    source: "control-plane",
    payload: { commitSha: node.commitSha, strand: strand.nodeId, strandHead: merged.head },
    executionNodeId: input.nodeId,
    agentId,
  });
  integration("end", "merged");
  // On its strand's branch now: the job's own worktree has done its work.
  await releaseWorktree(
    environment,
    input.session.repoPath,
    input.worktree,
    input.branch,
    input.nodeId,
  ).catch((error: unknown) => {
    console.error(
      `node ${input.nodeId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
  await discardScratch(environment.paths, input.worktree, environment.reclaim);
};

/**
 * P3's route to the branch: verify the node where it stands, then seal,
 * fast-forward and checkpoint. Correct with one job in flight, because then the
 * base cannot have moved. With several it is the merge queue's job (P6).
 */
export const verifyAndIntegrate = async (
  environment: ExecutionEnvironment,
  candidate: IntegrationCandidate,
): Promise<void> => {
  const node = await environment.stores.executionNodes.get(
    candidate.session.scope,
    candidate.nodeId,
  );
  if (node === undefined || node.status !== "implemented") return;
  const verified = await verifyNode(environment, {
    session: candidate.session,
    node,
    job: candidate.job,
    agentId: candidate.agentId,
    routingDecisionId: candidate.routingDecisionId,
    worktree: candidate.worktree,
  });
  if (!verified.passed) return;
  await integrateNode(environment, {
    session: candidate.session,
    nodeId: candidate.nodeId,
    agentId: candidate.agentId,
    worktree: candidate.worktree,
    branch: candidate.branch,
    base: candidate.base,
    commitSha: verified.commitSha,
  });
};

interface FinishInput {
  readonly session: RunSession;
  readonly job: JobContract;
  readonly nodeId: ExecutionNodeId;
  readonly worktree: string;
  readonly branch: string;
  readonly base: CommitSha;
  /** The attempt now running. A fallback replaces it (D-P8-06). */
  current(): Attempt;
  /** Why we asked the worker to stop, when we did. See `StartedJob.stop`. */
  stopMode(): "cancelled" | "interrupted" | undefined;
  /** Starts the job again on the next route when this one could not start, or says there is none. */
  relaunch(
    failed: RouteTarget,
    stopped: { readonly until?: string; readonly workBegan: boolean; readonly detail?: string },
  ): Promise<Attempt | undefined>;
  /** Resumes the current attempt's session with a reminder to report. */
  resumeSession(sessionId: string, reminder: number, of: number): Promise<Attempt | undefined>;
  readonly integrate?: IntegrateCandidate;
  /** P18 (D-P18-03): the strand this job lands on, instead of the merge queue. */
  readonly strand?: { readonly nodeId: ExecutionNodeId; readonly worktree: string };
}

/**
 * Examination beside the merge queue (P8, D-P8-09, D-P8-13). True when the work
 * may go on to the queue: nothing was required, it cleared, or its checks wait on
 * a human and it is examined at resume. Otherwise the node has been ended here,
 * with the examination's reason, and nothing else sees it.
 */
const examinedBesideQueue = async (
  environment: ExecutionEnvironment,
  input: FinishInput,
  node: ExecutionNode,
): Promise<boolean> => {
  if (node.commitSha === null) return true;
  const outcome = await examine(environment, {
    session: input.session,
    job: input.job,
    node,
    commitSha: node.commitSha,
    base: input.base,
    phase: "candidate",
    stopped: () => input.stopMode() !== undefined,
  });
  switch (outcome.kind) {
    case "not_required":
    case "cleared":
    case "postponed":
      return true;
    case "candidate_failed":
      await endExamined(environment, input, "verification_failed", undefined, outcome.verification);
      return false;
    case "examiner_failed":
      // Examiners were tried and none could review it: on to the queue
      // unreviewed, for a human. An engine that cannot examine at all fails.
      if (outcome.skippable) {
        skipReview(
          environment,
          { node, job: input.job, commitSha: node.commitSha },
          outcome,
          "beside the queue",
        );
        return true;
      }
      await endExamined(environment, input, "fail", outcome.reason);
      return false;
    case "blocked":
    case "upheld":
      await endExamined(environment, input, "fail", outcome.reason);
      return false;
  }
};

/** An implemented node the examination stopped, ended durably (D-P8-13). */
const endExamined = async (
  environment: ExecutionEnvironment,
  input: FinishInput,
  how: "fail" | "verification_failed",
  reason: string | undefined,
  verification?: Verification,
): Promise<void> => {
  const { stores, clock, outbox } = environment;
  const node = await stores.executionNodes.get(input.session.scope, input.nodeId);
  if (node === undefined || node.status !== "implemented") return;
  if (how === "verification_failed" && verification !== undefined) {
    // The check on its own base failed, as it would have in the queue.
    const verifying = transition(node, "begin_verification", nowIso(clock));
    await stores.executionNodes.put(verifying);
    await stores.executionNodes.put(markVerificationFailed(verifying, verification, nowIso(clock)));
    outbox.emit({
      type: "verification.completed",
      source: "control-plane",
      payload: {
        verificationId: verification.verificationId,
        outcome: "failed",
        phase: "candidate",
      },
      executionNodeId: input.nodeId,
      agentId: input.current().agentId,
    });
    return;
  }
  const why = reason ?? "examination_failed";
  await stores.executionNodes.put({
    ...transition(node, "fail", nowIso(clock)),
    outcomeReason: why,
  });
  outbox.emit({
    type: "node.failed",
    source: "control-plane",
    payload: { reason: why },
    executionNodeId: input.nodeId,
    agentId: input.current().agentId,
  });
};

/**
 * The exit of the last attempt, after every fallback (P8, D-P8-06). A route that
 * could not start is not how the job ended: its attempt is recorded
 * `unavailable` and the next route starts on the same node, until one starts or
 * none is left. `recorded` is true when the last attempt's ending is already on
 * the record, because nothing was left to fall back to.
 */
const throughFallbacks = async (
  environment: ExecutionEnvironment,
  input: FinishInput,
): Promise<{ readonly exit: HarnessExit; readonly recorded: boolean }> => {
  let exit = await input.current().handle.exit;
  while (
    exit.kind === "failed" &&
    exit.unavailable !== undefined &&
    input.stopMode() === undefined
  ) {
    const refused = input.current();
    endWork(environment, input, refused, exit.kind);
    await recordAgentEnd(environment, input, exit, `route_unavailable: ${exit.unavailable}`);
    await uploadTranscript(environment, input);
    recordExit(refused, exit);
    await closeRecorder(refused);
    await recordRouteResult(environment, input, "unavailable");
    const until = unavailableUntil(exit, environment.clock);
    const next = await input
      .relaunch(refused.routingDecision.chosen, {
        ...(until === undefined ? {} : { until }),
        workBegan: exit.workBegan === true,
        detail: `route_unavailable: ${exit.unavailable}`,
      })
      .catch(() => undefined);
    if (next === undefined) {
      const unavailable = `${exit.unavailable}; and no other route on the role's list could start`;
      return { exit: { ...exit, unavailable }, recorded: true };
    }
    exit = await next.handle.exit;
  }
  return { exit, recorded: false };
};

/**
 * How many times a session that ended its turn without reporting is resumed
 * before its work is failed as unreported. Two: one to recover a session that
 * stopped to wait for something, one more for good measure. A session that
 * ignores both is not going to report.
 */
export const MAX_UNREPORTED_RESUMES = 2;

/**
 * A session that ended its turn cleanly without reporting, resumed with a
 * reminder until it reports or the reminders run out.
 *
 * Every agent runs headless, so a turn that ends is a process that exits, and
 * nothing wakes it again. A worker that ended its turn to wait for a background
 * command, or that simply stopped, has not failed at its work; it has failed to
 * finish its turn. Its session is kept, so it is resumed where it was, in the
 * worktree as it left it, and told why. Only a clean exit from a session that
 * can be resumed, that nobody asked to stop, on a node still `running`.
 */
const untilReported = async (
  environment: ExecutionEnvironment,
  input: FinishInput,
  first: HarnessExit,
): Promise<HarnessExit> => {
  let exit = first;
  // The attempt this exit belongs to: a resume is the same agent, so the same recorder.
  const attempt = input.current();
  let recorded = false;
  for (let reminder = 1; reminder <= MAX_UNREPORTED_RESUMES; reminder += 1) {
    if (exit.kind !== "completed" || exit.sessionId === undefined) break;
    if (input.stopMode() !== undefined) break;
    const node = await environment.stores.executionNodes.get(input.session.scope, input.nodeId);
    if (node?.status !== "running") break;
    // This segment ends here, recorded once, before any attempt to resume it.
    recordExit(attempt, exit, environment.clock.now());
    recorded = true;
    // This segment's transcript, kept before the resumed session writes the next.
    await uploadTranscript(environment, input);
    environment.outbox.emit({
      type: "node.progress",
      source: "control-plane",
      payload: {
        message: `ended its turn without reporting; resumed with a reminder (${reminder} of ${MAX_UNREPORTED_RESUMES})`,
      },
      executionNodeId: input.nodeId,
      agentId: input.current().agentId,
    });
    const next = await input
      .resumeSession(exit.sessionId, reminder, MAX_UNREPORTED_RESUMES)
      .catch(() => undefined);
    if (next === undefined) break;
    exit = await next.handle.exit;
    recorded = false;
  }
  // The last segment, as the lifecycle will see it (a shutdown's cancel is `interrupted`).
  if (!recorded) recordExit(attempt, observed(input, exit).exit);
  return exit;
};

/** A lifecycle observation about the node a finish is settling. Never throws. */
const observeNode = (
  environment: ExecutionEnvironment,
  input: Pick<FinishInput, "session" | "nodeId">,
  rest: Omit<LifecycleInput, "scope" | "nodeId">,
) => observeLifecycle(environment, { scope: input.session.scope, nodeId: input.nodeId, ...rest });

/** The work interval of `attempt` ends with how its process exited, before its recorder closes. */
const endWork = (
  environment: ExecutionEnvironment,
  input: Pick<FinishInput, "session" | "nodeId">,
  attempt: Attempt,
  kind: HarnessExit["kind"],
): void => {
  const ended = observeNode(environment, input, {
    operationId: lifecycleOperationId(
      "work",
      input.nodeId,
      String(attempt.routingDecision.attempt),
    ),
    attempt: attempt.routingDecision.attempt,
    phase: "work",
    transition: "end",
    reason: kind,
    agentId: attempt.agentId,
    launch: attempt.launch,
    recorder: attempt.recorder,
  });
  closeWork(attempt.work, instantOf(ended, environment.clock.now()));
};

/** An exit onto its attempt's recorder. A measurement failure never changes an outcome. */
const recordExit = (attempt: Attempt, exit: HarnessExit, endsWorkAtMs?: number): void => {
  // A segment that is followed by a resume ends here; the last ends with the work interval.
  if (endsWorkAtMs !== undefined) closeWork(attempt.work, endsWorkAtMs);
  try {
    attempt.recorder.recordExit(exit);
  } catch {
    // The recorder does not throw; this is for the day it does.
  }
};

/** Publishes the attempt's summary as it stands. Never rejects. */
const publishRecorder = async (attempt: Attempt): Promise<void> => {
  try {
    await attempt.recorder.publish();
  } catch {
    // Measurement is observation: the node ends as it ended.
  }
};

/** Drains, publishes and marks the attempt's journals closed. Never rejects. */
const closeRecorder = async (attempt: Attempt): Promise<void> => {
  try {
    await attempt.recorder.close();
  } catch {
    // Measurement is observation: the node ends as it ended.
  }
};

/**
 * Everything after the worker is running: wait for it, record how it ended, and
 * — only if it ended `completed` and reported — verify, seal, integrate,
 * checkpoint.
 *
 * Never rejects. Every path here ends with the node in a durable status, because
 * a lifecycle that threw would leave a `running` node and a process nobody is
 * waiting for, which is precisely the state SC-P3-11 exists to prevent.
 */
const finishJob = async (environment: ExecutionEnvironment, input: FinishInput): Promise<void> => {
  const { stores, clock, outbox } = environment;
  let recorded = false;
  try {
    const fallen = await throughFallbacks(environment, input);
    recorded = fallen.recorded;
    // A last attempt already on the record had no route to start on: nothing to resume.
    const settledExit = recorded
      ? fallen.exit
      : await untilReported(environment, input, fallen.exit);
    const { exit, reason: described } = observed(input, settledExit);
    if (!recorded) endWork(environment, input, input.current(), exit.kind);
    // A route that could not start, and nowhere left to go (D-P8-06): the reason
    // says so, and a retry of it will not climb (`failureClimbs`).
    const reason =
      exit.kind === "failed" && exit.unavailable !== undefined
        ? `route_unavailable: ${exit.unavailable}`
        : described;
    if (!recorded) {
      await recordAgentEnd(environment, input, exit, reason);
      await uploadTranscript(environment, input);
    }
    // The summary is stored before anything examines or lands the work.
    await publishRecorder(input.current());

    const node = await stores.executionNodes.get(input.session.scope, input.nodeId);
    if (node === undefined) return;

    // A worker that did not end cleanly never reaches verification, whatever it
    // may have claimed on the way out.
    if (exit.kind !== "completed") {
      await endUnfinished(environment, input, node, exit, reason);
      return;
    }
    // `completed` but the node never reached `implemented`: the process exited
    // zero without calling `job.complete` or `job.fail`. That is a failure with
    // nothing attached, which is the one outcome nobody can act on, so it is
    // recorded as exactly that.
    if (node.status !== "implemented") {
      if (node.status !== "running") return; // Already terminal: the first outcome wins.
      const reason = "the worker exited 0 without reporting completion";
      await stores.executionNodes.put({
        ...transition(node, "fail", nowIso(clock)),
        outcomeReason: reason,
      });
      outbox.emit({
        type: "node.failed",
        source: "control-plane",
        payload: { reason },
        executionNodeId: input.nodeId,
        agentId: input.current().agentId,
      });
      return;
    }

    // A strand's job lands on its strand, with no gate, examination or queue
    // turn of its own: its strand is verified and examined once, whole (P18).
    if (input.strand !== undefined) {
      await landOnStrand(environment, input, input.strand, node);
      return;
    }

    // P8 (D-P8-09): examined beside the queue, when the run's policy says so,
    // before anything else sees it. A job the examination stops ends here.
    if (!(await examinedBesideQueue(environment, input, node))) return;

    // With several jobs in flight the branch has one door, and it is the
    // engine's merge queue (D-P6-05). Its promise settles when this node is
    // integrated or durably is not, so `completion` still means the whole
    // lifecycle, and the route's result below still sees the final status.
    const candidate: IntegrationCandidate = {
      session: input.session,
      job: input.job,
      nodeId: input.nodeId,
      agentId: input.current().agentId,
      worktree: input.worktree,
      branch: input.branch,
      base: input.base,
      attempt: input.current().routingDecision.attempt,
      routingDecisionId: input.current().routingDecision.routingDecisionId,
      ...(node.commitSha === null ? {} : { commitSha: node.commitSha }),
    };
    if (input.integrate !== undefined) {
      await input.integrate(candidate);
      return;
    }

    await verifyAndIntegrate(environment, candidate);
  } catch (error) {
    // Nothing above should throw, but a bug here must not leave a node running
    // and a promise rejected into the void.
    await failHard(environment, input, error);
  } finally {
    if (!recorded) {
      await closeRecorder(input.current());
      await recordRouteResult(environment, input);
    }
  }
};

/**
 * What the route cost and how it ended, written once the node has settled
 * (D-P5-06, SC-P5-14).
 *
 * The wall clock is Nightshift's own measurement, so every adapter has one; the
 * tokens and cost are the adapter's, where it reports them. One write, because
 * `core` lets `usage` be set once and `outcome` move once. It never throws: a
 * route whose result could not be recorded is still a finished job.
 */
const recordRouteResult = async (
  environment: ExecutionEnvironment,
  input: FinishInput,
  /** P8: `unavailable` for an attempt whose route could not start (D-P8-06). */
  ending?: RouteOutcome,
): Promise<void> => {
  try {
    const attempt = input.current();
    const node = await environment.stores.executionNodes.get(input.session.scope, input.nodeId);
    const outcome = ending ?? routeOutcomeForNodeStatus(node?.status ?? "failed");
    if (outcome === "pending") return;
    // Dollars as the harness reported them, else estimated from the run's price
    // table, and labelled either way (D-P8-08).
    // The aggregate comes from the recorder's summary, so the two agree.
    const prices = input.session.run.policy?.routingPolicy.prices ?? {};
    const summary = attempt.recorder.summary();
    await environment.stores.routingDecisions.put({
      ...attempt.routingDecision,
      usage: labelCost(
        routeUsageFromCounters(summary.totals, {
          ...(summary.valuation.reportedUsd === undefined
            ? {}
            : { reportedUsd: summary.valuation.reportedUsd }),
          wallClockMs: Math.max(0, Math.round(environment.clock.now() - attempt.startedAtMs)),
          agentMs: Math.round(attempt.work.ms),
        }),
        prices[attempt.routingDecision.chosen.model],
      ),
      outcome,
    });
  } catch {
    // The decision stays `pending`, which is what it truthfully is: unrecorded.
  }
};

/** An exit, and the sentence a human reads for it. */
interface Observed {
  readonly exit: HarnessExit;
  readonly reason: string;
}

/**
 * The exit, seen through why we asked for it.
 *
 * A worker stopped because the orchestrator's session ended is `interrupted`,
 * not `cancelled` (contract §4.3, shutdown) — and the distinction is not
 * cosmetic: `interrupted` is retryable, `cancelled` is terminal. The adapter
 * reports `cancelled` either way, because a process cannot know why it was
 * asked to stop, so this is where the difference is applied, along with a reason
 * that says what actually happened rather than naming a signal nobody sent.
 */
const observed = (input: FinishInput, exit: HarnessExit): Observed => {
  if (exit.kind !== "cancelled" || input.stopMode() !== "interrupted") {
    return { exit, reason: describeExit(exit) };
  }
  return {
    exit: { kind: "interrupted", signal: "shutdown" },
    reason: "the worker was interrupted: the orchestrator's session ended while it was running",
  };
};

/** The agent table's event for an ending status. */
const AGENT_EVENT_FOR = {
  completed: "complete",
  failed: "fail",
  cancelled: "cancel",
  interrupted: "interrupt",
} as const;

/** The harness's own session id, from an exit that can carry one. */
const sessionOf = (exit: HarnessExit): string | undefined =>
  exit.kind === "completed" || exit.kind === "failed" ? exit.sessionId : undefined;

const recordAgentEnd = async (
  environment: ExecutionEnvironment,
  input: FinishInput,
  exit: HarnessExit,
  reason: string,
): Promise<void> => {
  const { stores, clock, outbox } = environment;
  const agent = await stores.agents.get(input.session.scope, input.current().agentId);
  if (agent === undefined || agent.status !== "started") return;

  const status = agentStatusForExit(exit);
  const event = AGENT_EVENT_FOR[status as keyof typeof AGENT_EVENT_FOR] ?? "interrupt";
  const ended = transitionAgent(agent, event, {
    at: nowIso(clock),
    ...(status === "completed" ? {} : { outcomeReason: reason }),
    ...(exit.kind === "failed" ? { exitCode: exit.exitCode } : {}),
  });
  // P8 (D-P8-15): the session an examiner's question resumes, where the harness kept one.
  const sessionId = sessionOf(exit);
  await stores.agents.put(sessionId === undefined ? ended : { ...ended, sessionId });
  // The agent *record* is always this layer's to write — only the execution
  // layer may — but the ending *event* belongs to whoever observed it. A
  // well-behaved adapter already emitted one, from the same `hookTypeForExit`
  // mapping and with its own account of the ending in the payload; emitting a
  // second, emptier one is how the exit-gate run ended up with two
  // `agent.completed` events for one agent. So this is a backstop, for the
  // harness that reports nothing at all — which D-P3-09 requires to leave
  // terminal state behind regardless.
  if (!input.current().sink.sawEnding()) {
    outbox.emit({
      type: hookTypeForExit(exit),
      source: "hook",
      payload: {
        ...(exit.kind === "failed" ? { exitCode: exit.exitCode } : {}),
        ...(exit.kind === "interrupted" ? { signal: exit.signal } : {}),
      },
      executionNodeId: input.nodeId,
      agentId: input.current().agentId,
    });
  }
};

/** The transcript, once the process that was writing it has stopped. */
const uploadTranscript = async (
  environment: ExecutionEnvironment,
  input: FinishInput,
): Promise<void> => {
  const path = input.current().handle.transcript;
  if (path === undefined) return;
  const { readFile } = await import("node:fs/promises");
  let bytes: Uint8Array;
  try {
    bytes = await readFile(path);
  } catch {
    // No transcript is not a failure: an adapter need not keep one.
    return;
  }
  if (bytes.byteLength === 0) return;
  await recordArtifact(environment, {
    scope: input.session.scope,
    nodeId: input.nodeId,
    kind: "transcript",
    contentType: "application/x-ndjson",
    bytes,
  });
};

/** The user an agent runs as on a machine (D-P10-25), when the composition names one. */
/**
 * The program's setup and verification steps, run in a checkout as the user
 * the checkout was handed to (D-P10-25): the same `sudo` line the agent's own
 * process runs under. Nothing to wrap when there is no such user.
 */
export const stepsAs = (
  environment: Pick<ExecutionEnvironment, "runAs">,
  agent: { readonly agentId: string; readonly role: string },
): { readonly as?: (invocation: StepInvocation) => StepInvocation } => {
  const runAs = environment.runAs?.(agent);
  if (runAs === undefined) return {};
  return {
    as: (invocation) => {
      const command = commandAs(runAs, invocation.file, invocation.args, invocation.env);
      return { file: command.file, args: command.args, env: command.env };
    },
  };
};

export const runAsOf = (
  environment: Pick<ExecutionEnvironment, "runAs">,
  agent: { readonly agentId: string; readonly role: string },
): { readonly runAs?: RunAs } => {
  const runAs = environment.runAs?.(agent);
  return runAs === undefined ? {} : { runAs };
};

/** Uploads bytes and records the reference, in that order (A-08). */
export const recordArtifact = async (
  environment: Pick<ExecutionEnvironment, "stores" | "bodies" | "clock" | "ids" | "outbox">,
  input: {
    readonly scope: RunSession["scope"];
    readonly nodeId: ExecutionNodeId;
    readonly kind: "transcript" | "verification-log" | "build-log";
    readonly contentType: string;
    readonly bytes: Uint8Array;
  },
): Promise<string> => {
  const artifactId = environment.ids.next("art");
  const stored = await environment.bodies.put(
    input.scope,
    artifactId,
    input.bytes,
    input.contentType,
  );
  await environment.stores.artifacts.put({
    schemaVersion: 1,
    ...input.scope,
    artifactId,
    executionNodeId: input.nodeId,
    kind: input.kind,
    uri: stored.uri,
    sizeBytes: stored.sizeBytes,
    contentType: input.contentType,
    sha256: stored.sha256,
    createdAt: nowIso(environment.clock),
  });
  environment.outbox.emit({
    type: "artifact.recorded",
    source: "control-plane",
    payload: { artifactId, kind: input.kind, sizeBytes: stored.sizeBytes, uri: stored.uri },
    executionNodeId: input.nodeId,
  });
  return artifactId;
};

/**
 * A worker that did not end cleanly.
 *
 * Three shapes, each with its own durable status (contract §4.3): cancelled
 * because we asked, interrupted because a signal killed it, failed because it
 * exited non-zero. On Windows a killed process reports no signal and an exit
 * code, so it lands as `failed` — the proof SC-P3-11 wants is durable state, not
 * the label, and the adapter documents the difference.
 */
const endUnfinished = async (
  environment: ExecutionEnvironment,
  input: FinishInput,
  node: ExecutionNode,
  exit: HarnessExit,
  reason: string,
): Promise<void> => {
  const { stores, clock, outbox } = environment;
  if (node.status !== "running") return; // The worker already reported; first wins.

  const event =
    exit.kind === "cancelled" ? "cancel" : exit.kind === "interrupted" ? "interrupt" : "fail";
  const type =
    exit.kind === "cancelled"
      ? "node.cancelled"
      : exit.kind === "interrupted"
        ? "node.interrupted"
        : "node.failed";

  await stores.executionNodes.put({
    ...transition(node, event, nowIso(clock)),
    outcomeReason: reason,
  });
  outbox.emit({
    type,
    source: "control-plane",
    payload: {
      reason,
      ...(exit.kind === "failed" ? { exitCode: exit.exitCode } : {}),
      ...(exit.kind === "interrupted" ? { signal: exit.signal } : {}),
      // The worktree is kept on every failure path, for inspection.
      worktree: input.worktree,
    },
    executionNodeId: input.nodeId,
    agentId: input.current().agentId,
  });
};

/** Last resort: a defect in the lifecycle itself must still leave durable state. */
const failHard = async (
  environment: ExecutionEnvironment,
  input: FinishInput,
  error: unknown,
): Promise<void> => {
  const reason = `the execution layer failed while finishing the job: ${
    error instanceof Error ? error.message : String(error)
  }`;
  try {
    const node = await environment.stores.executionNodes.get(input.session.scope, input.nodeId);
    if (node === undefined) return;
    if (node.status === "failed" || node.status === "cancelled" || node.status === "integrated") {
      return;
    }
    await environment.stores.executionNodes.put({
      ...transition(node, "fail", nowIso(environment.clock)),
      outcomeReason: reason,
    });
    environment.outbox.emit({
      type: "node.failed",
      source: "control-plane",
      payload: { reason },
      executionNodeId: input.nodeId,
      agentId: input.current().agentId,
    });
  } catch {
    // The control plane is unreachable too. The outbox holds what it can and
    // spills on shutdown; there is nothing further to try here.
  }
};
