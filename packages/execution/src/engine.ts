/**
 * The engine: one per run, and the only thing that starts work (P6, D-P6-01).
 *
 * P3 started a worker inside `delegate` and refused a second. From P6 a
 * delegation is a **record** (a Job Contract and a `queued` node) and this is
 * what turns records into work: it starts a queued node when its parent has a
 * free slot, keeps every running job's handle, and hands each finished worker's
 * node to the one route onto the program branch.
 *
 * ## What it decides, and what it does not
 *
 * It decides *when*. Whether a delegation is legal was decided before it was
 * recorded (`core`'s `checkAuthority`, and the API again on the write). Whether a
 * slot is free is `core`'s `maySlotStart`, asked here to avoid a pointless
 * request and **decided by the API** on the `queued → running` write, so a bug
 * here cannot exceed a program's limit. A refusal there is "not yet": the node
 * stays queued and is tried again when anything settles.
 *
 * ## One pump at a time
 *
 * Scheduling is a single loop that re-runs when asked while running, never two
 * loops: two passes reading the same tree would both see the same free slot.
 */
import type {
  ExecutionNode,
  ExecutionNodeId,
  JobContract,
  JobContractId,
  RouteChoice,
  Scope,
} from "@nightshift/contracts";
import {
  buildTree,
  ConcurrencyLimitExceededError,
  descendantsOf,
  type ExecutionTree,
  isSettled,
  maySlotStart,
  nowIso,
  RETRYABLE_STATUSES,
  transition,
} from "@nightshift/core";
import type { McpLaunch } from "@nightshift/harness";
import type { ExecutionEnvironment, RunSession, WorkerLaunchIdentity } from "./environment.js";
import { createMergeQueue, type MergeQueue } from "./merge-queue.js";
import { delegateJob, type StartedJob, startJob } from "./runner.js";

export interface EngineOptions {
  readonly environment: ExecutionEnvironment;
  readonly session: RunSession;
  /** Builds a worker's MCP server launch, given the identity it must carry. */
  readonly mcp: (identity: WorkerLaunchIdentity) => McpLaunch;
  /** The run's merge queue. One is made when none is given; a test gives its own. */
  readonly mergeQueue?: MergeQueue;
  /**
   * Routes a node the engine did not delegate itself: one a sub-program's
   * orchestrator wrote through the control plane (D-P6-01). Routing is not this
   * package's, so it is handed in. Without it such a node fails, with the reason.
   */
  readonly route?: (job: JobContract) => RouteChoice;
  /** How often the run's nodes are read while a sub-orchestrator is running. */
  readonly discoveryIntervalMs?: number;
}

/** A second, which is D-P6-01's stated cost of having no second channel. */
export const DEFAULT_DISCOVERY_INTERVAL_MS = 1_000;

export interface Submission {
  /** Validated by the caller, not yet persisted. */
  readonly job: JobContract;
  /** The effective scope, already narrowed against the parent by `core`. */
  readonly scope: Scope;
  readonly depth: number;
  readonly parentNodeId: ExecutionNodeId;
  readonly route: RouteChoice;
  /** `job` unless said otherwise (D-P6-03). */
  readonly kind?: "job" | "sub-program";
}

export interface Submitted {
  readonly jobContractId: JobContractId;
  readonly nodeId: ExecutionNodeId;
  /** `running` when a slot was free at once; `queued` when it has to wait. */
  readonly status: "queued" | "running";
  /** The started job, when it started at once. */
  readonly started?: StartedJob;
}

/** Why a queued node is not running yet. For `job.get`, and for a human. */
export type WaitingReason =
  | { readonly kind: "parent_full"; readonly running: number; readonly maxConcurrency: number }
  | { readonly kind: "wall_clock_spent"; readonly maxWallClockSeconds: number };

export interface EngineSnapshot {
  readonly running: readonly ExecutionNodeId[];
  /** In the order they will be tried, which is the order they were delegated. */
  readonly queued: readonly ExecutionNodeId[];
  readonly wallClockRemainingSeconds: number | undefined;
  /** What the merge queue is doing. */
  readonly integrating: ExecutionNodeId | undefined;
  readonly awaitingIntegration: readonly ExecutionNodeId[];
}

export interface Engine {
  /** Records a delegation and starts it if a slot is free. */
  submit(submission: Submission): Promise<Submitted>;
  /** The running job for a Job Contract, if this engine started it and it has not ended. */
  running(jobContractId: JobContractId): StartedJob | undefined;
  /** Why a job this engine queued is still waiting, if it is. */
  waiting(jobContractId: JobContractId): WaitingReason | undefined;
  /** Stops a running job, or withdraws a queued one. False when it holds neither. */
  cancel(jobContractId: JobContractId): Promise<boolean>;
  /**
   * Requeues a node that ended `failed`, `verification_failed` or `interrupted`
   * as a new attempt (D-P6-06): fresh worktree from the current head, new agent,
   * new routing decision. False when this engine does not hold the job or the
   * node is not retryable.
   */
  retry(jobContractId: JobContractId): Promise<boolean>;
  /** True when nothing is running and nothing is queued. */
  idle(): boolean;
  snapshot(): EngineSnapshot;
  /** Every running job, for shutdown. */
  jobs(): readonly StartedJob[];
  /**
   * Stops scheduling and withdraws everything queued, each node durably
   * `cancelled`. Running jobs are the caller's to stop (`shutdown` does, within
   * one grace period); this only guarantees nothing new starts.
   */
  close(reason: string): Promise<readonly ExecutionNodeId[]>;
  /** Settles when the pump is idle. For tests, and for nothing else. */
  settled(): Promise<void>;
  /** One discovery pass, now. The timer calls it; a test may. */
  discover(): Promise<void>;
}

interface Pending {
  readonly submission: Submission;
  readonly node: ExecutionNode;
  waiting: WaitingReason | undefined;
}

export const createEngine = (options: EngineOptions): Engine => {
  const { environment, session } = options;
  const { stores, clock, outbox } = environment;
  const limits = session.program.delegationLimits;
  const maxWallClockSeconds = session.program.costPolicy.maxWallClockSeconds;

  const pending: Pending[] = [];
  const submissions = new Map<JobContractId, Submission>();
  const active = new Map<ExecutionNodeId, StartedJob>();
  const nodeOfJob = new Map<JobContractId, ExecutionNodeId>();
  let closed = false;

  // --- The route onto the branch: one per run, and it is here (D-P6-05) -------------
  const queue = options.mergeQueue ?? createMergeQueue(environment);
  const integrate = queue.integrate;

  // --- The wall clock (D-P6-07) ------------------------------------------------------
  const wallClockRemainingSeconds = (): number | undefined => {
    if (maxWallClockSeconds === undefined) return undefined;
    const spent = (clock.now() - Date.parse(session.run.startedAt)) / 1000;
    return Math.max(0, Math.floor(maxWallClockSeconds - spent));
  };

  const readNodes = async (): Promise<ExecutionNode[]> => {
    const nodes: ExecutionNode[] = [];
    let cursor: string | undefined;
    do {
      const page = await stores.executionNodes.listByRun(
        session.scope,
        cursor === undefined ? {} : { cursor },
      );
      nodes.push(...page.items);
      cursor = page.cursor;
    } while (cursor !== undefined);
    return nodes;
  };

  // --- The pump ------------------------------------------------------------------------
  let pumping: Promise<void> | undefined;
  let again = false;

  const pump = (): Promise<void> => {
    if (pumping !== undefined) {
      again = true;
      return pumping;
    }
    pumping = (async () => {
      do {
        again = false;
        // A start changes the tree, so each pass starts at most one node and the
        // loop re-reads. Passes are cheap; a stale tree is how a limit is missed.
        while (await startNext()) {
          // Keep going while there is something to start.
        }
      } while (again);
    })()
      .catch(() => {
        // The control plane was unreachable. Whatever settles next pumps again.
      })
      .finally(() => {
        pumping = undefined;
      });
    return pumping;
  };

  /** Starts the first queued node that may start. False when none could. */
  const startNext = async (): Promise<boolean> => {
    if (closed || pending.length === 0) return false;

    const remaining = wallClockRemainingSeconds();
    if (remaining !== undefined && remaining <= 0 && maxWallClockSeconds !== undefined) {
      for (const entry of pending)
        entry.waiting = { kind: "wall_clock_spent", maxWallClockSeconds };
      return false;
    }

    const tree = buildTree(await readNodes());
    for (const entry of [...pending]) {
      if (mayStartNow(tree, entry) && (await start(entry))) return true;
    }
    return false;
  };

  /** Whether `entry` has a free slot in `tree`. Records why not, or drops it if withdrawn. */
  const mayStartNow = (tree: ExecutionTree, entry: Pending): boolean => {
    const id = entry.node.executionNodeId;
    if (tree.nodes.get(id)?.status !== "queued") {
      // Withdrawn by somebody else: cancelled through the control plane.
      remove(entry);
      return false;
    }
    const slot = maySlotStart(tree, id, limits);
    if (slot.free) return true;
    entry.waiting = {
      kind: "parent_full",
      running: slot.running,
      maxConcurrency: slot.maxConcurrency,
    };
    return false;
  };

  const remove = (entry: Pending): void => {
    const index = pending.indexOf(entry);
    if (index >= 0) pending.splice(index, 1);
  };

  const start = async (entry: Pending): Promise<boolean> => {
    try {
      const started = await startJob(environment, {
        session,
        job: entry.submission.job,
        node: entry.node,
        route: entry.submission.route,
        mcp: options.mcp,
        integrate,
      });
      remove(entry);
      active.set(started.nodeId, started);
      const orchestrates = entry.node.kind === "sub-program";
      if (orchestrates) orchestrators.add(started.nodeId);
      watch();
      void started.completion
        .catch(() => {})
        .then(async () => {
          // An orchestrator that has gone leaves nobody to answer for what it
          // delegated: whatever is still in flight under it stops (D-P6-08).
          if (orchestrates) await cancelSubtree(started.nodeId).catch(() => {});
        })
        .finally(() => {
          active.delete(started.nodeId);
          orchestrators.delete(started.nodeId);
          void pump();
        });
      return true;
    } catch (error) {
      if (error instanceof ConcurrencyLimitExceededError) {
        // The API's answer, and it outranks ours. Not yet.
        entry.waiting = {
          kind: "parent_full",
          running: error.running,
          maxConcurrency: error.maxConcurrency,
        };
        return false;
      }
      // A launch that failed has already ended its node durably (`startJob`).
      remove(entry);
      return true;
    }
  };

  // --- Discovery: what a sub-program's orchestrator asked for (D-P6-01) ----------------
  //
  // A sub-orchestrator has no channel to this process. It writes records with its
  // delegating token, and this reads them: a `validated` node nobody here holds
  // is a delegation, a `queued` one is a retry, and a node this engine is running
  // that the record says is `cancelled` is a request to stop. Only while an
  // orchestrator is running, because nothing else writes such records.
  const orchestrators = new Set<ExecutionNodeId>();
  let watching: ReturnType<typeof setTimeout> | undefined;

  const watch = (): void => {
    if (watching !== undefined || closed || orchestrators.size === 0) return;
    watching = setTimeout(() => {
      watching = undefined;
      void discover()
        .catch(() => {})
        .finally(watch);
    }, options.discoveryIntervalMs ?? DEFAULT_DISCOVERY_INTERVAL_MS);
    watching.unref?.();
  };

  const held = (nodeId: ExecutionNodeId): boolean =>
    active.has(nodeId) || pending.some((entry) => entry.node.executionNodeId === nodeId);

  const discover = async (): Promise<void> => {
    if (closed) return;
    let found = false;
    for (const node of await readNodes()) found = (await consider(node)) || found;
    if (found) await pump();
  };

  /** What one stored node asks of the engine, if anything. True when it was adopted. */
  const consider = async (node: ExecutionNode): Promise<boolean> => {
    const id = node.executionNodeId;
    if (node.status === "cancelled") {
      void active
        .get(id)
        ?.cancel()
        .catch(() => {});
      return false;
    }
    if (node.parentNodeId === null || held(id)) return false;
    return node.status === "validated" || node.status === "queued" ? adopt(node) : false;
  };

  /** Takes on a node somebody else delegated. False when it could not be. */
  const adopt = async (node: ExecutionNode): Promise<boolean> => {
    const id = node.executionNodeId;
    const job =
      node.jobContractId === null
        ? undefined
        : await stores.jobContracts.get(session.scope, node.jobContractId);
    if (job === undefined) {
      await refuse(node, "this node was delegated without a Job Contract the engine can read");
      return false;
    }
    let route: RouteChoice;
    try {
      if (options.route === undefined) throw new Error("this engine was given no way to route it");
      route = options.route(job);
    } catch (error) {
      await refuse(node, `the delegation could not be routed: ${messageOf(error)}`);
      return false;
    }

    let queued = node;
    if (node.status === "validated") {
      queued = transition(node, "enqueue", nowIso(clock));
      await stores.executionNodes.put(queued);
      outbox.emit({
        type: "node.queued",
        source: "control-plane",
        payload: { jobContractId: job.jobContractId, delegatedBy: node.parentNodeId },
        executionNodeId: id,
      });
    }
    const submission: Submission = {
      job,
      scope: node.scope,
      depth: node.depth,
      parentNodeId: node.parentNodeId as ExecutionNodeId,
      route,
      kind: node.kind === "sub-program" ? "sub-program" : "job",
    };
    submissions.set(job.jobContractId, submission);
    nodeOfJob.set(job.jobContractId, id);
    pending.push({ submission, node: queued, waiting: undefined });
    return true;
  };

  const refuse = async (node: ExecutionNode, reason: string): Promise<void> => {
    await stores.executionNodes.put({
      ...transition(node, "cancel", nowIso(clock)),
      outcomeReason: reason,
    });
    outbox.emit({
      type: "node.cancelled",
      source: "control-plane",
      payload: { reason },
      executionNodeId: node.executionNodeId,
    });
  };

  /** Stops everything in flight under `nodeId`: running jobs, queued ones, and records. */
  const cancelSubtree = async (nodeId: ExecutionNodeId): Promise<void> => {
    const tree = buildTree(await readNodes());
    if (!tree.nodes.has(nodeId)) return;
    const reason = `its sub-program ${nodeId} ended`;
    for (const id of descendantsOf(tree, nodeId)) {
      const running = active.get(id);
      if (running !== undefined) {
        await running.cancel().catch(() => {});
        continue;
      }
      const entry = pending.find((candidate) => candidate.node.executionNodeId === id);
      if (entry !== undefined) {
        await withdraw(entry, reason).catch(() => {});
        continue;
      }
      const node = tree.nodes.get(id);
      if (node !== undefined && !isSettled(node.status) && node.status !== "implemented") {
        await refuse(node, reason).catch(() => {});
      }
    }
  };

  const withdraw = async (entry: Pending, reason: string): Promise<void> => {
    remove(entry);
    const node = await stores.executionNodes.get(session.scope, entry.node.executionNodeId);
    if (node === undefined || isSettled(node.status)) return;
    await stores.executionNodes.put({
      ...transition(node, "cancel", nowIso(clock)),
      outcomeReason: reason,
    });
    outbox.emit({
      type: "node.cancelled",
      source: "control-plane",
      payload: { reason },
      executionNodeId: node.executionNodeId,
    });
  };

  return {
    submit: async (submission) => {
      if (closed) throw new Error("this run's engine has stopped and takes no more work");
      const node = await delegateJob(environment, {
        session,
        job: submission.job,
        scope: submission.scope,
        depth: submission.depth,
        parentNodeId: submission.parentNodeId,
        ...(submission.kind === undefined ? {} : { kind: submission.kind }),
      });
      const entry: Pending = { submission, node, waiting: undefined };
      pending.push(entry);
      submissions.set(submission.job.jobContractId, submission);
      nodeOfJob.set(submission.job.jobContractId, node.executionNodeId);
      await pump();
      const started = active.get(node.executionNodeId);
      return {
        jobContractId: submission.job.jobContractId,
        nodeId: node.executionNodeId,
        status: started === undefined ? "queued" : "running",
        ...(started === undefined ? {} : { started }),
      };
    },

    running: (jobContractId) => {
      const nodeId = nodeOfJob.get(jobContractId);
      return nodeId === undefined ? undefined : active.get(nodeId);
    },

    waiting: (jobContractId) =>
      pending.find((entry) => entry.submission.job.jobContractId === jobContractId)?.waiting,

    cancel: async (jobContractId) => {
      const nodeId = nodeOfJob.get(jobContractId);
      if (nodeId === undefined) return false;
      const started = active.get(nodeId);
      if (started !== undefined) {
        // A sub-program's subtree goes with it (D-P6-08).
        if (orchestrators.has(nodeId)) await cancelSubtree(nodeId).catch(() => {});
        await started.cancel();
        return true;
      }
      const entry = pending.find((candidate) => candidate.node.executionNodeId === nodeId);
      if (entry === undefined) return false;
      await withdraw(entry, "cancelled before it started");
      return true;
    },

    retry: async (jobContractId) => {
      const submission = submissions.get(jobContractId);
      const nodeId = nodeOfJob.get(jobContractId);
      if (closed || submission === undefined || nodeId === undefined) return false;
      if (active.has(nodeId) || pending.some((entry) => entry.node.executionNodeId === nodeId)) {
        return false;
      }
      const node = await stores.executionNodes.get(session.scope, nodeId);
      if (node === undefined || !RETRYABLE_STATUSES.includes(node.status)) return false;

      // The table's own edge. Why the last attempt ended stays on the record of
      // that attempt: its events and its routing decision.
      const { outcomeReason: _previous, ...rest } = transition(node, "retry", nowIso(clock));
      const requeued: ExecutionNode = { ...rest, commitSha: null };
      await stores.executionNodes.put(requeued);
      outbox.emit({
        type: "node.queued",
        source: "control-plane",
        payload: { jobContractId, retryOf: node.status },
        executionNodeId: nodeId,
      });
      pending.push({ submission, node: requeued, waiting: undefined });
      await pump();
      return true;
    },

    idle: () => active.size === 0 && pending.length === 0,

    snapshot: () => ({
      running: [...active.keys()],
      queued: pending.map((entry) => entry.node.executionNodeId),
      wallClockRemainingSeconds: wallClockRemainingSeconds(),
      integrating: queue.activity().integrating,
      awaitingIntegration: queue.activity().waiting,
    }),

    jobs: () => [...active.values()],

    close: async (reason) => {
      closed = true;
      if (watching !== undefined) clearTimeout(watching);
      watching = undefined;
      const withdrawn: ExecutionNodeId[] = [];
      for (const entry of [...pending]) {
        withdrawn.push(entry.node.executionNodeId);
        await withdraw(entry, reason).catch(() => {});
      }
      return withdrawn;
    },

    settled: async () => {
      while (pumping !== undefined) await pumping;
    },

    discover,
  };
};

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
