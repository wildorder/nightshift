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
import type {
  CommitSha,
  ExecutionNode,
  ExecutionNodeId,
  Verification,
} from "@nightshift/contracts";
import { lifecycleOperationId } from "@nightshift/contracts";
import { nextToIntegrate, nowIso, transition } from "@nightshift/core";
import type { ExecutionEnvironment } from "./environment.js";
import { examineInQueue, recordRulingLanded } from "./examine.js";
import { effectiveHead, replayCommit } from "./git/index.js";
import { integrateNode } from "./integrate.js";
import { type LifecycleInput, observeLifecycle } from "./lifecycle.js";
import type { EventOutbox } from "./outbox.js";
import type { IntegrateCandidate, IntegrationCandidate } from "./runner.js";
import { mergeHeadIntoStrand } from "./strand.js";
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
  /**
   * Runs `task` between landings, never during one, and holds the next landing
   * until it has finished: for work in the program checkout that must not race
   * a fast-forward there (P15, D-P15-11: the setup reference at a run's start).
   */
  exclusive<T>(task: () => Promise<T>): Promise<T>;
}

interface Waiting {
  readonly candidate: IntegrationCandidate;
  readonly done: () => void;
  /** The node integrating when this one last learned who is ahead of it (P20). */
  predecessor: ExecutionNodeId | undefined;
}

/** What an integration says about itself while it runs, and how it ended (P20). */
interface Trace {
  readonly note: (
    reason: string,
    refs?: readonly { readonly kind: string; readonly ref: string }[],
  ) => void;
  /** The reconcile found a conflict with the head. */
  conflicted: boolean;
}

/** The outbox, told apart only by remembering that a review was skipped (P20). */
const watchingSkips = (outbox: EventOutbox): { outbox: EventOutbox; skipped: () => boolean } => {
  let skipped = false;
  return {
    skipped: () => skipped,
    outbox: {
      emit: (input) => {
        if (input.type === "examination.skipped") skipped = true;
        return outbox.emit(input);
      },
      flush: (deadlineMs) => outbox.flush(deadlineMs),
      spill: (path) => outbox.spill(path),
      replay: (path) => outbox.replay(path),
      get pending() {
        return outbox.pending;
      },
      get delivered() {
        return outbox.delivered;
      },
    },
  };
};

/** Durable stages owned by the queue, including a landing whose acknowledgement was lost. */
export const RECOVERABLE_CANDIDATE_STATUSES = new Set([
  "implemented",
  "verifying",
  "verified",
  "examining",
  "sealed",
  "integrated",
]);

export const createMergeQueue = (environment: ExecutionEnvironment): MergeQueue => {
  const { stores, clock, outbox, git: runner } = environment;
  const waiting = new Map<ExecutionNodeId, Waiting>();
  let current: ExecutionNodeId | undefined;
  let running: Promise<void> | undefined;
  // One landing or one exclusive task at a time, in the order they asked.
  let tail: Promise<unknown> = Promise.resolve();
  const serially = <T>(task: () => Promise<T>): Promise<T> => {
    const result = tail.then(task);
    tail = result.catch(() => undefined);
    return result;
  };

  // --- Lifecycle observations (P20): the queue turn and the integration ------------------
  const observe = (
    candidate: IntegrationCandidate,
    phase: "queue" | "integration",
    rest: Pick<LifecycleInput, "transition" | "reason" | "blockers" | "refs">,
  ): void => {
    observeLifecycle(environment, {
      scope: candidate.session.scope,
      nodeId: candidate.nodeId,
      agentId: candidate.agentId,
      operationId: lifecycleOperationId(phase, candidate.nodeId, String(candidate.attempt)),
      attempt: candidate.attempt,
      phase,
      ...rest,
    });
  };
  const commitRefs = (candidate: IntegrationCandidate, commit = candidate.commitSha) =>
    commit === undefined ? [] : [{ kind: "commit", ref: commit }];

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
    if (node !== undefined && RECOVERABLE_CANDIDATE_STATUSES.has(node.status)) return node;
    waiting.delete(nodeId);
    observe(entry.candidate, "queue", {
      transition: "end",
      reason: `let go: ${node?.status ?? "missing"}`,
    });
    entry.done();
    return undefined;
  };

  const processNext = async (): Promise<void> => {
    const nodes = await readyNodes();
    // Keep core's delegation order; these later stages were already selected
    // by this queue before the process died, so finish them first.
    const next =
      nodes
        .filter((node) => node.status !== "implemented")
        .sort((a, b) => a.executionNodeId.localeCompare(b.executionNodeId))[0] ??
      nextToIntegrate(nodes);
    if (next === undefined) return;

    const entry = waiting.get(next.executionNodeId);
    if (entry === undefined) return;
    waiting.delete(next.executionNodeId);
    current = next.executionNodeId;
    observe(entry.candidate, "queue", { transition: "end", reason: "integrating" });
    // Whoever still waits has a new predecessor.
    for (const other of waiting.values()) {
      if (other.predecessor === next.executionNodeId) continue;
      other.predecessor = next.executionNodeId;
      observe(other.candidate, "queue", {
        transition: "note",
        reason: `waiting behind ${next.executionNodeId}`,
        blockers: [{ kind: "queue_predecessor", ref: next.executionNodeId }],
      });
    }
    try {
      await serially(() => integrateOne(entry.candidate, next));
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
    observe(candidate, "integration", {
      transition: "start",
      refs: commitRefs(candidate, implemented.commitSha ?? candidate.commitSha),
      ...(candidate.origin === undefined ? {} : { reason: candidate.origin }),
    });
    const trace: Trace = {
      conflicted: false,
      note: (reason, refs) =>
        observe(candidate, "integration", {
          transition: "note",
          reason,
          ...(refs === undefined ? {} : { refs }),
        }),
    };
    let ended: string;
    try {
      ended = await integrateBody(candidate, implemented, trace);
    } catch (error) {
      observe(candidate, "integration", { transition: "end", reason: "failed" });
      throw error;
    }
    observe(candidate, "integration", { transition: "end", reason: ended });
  };

  /** Lands the candidate, or says why not, as the reason its integration ends with. */
  const integrateBody = async (
    candidate: IntegrationCandidate,
    implemented: ExecutionNode,
    trace: Trace,
  ): Promise<string> => {
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
    if (["verified", "examining", "sealed", "integrated"].includes(implemented.status)) {
      const verification = (
        await stores.verifications.listByNode(candidate.session.scope, candidate.nodeId)
      )
        .filter(
          (record) =>
            record.commitSha === implemented.commitSha &&
            record.outcome === "passed" &&
            record.phase !== "candidate",
        )
        .sort((a, b) => a.endedAt.localeCompare(b.endedAt))
        .at(-1);
      if (verification === undefined || implemented.commitSha === null) {
        throw new Error(
          "recovery_missing_evidence: no passing queue verification for the recorded commit",
        );
      }
      if (implemented.status === "sealed" || implemented.status === "integrated") {
        const landed = await integrateNode(environment, {
          ...candidate,
          commitSha: implemented.commitSha,
        });
        return landed.kind === "integrated" ? "integrated" : "failed";
      }
      return examineAndLand(candidate, candidate.base, implemented.commitSha, verification, trace);
    }
    if (implemented.status === "verifying" && head !== candidate.base) {
      // There is no evidence yet. Keep its commit, and use the table's retry
      // edges to reconcile and check it against the new head without a worker.
      let restarted = transition(implemented, "interrupt", nowIso(clock));
      await stores.executionNodes.put(restarted);
      restarted = transition(restarted, "retry", nowIso(clock));
      await stores.executionNodes.put(restarted);
      restarted = transition(restarted, "start", nowIso(clock));
      await stores.executionNodes.put(restarted);
      restarted = transition(restarted, "report_implemented", nowIso(clock));
      await stores.executionNodes.put(restarted);
      implemented = restarted;
    }
    const node =
      head === candidate.base ? implemented : await reconcile(candidate, implemented, head, trace);
    if (node === undefined) return trace.conflicted ? "integration_conflict" : "failed";

    const verified = await verifyNode(environment, {
      session: candidate.session,
      node,
      job: candidate.job,
      agentId: candidate.agentId,
      worktree: candidate.worktree,
      onProvisionalLine: provisional,
    });
    trace.note(
      `verification: ${verified.passed ? "passed" : verified.deferred !== undefined ? "deferred" : "failed"}`,
      verified.verification === undefined
        ? []
        : [{ kind: "verification", ref: verified.verification.verificationId }],
    );
    // A deferred node is on the provisional line already: verification put it
    // there before it said `deferred` (provisional-line.ts).
    if (!verified.passed)
      return verified.deferred !== undefined ? "deferred" : "verification_failed";

    return examineAndLand(candidate, head, verified.commitSha, verified.verification, trace);
  };

  /**
   * The examination of this exact change, carried over or made here when the
   * replay changed it or none was made (P8, D-P8-09); then seal, fast-forward,
   * checkpoint. An arbiter's ruling that let it land gets its rollback point on
   * both sides.
   */
  const examineAndLand = async (
    candidate: IntegrationCandidate,
    head: CommitSha,
    commitSha: CommitSha,
    verification: Verification,
    trace: Trace,
  ): Promise<string> => {
    const verifiedNode = await stores.executionNodes.get(candidate.session.scope, candidate.nodeId);
    if (verifiedNode === undefined) return "failed";
    const before = new Set(
      (
        await stores.examinations
          .listByNode(candidate.session.scope, candidate.nodeId)
          .catch(() => [])
      ).map((examination) => examination.examinationId),
    );
    const watched = watchingSkips(outbox);
    const gate = await examineInQueue(
      { ...environment, outbox: watched.outbox },
      {
        session: candidate.session,
        job: candidate.job,
        node: verifiedNode,
        commitSha,
        base: head,
        verification,
      },
    );
    if (gate.kind === "stopped") {
      const stopping = [
        ...(await stores.examinations
          .listByNode(candidate.session.scope, candidate.nodeId)
          .catch(() => [])),
      ]
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .at(-1);
      trace.note(
        "examination: stopped",
        stopping === undefined ? [] : [{ kind: "examination", ref: stopping.examinationId }],
      );
      return "examination_stopped";
    }
    if (gate.examination !== undefined) {
      trace.note(
        before.has(gate.examination.examinationId)
          ? "examination: carried"
          : "examination: cleared",
        [{ kind: "examination", ref: gate.examination.examinationId }],
      );
    } else if (
      watched.skipped() ||
      environment.skippedReviews?.get(candidate.nodeId) !== undefined
    ) {
      trace.note("examination: skipped");
    }

    const result = await integrateNode(environment, {
      session: candidate.session,
      nodeId: candidate.nodeId,
      agentId: candidate.agentId,
      worktree: candidate.worktree,
      branch: candidate.branch,
      // The head it was reconciled onto and verified on. If something outside
      // Nightshift moves the branch between here and the fast-forward, the
      // refusal is P3's `stale_base`, durably: a verified commit is never moved.
      base: head,
      commitSha,
      ...(gate.examination === undefined ? {} : { examination: gate.examination }),
    });
    if (result.kind === "integrated" && gate.examination !== undefined) {
      await recordRulingLanded(
        environment,
        candidate.session.scope,
        gate.examination,
        result.checkpointId,
      );
    }
    return result.kind === "integrated" ? "integrated" : "failed";
  };

  /** The node on its replayed commit, or `undefined` when it conflicted and failed. */
  const reconcile = async (
    candidate: IntegrationCandidate,
    node: ExecutionNode,
    head: CommitSha,
    trace: Trace,
  ): Promise<ExecutionNode | undefined> => {
    const from = node.commitSha;
    if (from === null) {
      await failNode(candidate, "the node is implemented but carries no commit");
      return undefined;
    }

    // A strand is many commits, one per job: the program head is merged into
    // its branch rather than the strand replayed onto it, so each job's commit
    // stays in the history (P18, D-P18-04).
    const replayed =
      node.kind === "sub-program"
        ? await mergeHeadIntoStrand(environment, {
            repo: candidate.session.repoPath,
            worktree: candidate.worktree,
            runId: candidate.session.scope.runId,
            strandNodeId: candidate.nodeId,
            head,
          }).then((merged) =>
            merged.merged
              ? { ok: true as const, commitSha: merged.head }
              : { ok: false as const, conflicts: merged.conflicts, detail: merged.detail },
          )
        : await replayCommit(runner, {
            worktree: candidate.worktree,
            commit: from,
            onto: head,
            atMs: clock.now(),
          });
    trace.note(replayed.ok ? "reconciled" : "conflict", [
      { kind: "commit", ref: from },
      { kind: "commit", ref: head },
    ]);
    if (!replayed.ok) {
      trace.conflicted = true;
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
    if (
      node === undefined ||
      !RECOVERABLE_CANDIDATE_STATUSES.has(node.status) ||
      node.status === "integrated"
    )
      return;
    const event =
      node.status === "implemented"
        ? "fail"
        : node.status === "verifying" || node.status === "examining"
          ? "interrupt"
          : "cancel";
    await stores.executionNodes.put({
      ...transition(node, event, nowIso(clock)),
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
        const predecessor = current !== candidate.nodeId ? current : undefined;
        waiting.set(candidate.nodeId, { candidate, done: resolve, predecessor });
        observe(candidate, "queue", {
          transition: "start",
          refs: commitRefs(candidate),
          ...(candidate.origin === undefined ? {} : { reason: candidate.origin }),
          ...(predecessor === undefined
            ? {}
            : { blockers: [{ kind: "queue_predecessor", ref: predecessor }] }),
        });
        void run();
      }),
    activity: () => ({ integrating: current, waiting: [...waiting.keys()] }),
    idle: async () => {
      while (running !== undefined) await running;
    },
    exclusive: (task) => serially(task),
  };
};

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
