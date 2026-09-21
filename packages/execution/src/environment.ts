/**
 * What the execution layer is given, and what it deliberately is not.
 *
 * Everything arrives injected: the stores, the artifact body store, the harness,
 * the clock, the identifier generator, the paths and the `git` runner. That is
 * what makes SC-P3-14 structural — this package imports no adapter and no
 * provider SDK, so it *cannot* know whether its stores are in memory or across
 * the network, or whether its harness is Claude Code or a scripted stand-in.
 * Only an application's composition root names a concrete one.
 */
import type {
  AgentId,
  ExecutionNodeId,
  JobContractId,
  Prerequisite,
  ProgramContract,
  Run,
  RunId,
} from "@nightshift/contracts";
import type {
  ArtifactBodyStore,
  Clock,
  ExecutionTokenMinter,
  IdGenerator,
  LocalPaths,
  ProgramScope,
  ProjectStores,
  RunScope,
} from "@nightshift/core";
import type { Harness } from "@nightshift/harness";
import type { GitRunner } from "./git/index.js";
import type { EventOutbox } from "./outbox.js";

/**
 * What the worker's MCP server must be told about itself (P3 §4.2, §4.5).
 *
 * The identity says *which* agent it is; the token is *how it proves it*. Both
 * are set by the party that spawns the worker, which is never the worker.
 */
export interface WorkerLaunchIdentity {
  readonly projectId: string;
  readonly programId: string;
  readonly runId: string;
  readonly nodeId: ExecutionNodeId;
  readonly agentId: AgentId;
  readonly jobContractId: JobContractId;
  readonly worktree: string;
  /**
   * Which Nightshift MCP role the launch is for. `worker` for a job;
   * `sub-orchestrator` for a sub-program's orchestrator (P6, D-P6-03), whose
   * server holds a delegating token and a different tool surface.
   */
  readonly role: "worker" | "sub-orchestrator";
  /**
   * The worker's only credential (D-P4-06). Bound to this agent, this node and
   * this run, expiring within the cost policy's wall clock. Never logged, never
   * written to disk.
   */
  readonly executionToken: string;
}

/** What the worker half needs. A narrower set than the runner's. */
export interface WorkerEnvironment {
  readonly stores: ProjectStores;
  readonly clock: Clock;
  readonly git: GitRunner;
  readonly outbox: EventOutbox;
}

export interface ExecutionEnvironment {
  readonly stores: ProjectStores;
  readonly bodies: ArtifactBodyStore;
  /**
   * Mints a worker's execution token when its agent is created (D-P4-06). Called
   * with the orchestrator's own session, because minting is a user operation.
   */
  readonly tokens: ExecutionTokenMinter;
  readonly harness: Harness;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly paths: LocalPaths;
  readonly git: GitRunner;
  readonly outbox: EventOutbox;
  /**
   * The environment a worker's four operations run in when an adapter calls them
   * as functions (`HarnessStartInput.tools`, A-37): stores and an outbox that
   * hold **the worker's execution token and nothing else**, so a write made on a
   * worker's behalf is recorded as the worker's (A-35). Supplied by the
   * composition root, because building an http adapter is not this package's
   * business.
   */
  readonly workerEnvironment: (launch: WorkerLaunchIdentity) => WorkerEnvironment;
  /**
   * How long a verification step may run before its process tree is killed.
   * Per step, not per run.
   */
  readonly verificationTimeoutMs?: number;
  /** How long `cancel` waits for a cooperative stop before killing. */
  readonly cancelGraceMs?: number;
  /**
   * The program's human prerequisites as the control plane holds them **now**
   * (P7, D-P7-10): a verification step that requires an unmet one is deferred.
   * Absent for a run with no plan, where nothing can be deferred and the
   * contract's own copy is the only one there is.
   */
  readonly prerequisites?: PrerequisiteBook;
}

/** Reads the program's prerequisites. Satisfied by `persistence/http`'s planning client. */
export interface PrerequisiteBook {
  prerequisites(scope: ProgramScope): Promise<readonly Prerequisite[]>;
}

/**
 * One run, as the orchestrator's server holds it for a session.
 *
 * `repoPath` is the operator's own clone — the program checkout. Nightshift
 * never writes into its working tree except by fast-forwarding its branch
 * (A-29), and `integrate` refuses when it is dirty rather than fast-forwarding
 * over someone's work in progress.
 */
export interface RunSession {
  readonly scope: RunScope;
  readonly program: ProgramContract;
  readonly run: Run;
  readonly rootNodeId: ExecutionNodeId;
  /** The orchestrator's own agent, created by `run.attach`. */
  readonly orchestratorAgentId: AgentId;
  readonly repoPath: string;
}

/**
 * The identity a worker-side call acts for (contract §4.2).
 *
 * A worker's MCP server refuses to start without every one of these, so by the
 * time any of the worker-side functions run, the identity is not in question.
 */
export interface WorkerIdentity {
  readonly scope: RunScope;
  readonly executionNodeId: ExecutionNodeId;
  readonly jobContractId: JobContractId;
  readonly agentId: AgentId;
  readonly worktree: string;
}

export const runIdOf = (scope: RunScope): RunId => scope.runId;

export const DEFAULT_VERIFICATION_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_CANCEL_GRACE_MS = 10_000;
