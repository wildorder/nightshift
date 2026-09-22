/**
 * The merge queue: the one route onto the program branch (P6, D-P6-05, D-P6-06).
 *
 * Workers run in parallel. This does not. Per run there is one serial pipeline,
 * and every node that a worker reports `implemented` goes through it:
 *
 * ```text
 * reconcile (replay onto the current head) → verify there → seal → fast-forward → checkpoint
 * ```
 *
 * ## Why verification lives here
 *
 * Because it is the only place where "the commit that was verified" and "the
 * commit that landed" are the same commit by construction. A job verified on its
 * own stale base and then rebased would be integrating something nobody
 * verified; a job verified here was verified on top of everything that landed
 * before it. Two jobs that are each green alone and broken together therefore
 * cannot both integrate: the second fails verification with the first already
 * underneath it. A job's verification steps are the Program Contract's, so that
 * *is* whole-program verification, on every integration.
 *
 * ## Why this does not touch the transition table
 *
 * Reconciling changes the commit of a node that is `implemented`, which P1
 * allows; it never changes the commit of a verified one, which P1 forbids, and
 * which is exactly the mistake the ordering above makes impossible.
 *
 * ## Order
 *
 * `core`'s `nextToIntegrate`: among the nodes ready *now*, the one delegated
 * first. The queue never waits for unfinished work.
 */
import type { CommitSha, ExecutionNode, ExecutionNodeId } from "@nightshift/contracts";
import { nextToIntegrate, nowIso, transition } from "@nightshift/core";
import type { ExecutionEnvironment } from "./environment.js";
import {
  changedPaths,
  effectiveHead,
  provisionalRef,
  replayCommit,
  updateRef,
} from "./git/index.js";
import { integrateNode } from "./integrate.js";
import type { IntegrateCandidate, IntegrationCandidate } from "./runner.js";
import { checkChangedPaths, describeScopeViolation } from "./scope-check.js";
import { verifyNode } from "./verify.js";

export interface MergeQueue {
  /** Hand a finished worker's node to the queue. Settles when it has been dealt with. */
  readonly integrate: IntegrateCandidate;
  /** What the pipeline is doing, for `program.status`. */
  activity(): {
    readonly integrating: ExecutionNodeId | undefined;
    readonly waiting: readonly ExecutionNodeId[];
  };
  /** Settles when the pipeline is idle. */
  idle(): Promise<void>;
}

interface Waiting {
  readonly candidate: IntegrationCandidate;
  readonly done: () => void;
}

export const createMergeQueue = (environment: ExecutionEnvironment): MergeQueue => {
  const { stores, clock, outbox, git: runner } = environment;
  const waiting = new Map<ExecutionNodeId, Waiting>();
  let current: ExecutionNodeId | undefined;
  let running: Promise<void> | undefined;

  const run = (): Promise<void> => {
    running ??= (async () => {
      while (waiting.size > 0) await processNext();
    })().finally(() => {
      running = undefined;
      // Anything that arrived as the loop was ending.
      if (waiting.size > 0) void run();
    });
    return running;
  };

  /**
   * The stored nodes of everything waiting, not the candidates: a node cancelled
   * while it waited is no longer `implemented`, and is let go rather than
   * integrated.
   *
   * Reading them takes time, and a candidate that arrives meanwhile was ready
   * "now" too. So the read repeats until nothing new arrived during it: the order
   * must be a function of what is ready, not of which request the control plane
   * happened to answer first.
   */
  const readyNodes = async (): Promise<ExecutionNode[]> => {
    let stored: ExecutionNode[] = [];
    let seen = new Set<ExecutionNodeId>();
    do {
      seen = new Set(waiting.keys());
      stored = [];
      for (const nodeId of seen) {
        const node = await readIfReady(nodeId);
        if (node !== undefined) stored.push(node);
      }
    } while ([...waiting.keys()].some((nodeId) => !seen.has(nodeId)));
    return stored;
  };

  const readIfReady = async (nodeId: ExecutionNodeId): Promise<ExecutionNode | undefined> => {
    const entry = waiting.get(nodeId);
    if (entry === undefined) return undefined;
    const node = await stores.executionNodes
      .get(entry.candidate.session.scope, nodeId)
      .catch(() => undefined);
    if (node?.status === "implemented") return node;
    waiting.delete(nodeId);
    entry.done();
    return undefined;
  };

  const processNext = async (): Promise<void> => {
    const next = nextToIntegrate(await readyNodes());
    if (next === undefined) return;

    const entry = waiting.get(next.executionNodeId);
    if (entry === undefined) return;
    waiting.delete(next.executionNodeId);
    current = next.executionNodeId;
    try {
      await integrateOne(entry.candidate, next);
    } catch (error) {
      await failNode(entry.candidate, `the merge queue failed: ${messageOf(error)}`).catch(
        () => {},
      );
    } finally {
      current = undefined;
      entry.done();
    }
  };

  const integrateOne = async (
    candidate: IntegrationCandidate,
    implemented: ExecutionNode,
  ): Promise<void> => {
    const repo = candidate.session.repoPath;
    const runId = candidate.session.scope.runId;
    // The provisional head once anything has been deferred (D-P7-10): later work
    // is cut from it and lands on it, and none of it reaches the program branch.
    const { head, provisional } = await effectiveHead(
      runner,
      repo,
      candidate.session.program.repository.programBranch,
      runId,
    );
    const node =
      head === candidate.base ? implemented : await reconcile(candidate, implemented, head);
    if (node === undefined) return;

    const verified = await verifyNode(environment, {
      session: candidate.session,
      node,
      job: candidate.job,
      agentId: candidate.agentId,
      worktree: candidate.worktree,
      onProvisionalLine: provisional,
    });
    if (!verified.passed) {
      if (verified.deferred !== undefined) {
        await landProvisionally(
          candidate,
          verified.deferred.commitSha,
          verified.deferred.waitingOn,
        );
      }
      return;
    }

    await integrateNode(environment, {
      session: candidate.session,
      nodeId: candidate.nodeId,
      agentId: candidate.agentId,
      worktree: candidate.worktree,
      branch: candidate.branch,
      // The head it was reconciled onto and verified on. If something outside
      // Nightshift moves the branch between here and the fast-forward, the
      // refusal is P3's `stale_base`, durably: a verified commit is never moved.
      base: head,
      commitSha: verified.commitSha,
    });
  };

  /** The node on its replayed commit, or `undefined` when it conflicted and failed. */
  /**
   * The provisional line takes the commit, through this same queue and in the
   * same order, so it is a line: each commit's parent is the one before it. The
   * program branch is not touched. The worktree is kept, because `nightshift
   * resume` verifies this commit again, in full, before it may land.
   */
  const landProvisionally = async (
    candidate: IntegrationCandidate,
    commitSha: CommitSha,
    waitingOn: readonly string[],
  ): Promise<void> => {
    const ref = provisionalRef(candidate.session.scope.runId);
    await updateRef(runner, candidate.session.repoPath, ref, commitSha);
    outbox.emit({
      type: "node.deferred",
      source: "control-plane",
      payload: { commitSha, provisionalRef: ref, waitingOn },
      executionNodeId: candidate.nodeId,
      agentId: candidate.agentId,
    });
  };

  const reconcile = async (
    candidate: IntegrationCandidate,
    node: ExecutionNode,
    head: CommitSha,
  ): Promise<ExecutionNode | undefined> => {
    const from = node.commitSha;
    if (from === null) {
      await failNode(candidate, "the node is implemented but carries no commit");
      return undefined;
    }

    const replayed = await replayCommit(runner, {
      worktree: candidate.worktree,
      commit: from,
      onto: head,
      atMs: clock.now(),
    });
    if (!replayed.ok) {
      const paths = replayed.conflicts.length > 0 ? replayed.conflicts.join(", ") : replayed.detail;
      outbox.emit({
        type: "integration.conflict",
        source: "control-plane",
        payload: { commitSha: from, onto: head, conflicts: replayed.conflicts.slice(0, 50) },
        executionNodeId: candidate.nodeId,
        agentId: candidate.agentId,
      });
      await failNode(
        candidate,
        `integration_conflict: this job's changes conflict with work integrated since it started, in ${paths}. ` +
          `Nothing was integrated and nothing was resolved. Its worktree is kept at ${candidate.worktree}; ` +
          "retry it to run it again from the current head.",
      );
      return undefined;
    }

    // The same check `completeJob` made, on the commit that would now land.
    const paths = await changedPaths(runner, candidate.worktree, head, replayed.commitSha);
    const check = checkChangedPaths(node.scope, paths);
    if (!check.allowed) {
      await failNode(candidate, describeScopeViolation(check.offending));
      return undefined;
    }

    const rebased: ExecutionNode = {
      ...node,
      commitSha: replayed.commitSha,
      updatedAt: nowIso(clock),
    };
    await stores.executionNodes.put(rebased);
    outbox.emit({
      type: "node.rebased",
      source: "control-plane",
      payload: { from, onto: head, staleBase: candidate.base, commitSha: replayed.commitSha },
      executionNodeId: candidate.nodeId,
      agentId: candidate.agentId,
    });
    return rebased;
  };

  const failNode = async (candidate: IntegrationCandidate, reason: string): Promise<void> => {
    const node = await stores.executionNodes.get(candidate.session.scope, candidate.nodeId);
    if (node === undefined || node.status !== "implemented") return;
    await stores.executionNodes.put({
      ...transition(node, "fail", nowIso(clock)),
      outcomeReason: reason,
    });
    outbox.emit({
      type: "node.failed",
      source: "control-plane",
      payload: { reason },
      executionNodeId: candidate.nodeId,
      agentId: candidate.agentId,
    });
  };

  return {
    integrate: (candidate) =>
      new Promise<void>((resolve) => {
        waiting.set(candidate.nodeId, { candidate, done: resolve });
        void run();
      }),
    activity: () => ({ integrating: current, waiting: [...waiting.keys()] }),
    idle: async () => {
      while (running !== undefined) await running;
    },
  };
};

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
