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
import {
  type CommitSha,
  type Effort,
  type Examination,
  type ExecutionNode,
  type ExecutionNodeId,
  isOpenMaterialFinding,
  type JobContract,
  type JobContractId,
  type RouteChoice,
  type RouteTarget,
  type RouteUsage,
  type Scope,
  type Tier,
} from "@nightshift/contracts";
import {
  blockedBy,
  budgetSpent,
  buildTree,
  ConcurrencyLimitExceededError,
  descendantsOf,
  type ExecutionTree,
  failureClimbs,
  isDoneForNow,
  isPlanned,
  isSettled,
  markImplemented,
  maySlotStart,
  nowIso,
  RETRYABLE_STATUSES,
  type Spend,
  type StrandOutcomes,
  spendOf,
  strandAttempts,
  strandOutcomes,
  strandsOf,
  strandWaitingFor,
  transition,
} from "@nightshift/core";
import type { AgentTask, McpLaunch } from "@nightshift/harness";
import type { ExecutionEnvironment, RunSession, WorkerLaunchIdentity } from "./environment.js";
import { arbitrateAll, fixOf, latestExamination } from "./examine.js";
import { baseRef, git, jobBranch, revParse } from "./git/index.js";
import { createMergeQueue, type MergeQueue } from "./merge-queue.js";
import { attemptsOf, delegateJob, type StartedJob, startJob } from "./runner.js";

export interface EngineOptions {
  readonly environment: ExecutionEnvironment;
  readonly session: RunSession;
  /** Builds a worker's MCP server launch, given the identity it must carry. */
  readonly mcp: (identity: WorkerLaunchIdentity) => McpLaunch;
  /** The run's merge queue. One is made when none is given; a test gives its own. */
  readonly mergeQueue?: MergeQueue;
  /**
   * The router (P8). Routing is not this package's, so it is handed in. It
   * routes a node the engine did not delegate itself (D-P6-01), a retry, which
   * climbs or keeps its route by why the last attempt ended (D-P8-07), and a
   * fallback when a route could not start (D-P8-06). Without it a discovered
   * node fails with the reason, a retry keeps its route, and nothing falls back.
   */
  readonly route?: (job: JobContract, context: RouteContext) => RouteChoice;
  /** How often the run's nodes are read while a sub-orchestrator is running. */
  readonly discoveryIntervalMs?: number;
}

/** What the router is told beyond the job itself (P8). Structural, so this package names no router. */
export interface RouteContext {
  /** What the delegator pinned (D-P8-05). */
  readonly pins?: RoutePins | undefined;
  /** The attempt a retry replaces, and whether its ending says anything about the model (D-P8-07). */
  readonly previous?:
    | {
        readonly target: RouteTarget;
        readonly ladder?: string | undefined;
        readonly rungIndex?: number | undefined;
        readonly climb: boolean;
      }
    | undefined;
  /** Routes found unable to start in this run (D-P8-06). */
  readonly unavailable: readonly Pick<RouteTarget, "harness" | "model">[];
}

/** The pins a delegation may carry (D-P8-05). */
export interface RoutePins {
  readonly ladder?: string | undefined;
  readonly tier?: Tier | undefined;
  readonly harness?: string | undefined;
  readonly model?: string | undefined;
  readonly effort?: Effort | undefined;
}

/**
 * A retry the fix limit refuses (D-P8-13): two fixes of blocking findings were
 * tried, or an arbiter upheld one. The work does not climb again on it.
 */
export class FixLimitError extends Error {
  override readonly name = "FixLimitError";
}

/** A strand in a parked strand's cone. It is not started, and delegating it again is refused. */
export class StrandBlockedError extends Error {
  override readonly name = "StrandBlockedError";

  constructor(
    readonly strandId: string,
    readonly blockers: readonly string[],
  ) {
    super(
      `strand ${strandId} is blocked by ${blockers.join(", ")}, which did not succeed; ` +
        "it is parked with everything downstream of it",
    );
  }
}

/** A submission that names a strand wrongly: unknown, not top-level, or already in hand. */
export class StrandDelegationError extends Error {
  override readonly name = "StrandDelegationError";
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
  /** What the delegator pinned, kept so a retry and a fallback honour it too (D-P8-05). */
  readonly pins?: RoutePins | undefined;
  /** P8 (D-P8-13): a fix of blocking findings, carried into the worker's brief. */
  readonly task?: AgentTask | undefined;
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
  /** A strand held until the strands it depends on have succeeded (P7, D-P7-04). */
  | { readonly kind: "strands"; readonly waitingFor: readonly string[] }
  | { readonly kind: "wall_clock_spent"; readonly maxWallClockSeconds: number }
  /** P8 (D-P8-08): the run has spent its dollars or its tokens. Nothing new starts. */
  | {
      readonly kind: "budget_spent";
      readonly budget: "maxUsd" | "maxTokens";
      readonly limit: number;
      readonly spent: number;
      readonly estimated: boolean;
    };

/** What an arbiter made of a dispute (D-P8-13). */
export type DisputeResult =
  | { readonly kind: "overturned"; readonly nodeId: ExecutionNodeId }
  | { readonly kind: "upheld"; readonly reason: string }
  | { readonly kind: "refused"; readonly reason: string };

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
  /**
   * Sends the open material findings of a job's last examination to an arbiter
   * (P8, D-P8-13), for a job the examination stopped. When every one is
   * overturned, the work that was examined goes to the merge queue as it is: it
   * is not built again. `reason` is the dispute, as the orchestrator put it.
   */
  dispute(jobContractId: JobContractId, reason: string): Promise<DisputeResult>;
  /** True when nothing is running and nothing is queued. */
  idle(): boolean;
  /**
   * Lets go of processes whose **node has already settled**: each gets `graceMs`
   * to exit by itself and is then stopped.
   *
   * A harness process outlives its node's ending by however long its model takes
   * to say goodbye. Found by the first real sub-orchestrator, which called
   * `subprogram.complete`, was recorded `succeeded`, and was still composing its
   * closing message when its parent tried to finish the run. The record says the
   * work is over; this makes the process agree, without ever stopping one whose
   * node is still in flight.
   */
  releaseSettled(graceMs: number): Promise<void>;
  snapshot(): EngineSnapshot;
  /** Every running job, for shutdown. */
  jobs(): readonly StartedJob[];
  /**
   * Stops scheduling and withdraws everything queued, each node durably
   * `cancelled`. Running jobs are the caller's to stop (`shutdown` does, within
   * one grace period); this only guarantees nothing new starts.
   */
  close(reason: string): Promise<readonly ExecutionNodeId[]>;
  /**
   * Where every strand of a planned run stands, from the run's own records.
   * Empty for a run with no plan. A strand nobody has delegated is absent.
   */
  strands(): Promise<StrandOutcomes>;
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
  const departures = new Map<ExecutionNodeId, Promise<void>>();
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

  /** True when the run's wall clock is spent, which every queued node is then told. */
  const wallClockSpent = (): boolean => {
    const remaining = wallClockRemainingSeconds();
    if (remaining === undefined || remaining > 0 || maxWallClockSeconds === undefined) return false;
    for (const entry of pending) entry.waiting = { kind: "wall_clock_spent", maxWallClockSeconds };
    return true;
  };

  // --- Dollars and tokens (P8, D-P8-08) ------------------------------------------------
  //
  // What the run has spent is read from its routing decisions, never kept in
  // memory, so an engine that attaches to a run under way agrees with the one that
  // started it. Read when the engine first pumps and whenever an attempt settles,
  // and only when the program sets a budget at all.
  const costPolicy = session.program.costPolicy;
  const budgeted = costPolicy.maxUsd !== undefined || costPolicy.maxTokens !== undefined;
  let spend: Spend | undefined;
  let budgetAnnounced = false;

  const readSpend = async (): Promise<Spend> => {
    const usages: RouteUsage[] = [];
    for (const node of await readNodes()) {
      for (const decision of await stores.routingDecisions.listByNode(
        session.scope,
        node.executionNodeId,
      )) {
        usages.push(decision.usage);
      }
    }
    return spendOf(usages);
  };

  /** True when a budget is spent, which every queued node is then told, once on the record. */
  const budgetExhausted = async (): Promise<boolean> => {
    if (!budgeted) return false;
    spend ??= await readSpend();
    const spent = budgetSpent(spend, costPolicy);
    if (spent === undefined) return false;
    const reason: WaitingReason = { kind: "budget_spent", ...spent, estimated: spend.estimated };
    for (const entry of pending) entry.waiting = reason;
    if (!budgetAnnounced) {
      budgetAnnounced = true;
      outbox.emit({
        type: "run.budget_spent",
        source: "control-plane",
        payload: { ...spent, estimated: spend.estimated },
        executionNodeId: session.rootNodeId,
      });
    }
    return true;
  };

  // --- Fallback (P8, D-P8-06) ------------------------------------------------------------
  //
  // A route that could not start is skipped for the rest of the run, by every job.
  const unavailable: Pick<RouteTarget, "harness" | "model">[] = [];

  const rerouteFor =
    (submission: Submission) =>
    (failed: RouteTarget): RouteChoice | undefined => {
      if (
        !unavailable.some(
          (route) => route.harness === failed.harness && route.model === failed.model,
        )
      ) {
        unavailable.push({ harness: failed.harness, model: failed.model });
      }
      if (options.route === undefined) return undefined;
      try {
        return options.route(submission.job, {
          pins: submission.pins,
          unavailable: [...unavailable],
        });
      } catch {
        return undefined;
      }
    };

  /** True when nothing may start at all: closed, idle, or out of time or money. */
  const holding = async (): Promise<boolean> =>
    closed || pending.length === 0 || wallClockSpent() || (await budgetExhausted());

  /** Starts the first queued node that may start. False when none could. */
  const startNext = async (): Promise<boolean> => {
    if (await holding()) return false;

    const nodes = await readNodes();
    const tree = buildTree(nodes);
    const outcomes = planned ? await readStrandOutcomes(nodes) : {};
    for (const entry of [...pending]) {
      const free = !heldByStrands(entry, outcomes) && mayStartNow(tree, entry);
      if (free && (await start(entry))) return true;
    }
    return false;
  };

  // --- Strands: the plan's seams, gated and parked (P7, D-P7-04, §4.4) ---------------
  //
  // A strand is a sub-program directly under the program node whose Job Contract
  // names it. Where every strand stands is read from the run's records each time,
  // never remembered, so an engine that attaches to a run already under way
  // gates exactly as the one that started it did.
  const planned = isPlanned(session.program);
  const announced = new Set<string>();

  const readStrandOutcomes = async (nodes: readonly ExecutionNode[]): Promise<StrandOutcomes> => {
    const strandOfJob = new Map<JobContractId, string>();
    let cursor: string | undefined;
    do {
      const page = await stores.jobContracts.listByRun(
        session.scope,
        cursor === undefined ? {} : { cursor },
      );
      for (const job of page.items) {
        if (job.strandId !== undefined) strandOfJob.set(job.jobContractId, job.strandId);
      }
      cursor = page.cursor;
    } while (cursor !== undefined);
    return strandOutcomes(strandAttempts(nodes, strandOfJob));
  };

  /** True while a strand's dependencies have not all succeeded. Records what it waits for. */
  const heldByStrands = (entry: Pending, outcomes: StrandOutcomes): boolean => {
    const strandId = entry.submission.job.strandId;
    if (strandId === undefined) return false;
    const waitingFor = strandWaitingFor(session.program, outcomes, strandId);
    if (waitingFor.length === 0) return false;
    entry.waiting = { kind: "strands", waitingFor };
    return true;
  };

  /**
   * Parks what can no longer run (§4.4): a strand that settled without
   * succeeding, and every queued strand in its cone, withdrawn with a reason that
   * names the blocker. Everything outside the cone is left alone and runs on.
   */
  const park = async (): Promise<void> => {
    if (!planned || closed) return;
    const outcomes = await readStrandOutcomes(await readNodes());
    const blocked = blockedBy(session.program, outcomes);
    for (const [strandId, outcome] of Object.entries(outcomes)) {
      const broke = outcome === "failed" || outcome === "cancelled";
      // A strand cancelled because it was blocked is a casualty, reported below.
      if (broke && !blocked.has(strandId)) announce("strand.parked", strandId, { outcome });
    }
    for (const [strandId, blockers] of blocked) {
      const entry = pending.find((candidate) => candidate.submission.job.strandId === strandId);
      const reason = `blocked by ${blockers.join(", ")}, which did not succeed`;
      if (entry !== undefined) await withdraw(entry, reason).catch(() => {});
      announce("strand.blocked", strandId, { blockedBy: blockers });
    }
  };

  /** Once per strand per kind: parking is a fact about the run, not about each pass. */
  const announce = (
    type: "strand.parked" | "strand.blocked",
    strandId: string,
    payload: Record<string, unknown>,
  ): void => {
    if (announced.has(`${type}:${strandId}`)) return;
    announced.add(`${type}:${strandId}`);
    outbox.emit({
      type,
      source: "control-plane",
      payload: { strandId, ...payload },
      executionNodeId: session.rootNodeId,
    });
  };

  /** Refuses a strand submission the plan does not allow, before anything is written. */
  const assertStrandMayBeDelegated = async (submission: Submission): Promise<void> => {
    const strandId = submission.job.strandId;
    if (strandId === undefined) return;
    if (!strandsOf(session.program).some((strand) => strand.id === strandId)) {
      throw new StrandDelegationError(`the ratified plan has no strand ${strandId}`);
    }
    if (submission.parentNodeId !== session.rootNodeId) {
      throw new StrandDelegationError(
        `strand ${strandId} must be delegated directly under the program node`,
      );
    }
    const outcomes = await readStrandOutcomes(await readNodes());
    const blockers = blockedBy(session.program, outcomes).get(strandId);
    if (blockers !== undefined) throw new StrandBlockedError(strandId, blockers);
    const standing = outcomes[strandId];
    if (standing === "running" || standing === "succeeded") {
      throw new StrandDelegationError(
        `strand ${strandId} is already ${standing === "running" ? "in hand" : "done"}; a strand has one live attempt`,
      );
    }
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
        reroute: rerouteFor(entry.submission),
        ...(entry.submission.task === undefined ? {} : { task: entry.submission.task }),
      });
      remove(entry);
      active.set(started.nodeId, started);
      const orchestrates = entry.node.kind === "sub-program";
      if (orchestrates) orchestrators.add(started.nodeId);
      watch();
      // Kept, because "its lifecycle has settled" and "the engine has let go of it"
      // are two moments: a subtree may still be being cancelled in between, and
      // `releaseSettled` must wait for the second.
      const departure = started.completion
        .catch(() => {})
        .then(async () => {
          // An orchestrator that has gone leaves nobody to answer for what it
          // delegated: whatever is still in flight under it stops (D-P6-08).
          if (orchestrates) await cancelSubtree(started.nodeId).catch(() => {});
          await park().catch(() => {});
        })
        .finally(() => {
          active.delete(started.nodeId);
          departures.delete(started.nodeId);
          orchestrators.delete(started.nodeId);
          // What this attempt spent is on the record now; read it again (D-P8-08).
          spend = undefined;
          void pump();
        });
      departures.set(started.nodeId, departure);
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
    // P8 (D-P8-13): a sub-program's orchestrator disputes by writing the finding
    // `disputed`; the arbiter is the engine's to start.
    if (node.status === "failed" && node.kind === "job" && !arbitrating.has(id)) {
      const examination = await latestExamination(environment, session.scope, id).catch(
        () => undefined,
      );
      const disputed = examination?.findings.find((finding) => finding.resolution === "disputed");
      if (disputed !== undefined) {
        void disputeNode(id, disputed.resolvedBy?.reason ?? "disputed by its orchestrator").catch(
          () => {},
        );
      }
      return false;
    }
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

  /**
   * A `queued` node with attempts behind it is a retry a sub-program's
   * orchestrator asked for (P8): routed as a retry, one rung up after a failure
   * of the work (D-P8-07), and a fix when its examination blocked (D-P8-13).
   */
  const retryOf = async (
    node: ExecutionNode,
  ): Promise<{ readonly previous?: RouteContext["previous"]; readonly task?: AgentTask }> => {
    if (node.status !== "queued") return {};
    const previous = await previousAttempt(node.executionNodeId);
    if (previous === undefined) return {};
    const task = fixOf(
      await latestExamination(environment, session.scope, node.executionNodeId),
    ).task;
    return task === undefined ? { previous } : { previous, task };
  };

  /** A delegated node, queued: as it is when it already is, through the table's edge when it is not. */
  const enqueued = async (node: ExecutionNode, job: JobContract): Promise<ExecutionNode> => {
    if (node.status !== "validated") return node;
    const queued = transition(node, "enqueue", nowIso(clock));
    await stores.executionNodes.put(queued);
    outbox.emit({
      type: "node.queued",
      source: "control-plane",
      payload: { jobContractId: job.jobContractId, delegatedBy: node.parentNodeId },
      executionNodeId: node.executionNodeId,
    });
    return queued;
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
    const { previous, task } = await retryOf(node);
    let route: RouteChoice;
    try {
      if (options.route === undefined) throw new Error("this engine was given no way to route it");
      route = options.route(job, { unavailable: [...unavailable], previous });
    } catch (error) {
      await refuse(node, `the delegation could not be routed: ${messageOf(error)}`);
      return false;
    }

    const queued = await enqueued(node, job);
    const submission: Submission = {
      job,
      scope: node.scope,
      depth: node.depth,
      parentNodeId: node.parentNodeId as ExecutionNodeId,
      route,
      kind: node.kind === "sub-program" ? "sub-program" : "job",
      ...(task === undefined ? {} : { task }),
    };
    submissions.set(job.jobContractId, submission);
    nodeOfJob.set(job.jobContractId, id);
    pending.push({ submission, node: queued, waiting: undefined });
    return true;
  };

  /** The route for a retry of `node`, from the attempt it replaces (D-P8-07). */
  const rerouteForRetry = async (
    submission: Submission,
    node: ExecutionNode,
    nodeId: ExecutionNodeId,
  ): Promise<RouteChoice> => {
    if (options.route === undefined) return submission.route;
    const last = attemptsOf(await stores.routingDecisions.listByNode(session.scope, nodeId)).at(-1);
    try {
      return options.route(submission.job, {
        pins: submission.pins,
        unavailable: [...unavailable],
        previous:
          last === undefined
            ? undefined
            : {
                target: last.chosen,
                ladder: last.ladder,
                rungIndex: last.rung?.index,
                climb: failureClimbs(node),
              },
      });
    } catch {
      // Nothing is eligible now. The route it had is still the honest one to retry.
      return submission.route;
    }
  };

  // --- Disputes (P8, D-P8-13) ----------------------------------------------------------
  //
  // A job its examination stopped is `failed`. When an arbiter overturns every
  // blocking finding, the work that was examined is put back through the table's
  // own edges (`retry`, `start`, `report_implemented` with the examined commit)
  // and handed to the merge queue as it is: no worker runs again.
  const arbitrating = new Set<ExecutionNodeId>();

  /** What a dispute needs, or why there can be none. */
  const disputable = async (
    nodeId: ExecutionNodeId,
  ): Promise<
    | {
        readonly node: ExecutionNode;
        readonly examination: Examination;
        readonly job: JobContract;
        readonly services: NonNullable<ExecutionEnvironment["examination"]>;
      }
    | { readonly refused: string }
  > => {
    if (arbitrating.has(nodeId)) return { refused: "an arbiter is already ruling on it" };
    const services = environment.examination;
    if (services === undefined) return { refused: "this run has no arbiter to rule" };
    const node = await stores.executionNodes.get(session.scope, nodeId);
    const examination = await latestExamination(environment, session.scope, nodeId);
    if (
      node === undefined ||
      examination === undefined ||
      !examination.findings.some(isOpenMaterialFinding)
    ) {
      return { refused: "its last examination has no open material finding to dispute" };
    }
    if (node.status !== "failed" || node.jobContractId === null) {
      return {
        refused: `only a job its examination stopped can be disputed; this one is ${node.status}`,
      };
    }
    const job = await stores.jobContracts.get(session.scope, node.jobContractId);
    if (job === undefined) return { refused: "its Job Contract is not readable" };
    return { node, examination, job, services };
  };

  const disputeNode = async (nodeId: ExecutionNodeId, reason: string): Promise<DisputeResult> => {
    const found = await disputable(nodeId);
    if ("refused" in found) return { kind: "refused", reason: found.refused };
    const { node, examination, job, services } = found;

    arbitrating.add(nodeId);
    try {
      const base = await revParse(environment.git, session.repoPath, baseRef(nodeId));
      const diff = await git(
        environment.git,
        ["diff", "--no-color", "--no-ext-diff", base, examination.commitSha],
        {
          cwd: session.repoPath,
        },
      );
      environment.outbox.emit({
        type: "finding.disputed",
        source: "control-plane",
        payload: {
          examinationId: examination.examinationId,
          findings: examination.findings.filter(isOpenMaterialFinding).map((finding) => finding.id),
          reason,
        },
        executionNodeId: nodeId,
      });
      const outcome = await arbitrateAll(
        environment,
        services,
        { session, job, node, commitSha: examination.commitSha, base, phase: "queue" },
        examination,
        { diff, dispute: reason },
      );
      if (outcome.kind !== "cleared") {
        return {
          kind: "upheld",
          reason: outcome.kind === "upheld" ? outcome.reason : "the arbiter did not rule",
        };
      }
      return await readmit(node, job, examination, base);
    } finally {
      arbitrating.delete(nodeId);
    }
  };

  /** The examined work, back through the table's own edges and into the queue (D-P8-13). */
  const readmit = async (
    node: ExecutionNode,
    job: JobContract,
    examination: Examination,
    base: CommitSha,
  ): Promise<DisputeResult> => {
    const nodeId = node.executionNodeId;
    const worktree = environment.paths.worktree(session.scope.runId, nodeId);
    const { outcomeReason: _reason, ...rest } = transition(node, "retry", nowIso(clock));
    const queued: ExecutionNode = { ...rest, commitSha: null };
    await stores.executionNodes.put(queued);
    const running = transition(queued, "start", nowIso(clock));
    try {
      await stores.executionNodes.put(running);
    } catch (error) {
      if (error instanceof ConcurrencyLimitExceededError) {
        return {
          kind: "refused",
          reason: "its parent has no free slot now; the ruling stands, dispute again to land it",
        };
      }
      throw error;
    }
    await stores.executionNodes.put(markImplemented(running, examination.commitSha, nowIso(clock)));
    outbox.emit({
      type: "node.implemented",
      source: "control-plane",
      payload: {
        commitSha: examination.commitSha,
        jobContractId: job.jobContractId,
        readmitted:
          "an arbiter overturned every blocking finding; the examined work lands as it is",
      },
      executionNodeId: nodeId,
    });
    void queue
      .integrate({
        session,
        job,
        nodeId,
        agentId: examination.implementerAgentId,
        worktree,
        branch: jobBranch(session.scope.runId, nodeId),
        base,
      })
      .finally(() => void pump());
    return { kind: "overturned", nodeId };
  };

  /**
   * The attempt a discovered retry replaces, and whether its ending climbs. A
   * sub-program's orchestrator requeues a node itself, so the ending is read back
   * from the record: the last attempt's route, and the last failure event's reason.
   */
  const previousAttempt = async (nodeId: ExecutionNodeId): Promise<RouteContext["previous"]> => {
    const last = attemptsOf(await stores.routingDecisions.listByNode(session.scope, nodeId)).at(-1);
    if (last === undefined) return undefined;
    const reason = await lastFailureReason(nodeId);
    const climb =
      last.outcome === "verification_failed" ||
      (last.outcome === "failed" &&
        failureClimbs({ status: "failed", outcomeReason: reason ?? "" }));
    return { target: last.chosen, ladder: last.ladder, rungIndex: last.rung?.index, climb };
  };

  /** Why a node last failed, as its `node.failed` event said. */
  const lastFailureReason = async (nodeId: ExecutionNodeId): Promise<string | undefined> => {
    let reason: string | undefined;
    let cursor: string | undefined;
    do {
      const page = await stores.events.listByRun(
        session.scope,
        cursor === undefined ? {} : { cursor },
      );
      for (const event of page.items) {
        const said = (event.payload as { reason?: unknown }).reason;
        if (
          event.executionNodeId === nodeId &&
          event.type === "node.failed" &&
          typeof said === "string"
        ) {
          reason = said;
        }
      }
      cursor = page.cursor;
    } while (cursor !== undefined);
    return reason;
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
      // Deferred work is not in flight: it waits on a human, on the provisional
      // line, and outlives the orchestrator that delegated it (D-P7-10).
      if (node !== undefined && !isDoneForNow(node.status) && node.status !== "implemented") {
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
      await assertStrandMayBeDelegated(submission);
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

      // A fix of blocking findings (D-P8-13): at most two, and none once an
      // arbiter has upheld one. Refused with the reason, before anything moves.
      const examination = await latestExamination(environment, session.scope, nodeId);
      const fix = fixOf(examination);
      if (fix.refused !== undefined) throw new FixLimitError(fix.refused);

      // Where the retry goes (D-P8-07): one rung up after a failure of the model,
      // the same route after one that was not. The router decides; the
      // orchestrator only decided to retry.
      const route = rerouteForRetry(submission, node, nodeId);
      const { task: _previousTask, ...rest0 } = submission;
      const retried: Submission = {
        ...rest0,
        route: await route,
        ...(fix.task === undefined ? {} : { task: fix.task }),
      };
      submissions.set(jobContractId, retried);

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
      pending.push({ submission: retried, node: requeued, waiting: undefined });
      await pump();
      return true;
    },

    dispute: async (jobContractId, reason) => {
      const nodeId = nodeOfJob.get(jobContractId);
      if (nodeId === undefined)
        return { kind: "refused", reason: "this engine does not hold that job" };
      return disputeNode(nodeId, reason);
    },

    idle: () => active.size === 0 && pending.length === 0 && arbitrating.size === 0,

    releaseSettled: async (graceMs) => {
      const stored = new Map((await readNodes()).map((node) => [node.executionNodeId, node]));
      await Promise.all(
        [...active.entries()].map(async ([nodeId, started]) => {
          const node = stored.get(nodeId);
          if (node === undefined || !isDoneForNow(node.status)) return;
          let timer: ReturnType<typeof setTimeout> | undefined;
          const leaving = departures.get(nodeId) ?? started.completion.catch(() => {});
          const exited = await Promise.race([
            leaving.then(() => true),
            new Promise<boolean>((resolve) => {
              timer = setTimeout(() => resolve(false), graceMs);
            }),
          ]);
          if (timer !== undefined) clearTimeout(timer);
          if (!exited) {
            await started.cancel().catch(() => {});
            await leaving;
          }
        }),
      );
    },

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
      // A launch already under way finishes first. Its node has taken its slot
      // and its agent exists, but it is in nobody's list until `startJob`
      // returns; stopping now would leave it running with nothing to stop it.
      // Once it is in `jobs()`, shutdown interrupts it like the rest.
      while (pumping !== undefined) await pumping;
      const withdrawn: ExecutionNodeId[] = [];
      for (const entry of [...pending]) {
        withdrawn.push(entry.node.executionNodeId);
        await withdraw(entry, reason).catch(() => {});
      }
      return withdrawn;
    },

    strands: async () => (planned ? readStrandOutcomes(await readNodes()) : {}),

    settled: async () => {
      while (pumping !== undefined) await pumping;
    },

    discover,
  };
};

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
