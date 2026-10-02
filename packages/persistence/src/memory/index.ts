/**
 * In-memory persistence adapter — **test use only** (D-P1-08).
 *
 * This exists so `execution` and everything above it can be tested offline from
 * P3 onward without standing up AWS. It is emphatically *not* a local canonical
 * store: A-06 says there is one authoritative control plane, and a local
 * database beside it is explicitly out of scope for v1.
 *
 * Two behaviours are load-bearing and are asserted by the shared conformance
 * suite, which the DynamoDB adapter passes too:
 *
 * - Keys embed the full ownership chain, so cross-project reads are impossible
 *   by construction rather than by filtering.
 * - Every `put` re-parses its record through the contract schema, so a caller
 *   that built a record by casting is caught here rather than in DynamoDB.
 */
import {
  type Agent,
  type AgentId,
  AgentSchema,
  type Artifact,
  type ArtifactId,
  ArtifactSchema,
  type CalendarMonth,
  type Checkpoint,
  type CheckpointId,
  CheckpointSchema,
  type ComputeArchitecture,
  type ComputeUtilization,
  ComputeUtilizationSchema,
  type Decision,
  type DecisionId,
  DecisionSchema,
  type Dispatch,
  DispatchSchema,
  type Event,
  EventSchema,
  type Examination,
  type ExaminationId,
  ExaminationSchema,
  type ExecutionNode,
  type ExecutionNodeId,
  ExecutionNodeSchema,
  type JobContract,
  type JobContractId,
  JobContractSchema,
  type Membership,
  MembershipSchema,
  type OrgComputeUsage,
  OrgComputeUsageSchema,
  type OrgConfig,
  OrgConfigSchema,
  type OrgCredential,
  OrgCredentialSchema,
  type OrgId,
  type ProgramContract,
  ProgramContractSchema,
  type ProgramId,
  type Project,
  type ProjectId,
  ProjectSchema,
  type Provider,
  type RoutingDecision,
  RoutingDecisionSchema,
  type Run,
  type RunId,
  RunSchema,
  type User,
  type UserId,
  UserSchema,
  type Verification,
  type VerificationId,
  VerificationSchema,
  type WarmCache,
  WarmCacheSchema,
} from "@nightshift/contracts";
import {
  type AgentStore,
  type AppendResult,
  type ArtifactStore,
  type CheckpointStore,
  type ComputeLedgerStore,
  type ComputeUtilizationStore,
  type CredentialsStore,
  type DecisionStore,
  type DispatchStore,
  type EventStore,
  type ExaminationStore,
  type ExecutionNodeStore,
  type JobContractStore,
  type MembershipStore,
  type NightshiftStores,
  type OrgConfigStore,
  OwnershipViolationError,
  type Page,
  type PageRequest,
  type ProgramContractStore,
  type ProgramScope,
  type ProjectStore,
  type RoutingDecisionStore,
  type RunScope,
  type RunStore,
  type SequenceLedger,
  StaleWriteError,
  type StampOutcome,
  type UserStore,
  type VerificationStore,
  type WarmCacheStore,
} from "@nightshift/core";
import {
  type Atomically,
  mapTables,
  paginate,
  programPrefix,
  projectPrefix,
  runPrefix,
  type TableFactory,
} from "./scoped-map.js";

/** Everything one in-memory control plane holds. Reset between tests. */
export interface InMemoryState {
  clear(): void;
  /** Total records held, for assertions about what a test actually wrote. */
  readonly size: number;
  /**
   * Stamps sequence numbers on events appended while `deferSequencing` was on,
   * in append order, imitating the DynamoDB Streams consumer (A-22). Returns how
   * many it numbered.
   *
   * Without this, the durable-but-unnumbered state would only ever exist against
   * real AWS, and every consumer written in P3 onward would be untested against
   * the case it most needs to handle.
   */
  materializeSequences(): number;
  /**
   * The same numbering one event at a time, through the port the Streams
   * consumer uses, so the consumer's logic can be tested offline (T6).
   */
  readonly sequenceLedger: SequenceLedger;
}

export interface InMemoryOptions {
  /**
   * Leave `sequence` null on append, until `materializeSequences()` or the
   * `sequenceLedger` numbers it. Off by default, so the adapter behaves
   * synchronously unless a test is deliberately exercising the lag.
   */
  readonly deferSequencing?: boolean;
  /**
   * Where the records live (P12, D-P12-02). One table per store, by name; the
   * default is a `Map` each, as before. `@nightshift/persistence/local` passes
   * SQLite tables, and every method below is the same code over either.
   */
  readonly tables?: TableFactory;
  /** Runs a multi-write step as one unit. The default runs it directly. */
  readonly atomically?: Atomically;
}

export interface InMemoryStores extends NightshiftStores, InMemoryState {}

/** `/` separates key parts; no identifier or Cognito subject can contain one. */
const orgPrefix = (orgId: OrgId): string => `${orgId}/`;
const userPrefix = (userId: UserId): string => `${userId}/`;

export const createInMemoryStores = (options: InMemoryOptions = {}): InMemoryStores => {
  const deferSequencing = options.deferSequencing ?? false;
  const table = options.tables ?? mapTables;
  const atomically: Atomically = options.atomically ?? ((fn) => fn());
  const projects = table<Project>("projects");
  const projectsByOrg = table<Project>("projectsByOrg");
  const programContracts = table<ProgramContract>("programContracts");
  const runs = table<Run>("runs");
  const executionNodes = table<ExecutionNode>("executionNodes");
  const jobContracts = table<JobContract>("jobContracts");
  const agents = table<Agent>("agents");
  const events = table<Event>("events");
  const eventsByIdempotencyKey = table<Event>("eventsByIdempotencyKey");
  const decisions = table<Decision>("decisions");
  const checkpoints = table<Checkpoint>("checkpoints");
  const verifications = table<Verification>("verifications");
  const examinations = table<Examination>("examinations");
  const routingDecisions = table<RoutingDecision>("routingDecisions");
  const artifacts = table<Artifact>("artifacts");
  const users = table<User>("users");
  const memberships = table<Membership>("memberships");
  const orgConfigs = table<OrgConfig>("orgConfigs");
  // P10: the remote runner's records, and the org's sealed keys.
  const dispatches = table<Dispatch>("dispatches");
  const computeUtilizations = table<ComputeUtilization>("computeUtilizations");
  const warmCaches = table<WarmCache>("warmCaches");
  const credentials = table<OrgCredential>("credentials");
  const computeLedger = table<OrgComputeUsage>("computeLedger");

  const all = [
    projects,
    projectsByOrg,
    programContracts,
    runs,
    executionNodes,
    jobContracts,
    agents,
    events,
    eventsByIdempotencyKey,
    decisions,
    checkpoints,
    verifications,
    examinations,
    routingDecisions,
    artifacts,
    users,
    memberships,
    orgConfigs,
    dispatches,
    computeUtilizations,
    warmCaches,
    credentials,
    computeLedger,
  ];

  /**
   * Sequence counters, one per run. Never reused, so ordering is total. A table
   * like the rest, so a durable store keeps numbering where it stopped.
   */
  const sequences = table<number>("sequences");
  /**
   * Global append order, for deferred numbering only: in memory even over a
   * durable table, because a durable store never defers (the local plane numbers
   * on append, as the materializer would).
   */
  const appendOrder: string[] = [];

  /**
   * Numbers the event stored under `key` if it is still unnumbered. The one place
   * a number is assigned after the fact, shared by `materializeSequences` and the
   * ledger so the two cannot number differently.
   */
  const stampStored = (key: string): StampOutcome => atomically(() => stampStoredNow(key));

  const stampStoredNow = (key: string): StampOutcome => {
    const event = events.get(key);
    if (event === undefined) return { kind: "missing" };
    if (event.sequence !== null) return { kind: "already_numbered", sequence: event.sequence };
    const runKey = runPrefix(event);
    const next = sequences.get(runKey) ?? 0;
    sequences.set(runKey, next + 1);
    const numbered = { ...event, sequence: next };
    events.set(key, numbered);
    eventsByIdempotencyKey.set(`${runKey}${event.idempotencyKey}`, numbered);
    return { kind: "stamped", sequence: next };
  };

  const projectStore: ProjectStore = {
    put: async (project) => {
      const parsed = ProjectSchema.parse(project);
      const existing = projects.get(parsed.projectId);
      // The org listing is written beside the project; moving orgs would strand it.
      if (existing !== undefined && existing.orgId !== parsed.orgId) {
        throw new OwnershipViolationError("orgId", existing.orgId, parsed.orgId);
      }
      projects.set(parsed.projectId, parsed);
      projectsByOrg.set(`${orgPrefix(parsed.orgId)}${parsed.projectId}`, parsed);
    },
    get: async (projectId: ProjectId) => projects.get(projectId),
    listByOrg: async (orgId: OrgId, page?: PageRequest) =>
      paginate(projectsByOrg.scan(orgPrefix(orgId)), page),
  };

  const programContractStore: ProgramContractStore = {
    put: async (contract) => {
      const parsed = ProgramContractSchema.parse(contract);
      programContracts.set(`${projectPrefix(parsed)}${parsed.programId}`, parsed);
    },
    get: async (projectId: ProjectId, programId: ProgramId) =>
      programContracts.get(`${projectPrefix({ projectId })}${programId}`),
    listByProject: async (projectId: ProjectId, page?: PageRequest) =>
      paginate(programContracts.scan(projectPrefix({ projectId })), page),
  };

  const runStore: RunStore = {
    put: async (run) => {
      const parsed = RunSchema.parse(run);
      runs.set(`${programPrefix(parsed)}${parsed.runId}`, parsed);
    },
    get: async (scope: ProgramScope, runId: RunId) => runs.get(`${programPrefix(scope)}${runId}`),
    listByProgram: async (scope: ProgramScope, page?: PageRequest) =>
      paginate(runs.scan(programPrefix(scope)), page),
  };

  const executionNodeStore: ExecutionNodeStore = {
    put: async (node) => {
      const parsed = ExecutionNodeSchema.parse(node);
      executionNodes.set(`${runPrefix(parsed)}${parsed.executionNodeId}`, parsed);
    },
    get: async (scope: RunScope, executionNodeId: ExecutionNodeId) =>
      executionNodes.get(`${runPrefix(scope)}${executionNodeId}`),
    listByRun: async (scope: RunScope, page?: PageRequest) =>
      paginate(executionNodes.scan(runPrefix(scope)), page),
    listChildren: async (scope: RunScope, parentNodeId: ExecutionNodeId) =>
      executionNodes.scan(runPrefix(scope)).filter((node) => node.parentNodeId === parentNodeId),
  };

  const jobContractStore: JobContractStore = {
    put: async (contract) => {
      const parsed = JobContractSchema.parse(contract);
      jobContracts.set(`${runPrefix(parsed)}${parsed.jobContractId}`, parsed);
    },
    get: async (scope: RunScope, jobContractId: JobContractId) =>
      jobContracts.get(`${runPrefix(scope)}${jobContractId}`),
    listByRun: async (scope: RunScope, page?: PageRequest) =>
      paginate(jobContracts.scan(runPrefix(scope)), page),
  };

  const agentStore: AgentStore = {
    put: async (agent) => {
      const parsed = AgentSchema.parse(agent);
      agents.set(`${runPrefix(parsed)}${parsed.agentId}`, parsed);
    },
    get: async (scope: RunScope, agentId: AgentId) => agents.get(`${runPrefix(scope)}${agentId}`),
    listByNode: async (scope: RunScope, executionNodeId: ExecutionNodeId) =>
      agents.scan(runPrefix(scope)).filter((agent) => agent.executionNodeId === executionNodeId),
  };

  const eventStore: EventStore = {
    append: async (event): Promise<AppendResult> => {
      const parsed = EventSchema.parse(event);
      const idempotencyKey = `${runPrefix(parsed)}${parsed.idempotencyKey}`;

      // Idempotent on the key within a run: a replayed local spool must converge
      // rather than double-count (A-06).
      return atomically((): AppendResult => {
        const existing = eventsByIdempotencyKey.get(idempotencyKey);
        if (existing !== undefined) return { stored: false, event: existing };

        const runKey = runPrefix(parsed);

        // Key by the event's ULID, matching the real adapter: the storage key cannot
        // depend on a sequence that may not exist yet.
        const key = `${runKey}${parsed.eventId}`;
        appendOrder.push(key);

        let sequence: number | null = null;
        if (!deferSequencing) {
          sequence = sequences.get(runKey) ?? 0;
          sequences.set(runKey, sequence + 1);
        }

        // Sequence is assigned by the store, never trusted from the caller.
        const stored: Event = { ...parsed, sequence };
        events.set(key, stored);
        eventsByIdempotencyKey.set(idempotencyKey, stored);
        return { stored: true, event: stored };
      });
    },
    listByRun: async (scope: RunScope, options?: PageRequest & { afterSequence?: number }) => {
      // Scan yields ULID order. Numbered events are then ordered by sequence, with
      // unnumbered ones last — see `orderEvents` in core.
      const scanned = events.scan(runPrefix(scope));
      const numbered = scanned
        .filter((e): e is Event & { sequence: number } => e.sequence !== null)
        .sort((a, b) => a.sequence - b.sequence);
      const unnumbered = scanned.filter((e) => e.sequence === null);
      const ordered = [...numbered, ...unnumbered];

      const after = options?.afterSequence;
      // A sequence cursor cannot see unnumbered events. That is the documented
      // trade (A-22): it lags rather than skipping.
      const filtered =
        after === undefined
          ? ordered
          : ordered.filter((e) => e.sequence !== null && e.sequence > after);
      return paginate(filtered, options);
    },
    nextSequence: async (scope: RunScope) => sequences.get(runPrefix(scope)) ?? 0,
  };

  const decisionStore: DecisionStore = {
    put: async (decision) => {
      const parsed = DecisionSchema.parse(decision);
      decisions.set(`${runPrefix(parsed)}${parsed.decisionId}`, parsed);
    },
    get: async (scope: RunScope, decisionId: DecisionId) =>
      decisions.get(`${runPrefix(scope)}${decisionId}`),
    listByRun: async (scope: RunScope, page?: PageRequest) =>
      paginate(decisions.scan(runPrefix(scope)), page),
  };

  const checkpointStore: CheckpointStore = {
    put: async (checkpoint) => {
      const parsed = CheckpointSchema.parse(checkpoint);
      checkpoints.set(`${runPrefix(parsed)}${parsed.checkpointId}`, parsed);
    },
    get: async (scope: RunScope, checkpointId: CheckpointId) =>
      checkpoints.get(`${runPrefix(scope)}${checkpointId}`),
    listByRun: async (scope: RunScope, page?: PageRequest) =>
      paginate(checkpoints.scan(runPrefix(scope)), page),
  };

  const verificationStore: VerificationStore = {
    put: async (verification) => {
      const parsed = VerificationSchema.parse(verification);
      verifications.set(`${runPrefix(parsed)}${parsed.verificationId}`, parsed);
    },
    get: async (scope: RunScope, verificationId: VerificationId) =>
      verifications.get(`${runPrefix(scope)}${verificationId}`),
    listByNode: async (scope: RunScope, executionNodeId: ExecutionNodeId) =>
      verifications
        .scan(runPrefix(scope))
        .filter((record) => record.executionNodeId === executionNodeId),
  };

  const examinationStore: ExaminationStore = {
    put: async (examination) => {
      const parsed = ExaminationSchema.parse(examination);
      examinations.set(`${runPrefix(parsed)}${parsed.examinationId}`, parsed);
    },
    get: async (scope: RunScope, examinationId: ExaminationId) =>
      examinations.get(`${runPrefix(scope)}${examinationId}`),
    listByNode: async (scope: RunScope, executionNodeId: ExecutionNodeId) =>
      examinations
        .scan(runPrefix(scope))
        .filter((record) => record.executionNodeId === executionNodeId),
  };

  const routingDecisionStore: RoutingDecisionStore = {
    put: async (decision) => {
      const parsed = RoutingDecisionSchema.parse(decision);
      routingDecisions.set(`${runPrefix(parsed)}${parsed.routingDecisionId}`, parsed);
    },
    listByNode: async (scope: RunScope, executionNodeId: ExecutionNodeId) =>
      routingDecisions
        .scan(runPrefix(scope))
        .filter((record) => record.executionNodeId === executionNodeId),
  };

  const artifactStore: ArtifactStore = {
    put: async (artifact) => {
      // The schema is strict and has no content field, so a record carrying
      // inline output is refused here. Large output belongs in S3 (A-08).
      const parsed = ArtifactSchema.parse(artifact);
      artifacts.set(`${runPrefix(parsed)}${parsed.artifactId}`, parsed);
    },
    get: async (scope: RunScope, artifactId: ArtifactId) =>
      artifacts.get(`${runPrefix(scope)}${artifactId}`),
    listByRun: async (scope: RunScope, page?: PageRequest) =>
      paginate(artifacts.scan(runPrefix(scope)), page),
  };

  const userStore: UserStore = {
    put: async (user) => {
      const parsed = UserSchema.parse(user);
      users.set(parsed.userId, parsed);
    },
    get: async (userId: UserId) => users.get(userId),
  };

  const membershipStore: MembershipStore = {
    put: async (membership) => {
      const parsed = MembershipSchema.parse(membership);
      memberships.set(`${userPrefix(parsed.userId)}${parsed.orgId}`, parsed);
    },
    listByUser: async (userId: UserId) => memberships.scan(userPrefix(userId)),
  };

  const orgConfigStore: OrgConfigStore = {
    get: async (orgId: OrgId) => orgConfigs.get(orgId),
    put: async (config) => {
      const parsed = OrgConfigSchema.parse(config);
      const stored = orgConfigs.get(parsed.orgId)?.version ?? 0;
      if (stored !== parsed.version - 1) {
        throw new StaleWriteError(
          `the configuration of ${parsed.orgId}`,
          parsed.version - 1,
          stored,
        );
      }
      orgConfigs.set(parsed.orgId, parsed);
    },
  };

  const dispatchStore: DispatchStore = {
    put: async (dispatch) => {
      const parsed = DispatchSchema.parse(dispatch);
      dispatches.set(runPrefix(parsed), parsed);
    },
    get: async (scope: RunScope) => dispatches.get(runPrefix(scope)),
    listByStatus: async (statuses) =>
      dispatches.all().filter((dispatch) => statuses.includes(dispatch.status)),
  };

  const computeUtilizationStore: ComputeUtilizationStore = {
    put: async (utilization) => {
      const parsed = ComputeUtilizationSchema.parse(utilization);
      // Keyed under the project so a project's runs list together, newest run
      // first: run ids are ULIDs, so the reversed scan is newest first.
      computeUtilizations.set(`${projectPrefix(parsed)}${parsed.runId}`, parsed);
    },
    get: async (scope: RunScope) =>
      computeUtilizations.get(`${projectPrefix(scope)}${scope.runId}`),
    listByProject: async (projectId: ProjectId, page?: PageRequest) =>
      paginate([...computeUtilizations.scan(projectPrefix({ projectId }))].reverse(), page),
  };

  const warmCacheStore: WarmCacheStore = {
    put: async (cache) => {
      const parsed = WarmCacheSchema.parse(cache);
      warmCaches.set(`${projectPrefix(parsed)}${parsed.architecture}`, parsed);
    },
    get: async (projectId: ProjectId, architecture: ComputeArchitecture) =>
      warmCaches.get(`${projectPrefix({ projectId })}${architecture}`),
  };

  const credentialsStore: CredentialsStore = {
    put: async (credential) => {
      const parsed = OrgCredentialSchema.parse(credential);
      credentials.set(`${orgPrefix(parsed.orgId)}${parsed.provider}`, parsed);
    },
    view: async (orgId: OrgId) =>
      credentials
        .scan(orgPrefix(orgId))
        .map(({ provider, lastFour, setAt }) => ({ provider, lastFour, setAt })),
    sealed: async (orgId: OrgId, provider: Provider) =>
      credentials.get(`${orgPrefix(orgId)}${provider}`),
  };

  const computeLedgerStore: ComputeLedgerStore = {
    get: async (orgId: OrgId, month: CalendarMonth) =>
      computeLedger.get(`${orgPrefix(orgId)}${month}`),
    put: async (usage) => {
      const parsed = OrgComputeUsageSchema.parse(usage);
      computeLedger.set(`${orgPrefix(parsed.orgId)}${parsed.month}`, parsed);
    },
  };

  return {
    projects: projectStore,
    programContracts: programContractStore,
    runs: runStore,
    executionNodes: executionNodeStore,
    jobContracts: jobContractStore,
    agents: agentStore,
    events: eventStore,
    decisions: decisionStore,
    checkpoints: checkpointStore,
    verifications: verificationStore,
    examinations: examinationStore,
    routingDecisions: routingDecisionStore,
    artifacts: artifactStore,
    users: userStore,
    memberships: membershipStore,
    orgConfigs: orgConfigStore,
    dispatches: dispatchStore,
    computeUtilizations: computeUtilizationStore,
    warmCaches: warmCacheStore,
    credentials: credentialsStore,
    computeLedger: computeLedgerStore,
    sequenceLedger: {
      stamp: async (scope, eventId) => stampStored(`${runPrefix(scope)}${eventId}`),
    },
    clear: () => {
      for (const store of all) store.clear();
      sequences.clear();
      appendOrder.length = 0;
    },
    materializeSequences: () => {
      // Append order, so numbering matches the order an ordered stream consumer
      // would see.
      let stamped = 0;
      for (const key of appendOrder) {
        if (stampStored(key).kind === "stamped") stamped += 1;
      }
      return stamped;
    },
    get size() {
      return all.reduce((total, store) => total + store.size, 0);
    },
  };
};

export * from "./scoped-map.js";
export type { Page, PageRequest };
