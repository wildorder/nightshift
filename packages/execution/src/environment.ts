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
  ProjectStores,
  RunScope,
} from "@nightshift/core";
import type { Harness } from "@nightshift/harness";
import type { GitRunner } from "./git/index.js";
import type { EventOutbox } from "./outbox.js";

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
   * How long a verification step may run before its process tree is killed.
   * Per step, not per run.
   */
  readonly verificationTimeoutMs?: number;
  /** How long `cancel` waits for a cooperative stop before killing. */
  readonly cancelGraceMs?: number;
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
