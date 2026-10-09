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
  JobContract,
  JobContractId,
  Prerequisite,
  ProgramContract,
  RouteChoice,
  RoutingDecision,
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
import type { Harness, McpLaunch, RunAs } from "@nightshift/harness";
import type { GitRunner } from "./git/index.js";
import type { EventOutbox } from "./outbox.js";
import type { PublishLanding } from "./publish.js";
import type { WorkerTokenFiles } from "./worker-tokens.js";

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
  readonly role: "worker" | "sub-orchestrator" | "examiner" | "arbiter";
  /**
   * P8: variables the server of an examiner or an arbiter reads the frame of
   * its task from. Never a credential: that is `executionToken`, alone.
   */
  readonly extraEnv?: Readonly<Record<string, string>>;
  /**
   * The worker's only credential (D-P4-06). Bound to this agent, this node and
   * this run, expiring within the cost policy's wall clock. Never logged, never
   * written to disk.
   */
  readonly executionToken: string;
  /**
   * P10 (T4): where the worker's server reads its token from instead, a file
   * the engine rewrites before the token expires. Absent on a laptop.
   */
  readonly executionTokenFile?: string;
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
  /**
   * P8: who examines and who arbitrates, supplied by the composition root,
   * because routing is not this package's. Absent, a job whose risk requires
   * examination is not examined and does not land: it fails, saying so.
   */
  readonly examination?: ExaminationServices;
  /**
   * P10 (D-P10-22): called after every landing that moved the program branch,
   * with the new head, so a machine's engine can ask the publisher to move
   * GitHub's copy. Installed by the runner's composition only; a local run,
   * whose program checkout is the operator's own clone, has none.
   */
  readonly publish?: PublishLanding;
  /**
   * P10 (D-P10-25): the operating-system user an agent's process runs as, on
   * a machine. The composition supplies it; absent, every process is the
   * engine's own, as on a laptop. The root orchestrator never asks.
   */
  readonly runAs?: (agent: {
    readonly agentId: string;
    readonly role: string;
  }) => RunAs | undefined;
  /**
   * P10 (D-P10-25): takes a path the engine granted to an agent back for the
   * engine, before the engine removes it. A worktree handed to a worker user
   * is that user's; the shared group lets the engine read and verify it, but
   * removal must not depend on every file the agent or its tools wrote being
   * group-writable. Supplied with `runAs`; absent on a laptop, where every
   * path is already the engine's.
   */
  readonly reclaim?: (path: string) => Promise<void>;
  /**
   * P10 (T4): on a machine, a worker's token lives in a file the engine keeps
   * fresh (`worker-tokens.ts`); absent, the token travels in the launch and
   * lasts as long as it lasts.
   */
  readonly workerTokens?: WorkerTokenFiles;
  /**
   * P16 (D-10): the project environment, on a machine: the pinned runtimes
   * first on PATH, the stores on the volume, Rust's and Java's homes. Every
   * step that runs the project's code (setup, verification and its reruns,
   * an examination's checkout, the setup reference) is given it, under the
   * step's own scratch; this process never takes it as its own. Absent on a
   * laptop, where a step runs in the developer's environment as it always has.
   */
  readonly projectEnv?: Readonly<Record<string, string>>;
}

/**
 * What only the composition root can supply (P8): who examines and who
 * arbitrates is routing's, and routing is not this package's.
 */
export interface ExaminationServices {
  /** The examiner's route for a job whose implementer ran on `implementer` (D-P8-10). */
  examinerRoute(input: {
    readonly job: JobContract;
    readonly implementer: RoutingDecision["chosen"];
    readonly mustDifferModel: boolean;
    readonly mustDifferProvider: boolean;
  }): RouteChoice;
  /** The highest-tier route, a model neither side used when there is one (D-P8-13, as amended). */
  arbiterRoute(input: {
    readonly job: JobContract;
    readonly implementer: RoutingDecision["chosen"];
    readonly examiner: RoutingDecision["chosen"];
  }): RouteChoice;
  /** The MCP launch for an examiner's or an arbiter's server, carrying its identity. */
  mcp(identity: WorkerLaunchIdentity): McpLaunch;
}

/**
 * What verifying and integrating a commit need, and no more: no harness, no
 * token minter, no worker environment. `nightshift resume` has exactly this
 * (P7, D-P7-10): it runs checks and lands commits, and starts no agent.
 */
export type LandingEnvironment = Pick<
  ExecutionEnvironment,
  | "stores"
  | "bodies"
  | "clock"
  | "ids"
  | "paths"
  | "git"
  | "outbox"
  | "publish"
  | "verificationTimeoutMs"
  | "prerequisites"
  | "runAs"
  | "reclaim"
  | "projectEnv"
>;

/** Reads the program's prerequisites. Satisfied by `persistence/http`'s planning client. */
export interface PrerequisiteBook {
  prerequisites(scope: ProgramScope): Promise<readonly Prerequisite[]>;
  /** Records a hurdle a verification command declared mid-run (D-P7-10). */
  recordDiscovered(
    scope: ProgramScope,
    prerequisiteId: string,
    hurdle: {
      readonly runId: RunId;
      readonly description: string;
      readonly remediation: string;
      readonly verifyCommand: string;
    },
  ): Promise<Prerequisite>;
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
