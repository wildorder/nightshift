/**
 * Persistence ports (D-P1-08).
 *
 * Interfaces only. `packages/persistence` supplies an in-memory implementation
 * for tests and a DynamoDB/S3 implementation for real runs, and nothing above
 * the adapter layer knows which one it has.
 *
 * Two properties are structural rather than conventional:
 *
 * - **No method can list across projects.** Every read takes the ownership chain
 *   it needs, so "Project A cannot see Project B" is not something an
 *   implementation has to remember; there is no signature that would let it.
 *   Identity records (users and memberships) are the one exception, because they
 *   sit above every project rather than inside one (D-P2-17).
 * - **Event appends are idempotent.** `append` reports whether it stored a new
 *   event or found an existing one with the same key, so a replayed local spool
 *   converges (A-06).
 */
import type {
  Agent,
  AgentId,
  Artifact,
  ArtifactId,
  CalendarMonth,
  Checkpoint,
  CheckpointId,
  ComputeArchitecture,
  ComputeUtilization,
  Decision,
  DecisionId,
  Dispatch,
  DispatchStatus,
  Event,
  Examination,
  ExaminationId,
  ExecutionNode,
  ExecutionNodeId,
  GateHealth,
  JobContract,
  JobContractId,
  Membership,
  OrgComputeUsage,
  OrgConfig,
  OrgCredential,
  OrgCredentialView,
  OrgId,
  ProgramContract,
  ProgramId,
  Project,
  ProjectId,
  Provider,
  RoutingDecision,
  Run,
  RunId,
  User,
  UserId,
  Verification,
  VerificationId,
  WarmCache,
} from "@nightshift/contracts";
import type { ProgramScope, RunScope } from "../rules/ownership.js";

/** Forward-only pagination. Absent `cursor` means "from the beginning". */
export interface PageRequest {
  readonly limit?: number;
  readonly cursor?: string;
}

export interface Page<T> {
  readonly items: readonly T[];
  /** Absent when the result set is exhausted. */
  readonly cursor?: string;
}

export interface ProjectStore {
  /**
   * Stores a project together with its organisation listing.
   *
   * A project's `orgId` is immutable. A put that would move a stored project to
   * another org throws `OwnershipViolationError` (field `orgId`) and changes
   * nothing, rather than leaving the project listed under both.
   */
  put(project: Project): Promise<void>;
  get(projectId: ProjectId): Promise<Project | undefined>;
  /**
   * The projects in one organisation, in ascending `projectId` order.
   *
   * **A grouping query, not an authorisation check.** v1 enforces no org
   * separation (A-21 non-guarantee): nothing here decides whether a caller may see
   * these projects, and anyone able to read one project can read any.
   */
  listByOrg(orgId: OrgId, page?: PageRequest): Promise<Page<Project>>;
}

export interface ProgramContractStore {
  put(contract: ProgramContract): Promise<void>;
  get(projectId: ProjectId, programId: ProgramId): Promise<ProgramContract | undefined>;
  listByProject(projectId: ProjectId, page?: PageRequest): Promise<Page<ProgramContract>>;
}

export interface RunStore {
  put(run: Run): Promise<void>;
  get(scope: ProgramScope, runId: RunId): Promise<Run | undefined>;
  listByProgram(scope: ProgramScope, page?: PageRequest): Promise<Page<Run>>;
}

export interface ExecutionNodeStore {
  put(node: ExecutionNode): Promise<void>;
  get(scope: RunScope, executionNodeId: ExecutionNodeId): Promise<ExecutionNode | undefined>;
  listByRun(scope: RunScope, page?: PageRequest): Promise<Page<ExecutionNode>>;
  listChildren(scope: RunScope, parentNodeId: ExecutionNodeId): Promise<readonly ExecutionNode[]>;
}

export interface JobContractStore {
  put(contract: JobContract): Promise<void>;
  get(scope: RunScope, jobContractId: JobContractId): Promise<JobContract | undefined>;
  listByRun(scope: RunScope, page?: PageRequest): Promise<Page<JobContract>>;
}

export interface AgentStore {
  put(agent: Agent): Promise<void>;
  get(scope: RunScope, agentId: AgentId): Promise<Agent | undefined>;
  listByNode(scope: RunScope, executionNodeId: ExecutionNodeId): Promise<readonly Agent[]>;
}

/** Outcome of an append. `stored: false` means an event with that key already existed. */
export interface AppendResult {
  readonly stored: boolean;
  readonly event: Event;
}

export interface EventStore {
  /**
   * Durably appends `event`.
   *
   * `sequence` is assigned by the store and never taken from the caller, and it
   * may still be `null` when this returns: numbering trails durability (A-22). An
   * adapter that numbers synchronously returns the number; one that defers
   * returns `null` and numbers the event later, densely and in append order.
   *
   * Idempotent on `idempotencyKey` within a run: a duplicate submission stores
   * nothing, returns the previously stored event, and never consumes a number.
   */
  append(event: Event): Promise<AppendResult>;
  /**
   * Numbered events in ascending `sequence`, then unnumbered events by
   * identifier — the order `orderEvents` defines. Stable across calls.
   *
   * `afterSequence` returns only numbered events after that point. It therefore
   * lags behind an unnumbered tail, and never skips an event.
   */
  listByRun(
    scope: RunScope,
    options?: PageRequest & { readonly afterSequence?: number },
  ): Promise<Page<Event>>;
  /**
   * The number the next event to be numbered in this run will receive, which is
   * also how many of its events have been numbered so far.
   */
  nextSequence(scope: RunScope): Promise<number>;
}

export interface DecisionStore {
  put(decision: Decision): Promise<void>;
  get(scope: RunScope, decisionId: DecisionId): Promise<Decision | undefined>;
  listByRun(scope: RunScope, page?: PageRequest): Promise<Page<Decision>>;
}

export interface CheckpointStore {
  put(checkpoint: Checkpoint): Promise<void>;
  get(scope: RunScope, checkpointId: CheckpointId): Promise<Checkpoint | undefined>;
  listByRun(scope: RunScope, page?: PageRequest): Promise<Page<Checkpoint>>;
}

export interface VerificationStore {
  put(verification: Verification): Promise<void>;
  get(scope: RunScope, verificationId: VerificationId): Promise<Verification | undefined>;
  listByNode(scope: RunScope, executionNodeId: ExecutionNodeId): Promise<readonly Verification[]>;
}

export interface ExaminationStore {
  put(examination: Examination): Promise<void>;
  get(scope: RunScope, examinationId: ExaminationId): Promise<Examination | undefined>;
  listByNode(scope: RunScope, executionNodeId: ExecutionNodeId): Promise<readonly Examination[]>;
}

export interface RoutingDecisionStore {
  put(decision: RoutingDecision): Promise<void>;
  listByNode(
    scope: RunScope,
    executionNodeId: ExecutionNodeId,
  ): Promise<readonly RoutingDecision[]>;
}

export interface ArtifactStore {
  /**
   * Records a reference to stored output. Implementations must reject anything
   * carrying inline content: large output belongs in S3, never in DynamoDB (A-08).
   */
  put(artifact: Artifact): Promise<void>;
  get(scope: RunScope, artifactId: ArtifactId): Promise<Artifact | undefined>;
  listByRun(scope: RunScope, page?: PageRequest): Promise<Page<Artifact>>;
}

/**
 * Principals keyed by their Cognito subject (T9). Not project scoped: a user
 * exists above every project (D-P2-17).
 */
export interface UserStore {
  put(user: User): Promise<void>;
  get(userId: UserId): Promise<User | undefined>;
}

/**
 * Which organisations a user may act for (T9).
 *
 * Deriving the acting org from a membership is not the same as refusing
 * cross-org access, and nothing here does the latter (A-21 non-guarantee).
 */
export interface MembershipStore {
  /** Idempotent: a user holds at most one membership per org. */
  put(membership: Membership): Promise<void>;
  /** Every membership `userId` holds, in ascending `orgId` order. */
  listByUser(userId: UserId): Promise<readonly Membership[]>;
}

/**
 * An organisation's routing and examination policy (P8, D-P8-02). Above every
 * project, like a membership, and in {@link ProjectStores} anyway: a run reads
 * its org's policy when it starts, through whichever adapter it has.
 */
export interface OrgConfigStore {
  /** The stored configuration, or `undefined` when nobody has written one. */
  get(orgId: OrgId): Promise<OrgConfig | undefined>;
  /**
   * Stores `config` only if the stored one is at `config.version - 1` (absent
   * counts as 0). Throws `StaleWriteError` otherwise and changes nothing.
   */
  put(config: OrgConfig): Promise<void>;
}

/**
 * One remote run's machine (P10, D-P10-18). One dispatch per run, keyed by the
 * run, so a retried `POST …/dispatch` finds the one it made.
 */
export interface DispatchStore {
  put(dispatch: Dispatch): Promise<void>;
  get(scope: RunScope): Promise<Dispatch | undefined>;
  /**
   * Every dispatch in one of `statuses`, across projects: the **reconciler's**
   * read (D-P10-18), the one deliberate exception to "no method lists across
   * projects". No route serves it; only the control plane's own scheduled
   * function calls it, to find the machines it owes a lease check, a
   * provisioning or a cleanup to.
   */
  listByStatus(statuses: readonly DispatchStatus[]): Promise<readonly Dispatch[]>;
}

/**
 * What a run's machine was asked to do (P10, D-P10-14b). Listed by project,
 * newest run first, because the right-sizing rule reads a project's last three.
 */
export interface ComputeUtilizationStore {
  put(utilization: ComputeUtilization): Promise<void>;
  get(scope: RunScope): Promise<ComputeUtilization | undefined>;
  listByProject(projectId: ProjectId, page?: PageRequest): Promise<Page<ComputeUtilization>>;
}

/** A project's warm snapshot (P10, D-P10-15), one per architecture. */
export interface WarmCacheStore {
  put(cache: WarmCache): Promise<void>;
  get(projectId: ProjectId, architecture: ComputeArchitecture): Promise<WarmCache | undefined>;
  /** Forgets a project's cache for an architecture: its snapshot is gone, and the next run starts cold. */
  delete(projectId: ProjectId, architecture: ComputeArchitecture): Promise<void>;
}

/**
 * A project's gate-health record (P15, D-P15-07): one per project, and `put`
 * replaces it. Written by a Nightshift command or the engine, never by an
 * agent's file edit.
 */
export interface GateHealthStore {
  put(record: GateHealth): Promise<void>;
  get(projectId: ProjectId): Promise<GateHealth | undefined>;
}

/**
 * Which org holds a GitHub App installation (P10, D-P10-02). One installation
 * is one customer's: a second org claiming it is refused, so a repository's
 * publication authority cannot be borrowed by recording someone else's
 * installation id. The claim is a compare-and-set: absent, or already this org.
 */
export interface InstallationClaimStore {
  claim(
    installationId: number,
    orgId: OrgId,
    at: string,
  ): Promise<{ readonly ok: true } | { readonly ok: false; readonly heldBy: OrgId }>;
}

/**
 * An org's provider credentials (P10, D-P10-23). Above every project, like a
 * membership. `view` is what any read route returns; `sealed` is read by the
 * heartbeat alone, to decrypt for the run's own engine.
 */
export interface CredentialsStore {
  put(credential: OrgCredential): Promise<void>;
  view(orgId: OrgId): Promise<readonly OrgCredentialView[]>;
  sealed(orgId: OrgId, provider: Provider): Promise<OrgCredential | undefined>;
}

/**
 * An org's compute ledger, one row per month (P10, D-P10-19). Written by the
 * API alone, as dispatches start, heartbeat and end; read to refuse a dispatch.
 */
export interface ComputeLedgerStore {
  get(orgId: OrgId, month: CalendarMonth): Promise<OrgComputeUsage | undefined>;
  put(usage: OrgComputeUsage): Promise<void>;
}

/**
 * Everything a *run* persists (T2).
 *
 * Split out from {@link NightshiftStores} in P3 because the two halves have
 * different adapters. `persistence/http` implements this half and no more: the
 * local machinery reaches the control plane through the API (A-28), and the API
 * exposes no route that administers a user. Identity is administered by the
 * operator with an AWS profile, not by a run.
 *
 * The execution layer depends on this interface, never on the full set.
 */
export interface ProjectStores {
  readonly projects: ProjectStore;
  readonly programContracts: ProgramContractStore;
  readonly runs: RunStore;
  readonly executionNodes: ExecutionNodeStore;
  readonly jobContracts: JobContractStore;
  readonly agents: AgentStore;
  readonly events: EventStore;
  readonly decisions: DecisionStore;
  readonly checkpoints: CheckpointStore;
  readonly verifications: VerificationStore;
  readonly examinations: ExaminationStore;
  readonly routingDecisions: RoutingDecisionStore;
  readonly artifacts: ArtifactStore;
  readonly orgConfigs: OrgConfigStore;
  // P10: the remote runner's records.
  readonly dispatches: DispatchStore;
  readonly computeUtilizations: ComputeUtilizationStore;
  readonly warmCaches: WarmCacheStore;
  readonly installationClaims: InstallationClaimStore;
  // P15: the project's gate health.
  readonly gateHealth: GateHealthStore;
}

/**
 * Principals and their organisations (T2, D-P2-17).
 *
 * Above every project, so kept apart from {@link ProjectStores}. An adapter that
 * cannot administer identity — the http adapter — supplies this half not at all,
 * and the conformance suite runs its identity section only for adapters that do.
 */
export interface IdentityStores {
  readonly users: UserStore;
  readonly memberships: MembershipStore;
  /** P10 (D-P10-23): an org's provider keys, in a table of their own. */
  readonly credentials: CredentialsStore;
  /** P10 (D-P10-19): what the org's remote runs have spent this month. */
  readonly computeLedger: ComputeLedgerStore;
}

/**
 * Everything the control plane persists, in one injectable bundle. The API
 * handler takes the full set; only an application wires a concrete one.
 */
export interface NightshiftStores extends ProjectStores, IdentityStores {}
