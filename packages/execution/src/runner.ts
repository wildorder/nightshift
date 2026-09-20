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

import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  Agent,
  AgentId,
  CommitSha,
  ExecutionNode,
  ExecutionNodeId,
  JobContract,
  JobContractId,
  RouteChoice,
  RouteUsage,
  RoutingDecision,
  Scope,
} from "@nightshift/contracts";
import { nowIso, routeOutcomeForNodeStatus, transition, transitionAgent } from "@nightshift/core";
import {
  agentStatusForExit,
  describeExit,
  type HarnessExit,
  type HarnessHandle,
  hookTypeForExit,
  type McpLaunch,
  millis,
  refusingWorkerTools,
} from "@nightshift/harness";
import {
  DEFAULT_CANCEL_GRACE_MS,
  type ExecutionEnvironment,
  type RunSession,
  type WorkerLaunchIdentity,
} from "./environment.js";
import {
  addDetachedWorktree,
  addWorktree,
  baseRef,
  jobBranch,
  pruneWorktrees,
  removeWorktree,
  revParse,
  updateRef,
} from "./git/index.js";
import { createHookSink, type RecordingHookSink } from "./hook-sink.js";
import { integrateNode } from "./integrate.js";
import { verifyNode } from "./verify.js";
import { createWorkerTools } from "./worker.js";

export interface RunJobInput {
  readonly session: RunSession;
  /** Validated by the caller, not yet persisted. */
  readonly job: JobContract;
  /** The **effective** scope, already narrowed against the parent by `core`. */
  readonly scope: Scope;
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
}

/** Settles when the candidate is integrated, or durably is not. Never rejects. */
export type IntegrateCandidate = (candidate: IntegrationCandidate) => Promise<void>;

/** What it takes to record a delegation: the first half of {@link runJob}. */
export interface DelegateJobInput
  extends Pick<RunJobInput, "session" | "job" | "scope" | "depth" | "parentNodeId"> {
  /** `job` unless said otherwise. A sub-program is delegated the same way (D-P6-03). */
  readonly kind?: "job" | "sub-program";
}

/** What it takes to start a delegated job: the second half. */
export interface StartJobInput
  extends Pick<RunJobInput, "session" | "job" | "route" | "mcp" | "integrate"> {
  /** The node as {@link delegateJob} left it: `queued`. */
  readonly node: ExecutionNode;
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
    scope: input.scope,
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
  const agentId = ids.next("agent");
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
    return await launch();
  } catch (error) {
    await failStart(error);
    throw error;
  }

  // Everything after the slot. A throw from here ends the node durably, because
  // it already says `running` and nothing else will ever move it.
  async function launch(): Promise<StartedJob> {
    // --- 3. The execution identity, before any process exists (A-04) -------------
    const agent: Agent = {
      schemaVersion: 1,
      ...session.scope,
      agentId,
      executionNodeId: nodeId,
      role,
      harness: input.route.target.harness,
      provider: input.route.target.provider,
      model: input.route.target.model,
      status: "created",
      createdAt: nowIso(clock),
    };
    await stores.agents.put(agent);
    outbox.emit({
      type: "agent.created",
      source: "control-plane",
      payload: { role, ...input.route.target },
      executionNodeId: nodeId,
      agentId,
    });

    // --- 3a. Its credential, minted the moment the identity exists (D-P4-06) -----
    //
    // Before the worktree, before the process, and — critically — before anything
    // the worker could act with. A-04 says nothing executes without a Nightshift
    // execution identity; P4 makes that a credential rather than a convention.
    // The token is held in this frame and handed to the launch; it is never
    // stored, never logged, and never reaches an event payload.
    const { token: executionToken } = await environment.tokens.mint(session.scope, agentId);

    // --- 4. Why it runs where it runs (A-13) -------------------------------------
    // A retry is a new attempt at the same node (D-P6-06): its decision says
    // which it is and links the one before, so the record reads as a chain.
    const earlier = [...(await stores.routingDecisions.listByNode(session.scope, nodeId))].sort(
      (a, b) => a.attempt - b.attempt,
    );
    const routingDecision: RoutingDecision = {
      schemaVersion: 1,
      ...session.scope,
      routingDecisionId: ids.next("route"),
      executionNodeId: nodeId,
      attempt: earlier.length + 1,
      eligibleOptions: [...input.route.eligibleOptions],
      chosen: input.route.target,
      ruleId: input.route.ruleId,
      wasOverride: input.route.wasOverride,
      usage: {},
      outcome: "pending",
      previousRouteId: earlier.at(-1)?.routingDecisionId ?? null,
      createdAt: nowIso(clock),
    };
    await stores.routingDecisions.put(routingDecision);
    outbox.emit({
      type: "routing.decided",
      source: "control-plane",
      payload: {
        ruleId: routingDecision.ruleId,
        wasOverride: routingDecision.wasOverride,
        chosen: routingDecision.chosen,
      },
      executionNodeId: nodeId,
    });

    // --- 5. The worktree, cut from the program branch head ------------------------
    const base = await revParse(
      environment.git,
      session.repoPath,
      session.program.repository.programBranch,
    );
    const worktree = environment.paths.worktree(session.scope.runId, nodeId);
    const branch = jobBranch(session.scope.runId, nodeId);
    await mkdir(dirname(worktree), { recursive: true });
    await pruneWorktrees(environment.git, session.repoPath);
    if (earlier.length > 0) {
      // The last attempt's worktree was kept for whoever had to read a failure.
      // This attempt starts clean from the current head, so it goes now, and
      // not before.
      await removeWorktree(environment.git, session.repoPath, worktree, branch, nodeId).catch(
        () => {},
      );
      await pruneWorktrees(environment.git, session.repoPath);
    }
    if (orchestrates) {
      await addDetachedWorktree(environment.git, { repo: session.repoPath, path: worktree, base });
    } else {
      await addWorktree(environment.git, { repo: session.repoPath, path: worktree, branch, base });
    }
    // The base, recorded in the repository rather than carried through three
    // processes. `completeJob` reads it back to parent the snapshot.
    await updateRef(environment.git, session.repoPath, baseRef(nodeId), base);

    // --- 6. Running, before the process exists -----------------------------------
    //
    // The record leads the process, deliberately. The alternative — start, then
    // write `running` — leaves a window in which a worker is working and the
    // control plane says it is merely queued, and a worker fast enough to report
    // inside that window would be refused by the transition table. So the node is
    // `running` and the agent `started` the moment Nightshift commits to starting
    // one, and a launch that then fails is recorded as a failure (below) rather
    // than avoided by writing late. The node took `running` with its slot, above.
    const startedAgent = transitionAgent(agent, "start", { at: nowIso(clock) });
    await stores.agents.put(startedAgent);

    const sink = createHookSink({ outbox, executionNodeId: nodeId, agentId });
    const transcript = environment.paths.transcript(session.scope.runId, agentId);
    await mkdir(dirname(transcript), { recursive: true });

    // One identity, two transports (A-37). The launch is for an adapter that can be
    // handed a process to spawn; the tools are the same four operations as
    // functions, over stores that hold this worker's token and nothing else. Which
    // one a worker's calls arrive through is the adapter's business, and never both.
    const identity: WorkerLaunchIdentity = {
      projectId: session.scope.projectId,
      programId: session.scope.programId,
      runId: session.scope.runId,
      nodeId,
      agentId,
      jobContractId: input.job.jobContractId,
      worktree,
      role: orchestrates ? "sub-orchestrator" : "worker",
      executionToken,
    };
    // The function transport is a worker's four operations. A sub-orchestrator's
    // surface is a different one, and it reaches it through its MCP launch, as
    // every local harness does (rule 6).
    const tools = orchestrates
      ? refusingWorkerTools(
          "a sub-program's orchestrator reaches Nightshift through its MCP launch",
        )
      : createWorkerTools(
          environment.workerEnvironment(identity),
          {
            scope: session.scope,
            executionNodeId: nodeId,
            jobContractId: input.job.jobContractId,
            agentId,
            worktree,
          },
          ids,
        );

    let handle: HarnessHandle;
    try {
      handle = await environment.harness.start({
        agent: startedAgent,
        node: started,
        job: input.job,
        program: session.program,
        worktree,
        model: input.route.target,
        mcp: input.mcp(identity),
        tools,
        sink,
        transcriptPath: transcript,
      });
    } catch (error) {
      // The adapter could not even attempt a launch. The node and agent already
      // exist and already say `running`, so this ends durably rather than leaving
      // them that way forever.
      const reason = `the harness could not start the worker: ${
        error instanceof Error ? error.message : String(error)
      }`;
      await stores.agents.put(
        transitionAgent(startedAgent, "fail", { at: nowIso(clock), outcomeReason: reason }),
      );
      // The node is ended by `failStart`, like every other failure to launch.
      throw new Error(reason, { cause: error });
    }

    outbox.emit({
      type: "node.started",
      source: "control-plane",
      payload: { worktree, branch, base, pid: handle.pid ?? null },
      executionNodeId: nodeId,
      agentId,
    });

    let stopMode: "cancelled" | "interrupted" | undefined;
    const completion = (orchestrates ? finishSubProgram : finishJob)(environment, {
      session,
      job: input.job,
      nodeId,
      agentId,
      worktree,
      branch,
      base,
      handle,
      sink,
      stopMode: () => stopMode,
      routingDecision,
      startedAtMs: clock.now(),
      ...(input.integrate === undefined ? {} : { integrate: input.integrate }),
    });

    const stop = async (mode: "cancelled" | "interrupted"): Promise<void> => {
      // Set before the cancel, so the lifecycle knows why the process stopped by
      // the time it observes the exit.
      stopMode ??= mode;
      await environment.harness.cancel(
        handle,
        millis(environment.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS),
      );
      await completion;
    };

    return {
      jobContractId: input.job.jobContractId,
      nodeId,
      agentId,
      worktree,
      pid: handle.pid,
      completion,
      stop,
      cancel: () => stop("cancelled"),
    };
  }

  /** A launch that failed after the slot was taken: the node ends, durably. */
  async function failStart(error: unknown): Promise<void> {
    const reason = error instanceof Error ? error.message : String(error);
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
  let usage: RouteUsage | undefined;
  try {
    const settledExit = await input.handle.exit;
    if (settledExit.kind === "completed" || settledExit.kind === "failed")
      usage = settledExit.usage;
    const { exit, reason } = observed(input, settledExit);
    await recordAgentEnd(environment, input, exit, reason);
    await uploadTranscript(environment, input);

    const node = await stores.executionNodes.get(input.session.scope, input.nodeId);
    if (node !== undefined && node.status === "running") {
      const stopped = exit.kind === "cancelled" ? "cancel" : "fail";
      const why =
        exit.kind === "completed"
          ? "the sub-program's orchestrator exited without ending its sub-program"
          : reason;
      await stores.executionNodes.put({
        ...transition(node, stopped, nowIso(clock)),
        outcomeReason: why,
      });
      outbox.emit({
        type: stopped === "cancel" ? "node.cancelled" : "node.failed",
        source: "control-plane",
        payload: { reason: why },
        executionNodeId: input.nodeId,
        agentId: input.agentId,
      });
    }
  } catch (error) {
    await failHard(environment, input, error);
  } finally {
    await removeWorktree(
      environment.git,
      input.session.repoPath,
      input.worktree,
      input.branch,
      input.nodeId,
    ).catch(() => {});
    await recordRouteResult(environment, input, usage);
  }
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
  readonly agentId: AgentId;
  readonly worktree: string;
  readonly branch: string;
  readonly base: CommitSha;
  readonly handle: HarnessHandle;
  /** The sink the adapter was given, so the ending is emitted once. */
  readonly sink: RecordingHookSink;
  /** Why we asked the worker to stop, when we did. See `StartedJob.stop`. */
  stopMode(): "cancelled" | "interrupted" | undefined;
  /** As recorded before the work began: `usage` empty, `outcome` pending (A-13). */
  readonly routingDecision: RoutingDecision;
  readonly startedAtMs: number;
  readonly integrate?: IntegrateCandidate;
}

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
  let usage: RouteUsage | undefined;
  try {
    const settledExit = await input.handle.exit;
    if (settledExit.kind === "completed" || settledExit.kind === "failed") {
      usage = settledExit.usage;
    }
    const { exit, reason } = observed(input, settledExit);
    await recordAgentEnd(environment, input, exit, reason);
    await uploadTranscript(environment, input);

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
        agentId: input.agentId,
      });
      return;
    }

    // With several jobs in flight the branch has one door, and it is the
    // engine's merge queue (D-P6-05). Its promise settles when this node is
    // integrated or durably is not, so `completion` still means the whole
    // lifecycle, and the route's result below still sees the final status.
    if (input.integrate !== undefined) {
      await input.integrate({
        session: input.session,
        job: input.job,
        nodeId: input.nodeId,
        agentId: input.agentId,
        worktree: input.worktree,
        branch: input.branch,
        base: input.base,
      });
      return;
    }

    await verifyAndIntegrate(environment, {
      session: input.session,
      job: input.job,
      nodeId: input.nodeId,
      agentId: input.agentId,
      worktree: input.worktree,
      branch: input.branch,
      base: input.base,
    });
  } catch (error) {
    // Nothing above should throw, but a bug here must not leave a node running
    // and a promise rejected into the void.
    await failHard(environment, input, error);
  } finally {
    await recordRouteResult(environment, input, usage);
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
  reported: RouteUsage | undefined,
): Promise<void> => {
  try {
    const node = await environment.stores.executionNodes.get(input.session.scope, input.nodeId);
    const outcome = routeOutcomeForNodeStatus(node?.status ?? "failed");
    if (outcome === "pending") return;
    await environment.stores.routingDecisions.put({
      ...input.routingDecision,
      usage: {
        wallClockMs: Math.max(0, Math.round(environment.clock.now() - input.startedAtMs)),
        ...reported,
      },
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

const recordAgentEnd = async (
  environment: ExecutionEnvironment,
  input: FinishInput,
  exit: HarnessExit,
  reason: string,
): Promise<void> => {
  const { stores, clock, outbox } = environment;
  const agent = await stores.agents.get(input.session.scope, input.agentId);
  if (agent === undefined || agent.status !== "started") return;

  const status = agentStatusForExit(exit);
  const event =
    status === "completed"
      ? "complete"
      : status === "failed"
        ? "fail"
        : status === "cancelled"
          ? "cancel"
          : "interrupt";
  await stores.agents.put(
    transitionAgent(agent, event, {
      at: nowIso(clock),
      ...(status === "completed" ? {} : { outcomeReason: reason }),
      ...(exit.kind === "failed" ? { exitCode: exit.exitCode } : {}),
    }),
  );
  // The agent *record* is always this layer's to write — only the execution
  // layer may — but the ending *event* belongs to whoever observed it. A
  // well-behaved adapter already emitted one, from the same `hookTypeForExit`
  // mapping and with its own account of the ending in the payload; emitting a
  // second, emptier one is how the exit-gate run ended up with two
  // `agent.completed` events for one agent. So this is a backstop, for the
  // harness that reports nothing at all — which D-P3-09 requires to leave
  // terminal state behind regardless.
  if (!input.sink.sawEnding()) {
    outbox.emit({
      type: hookTypeForExit(exit),
      source: "hook",
      payload: {
        ...(exit.kind === "failed" ? { exitCode: exit.exitCode } : {}),
        ...(exit.kind === "interrupted" ? { signal: exit.signal } : {}),
      },
      executionNodeId: input.nodeId,
      agentId: input.agentId,
    });
  }
};

/** The transcript, once the process that was writing it has stopped. */
const uploadTranscript = async (
  environment: ExecutionEnvironment,
  input: FinishInput,
): Promise<void> => {
  const path = input.handle.transcript;
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

/** Uploads bytes and records the reference, in that order (A-08). */
export const recordArtifact = async (
  environment: ExecutionEnvironment,
  input: {
    readonly scope: RunSession["scope"];
    readonly nodeId: ExecutionNodeId;
    readonly kind: "transcript" | "verification-log";
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
    agentId: input.agentId,
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
      agentId: input.agentId,
    });
  } catch {
    // The control plane is unreachable too. The outbox holds what it can and
    // spills on shutdown; there is nothing further to try here.
  }
};
