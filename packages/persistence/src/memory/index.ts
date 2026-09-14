/**
 * In-memory persistence adapter — **test use only** (D-P1-08).
 *
 * This exists so `execution` and everything above it can be tested offline from
 * P3 onward without standing up AWS. It is emphatically *not* a local canonical
 * store: A-06 says there is one authoritative control plane, and a local
 * database beside it is explicitly out of scope for v1.
 *
 * Two behaviours are load-bearing and are asserted by the shared conformance
 * suite, which the DynamoDB adapter will have to pass unchanged:
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
  type Checkpoint,
  type CheckpointId,
  CheckpointSchema,
  type Decision,
  type DecisionId,
  DecisionSchema,
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
  type ProgramContract,
  ProgramContractSchema,
  type ProgramId,
  type Project,
  type ProjectId,
  ProjectSchema,
  type RoutingDecision,
  RoutingDecisionSchema,
  type Run,
  type RunId,
  RunSchema,
  type Verification,
  type VerificationId,
  VerificationSchema,
} from "@nightshift/contracts";
import type {
  AgentStore,
  AppendResult,
  ArtifactStore,
  CheckpointStore,
  DecisionStore,
  EventStore,
  ExaminationStore,
  ExecutionNodeStore,
  JobContractStore,
  NightshiftStores,
  Page,
  PageRequest,
  ProgramContractStore,
  ProgramScope,
  ProjectStore,
  RoutingDecisionStore,
  RunScope,
  RunStore,
  VerificationStore,
} from "@nightshift/core";
import { paginate, programPrefix, projectPrefix, runPrefix, ScopedMap } from "./scoped-map.js";

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
}

export interface InMemoryOptions {
  /**
   * Leave `sequence` null on append, until `materializeSequences()` is called.
   * Off by default, so the adapter behaves synchronously unless a test is
   * deliberately exercising the lag.
   */
  readonly deferSequencing?: boolean;
}

export interface InMemoryStores extends NightshiftStores, InMemoryState {}

export const createInMemoryStores = (options: InMemoryOptions = {}): InMemoryStores => {
  const deferSequencing = options.deferSequencing ?? false;
  const projects = new ScopedMap<Project>();
  const programContracts = new ScopedMap<ProgramContract>();
  const runs = new ScopedMap<Run>();
  const executionNodes = new ScopedMap<ExecutionNode>();
  const jobContracts = new ScopedMap<JobContract>();
  const agents = new ScopedMap<Agent>();
  const events = new ScopedMap<Event>();
  const eventsByIdempotencyKey = new ScopedMap<Event>();
  const decisions = new ScopedMap<Decision>();
  const checkpoints = new ScopedMap<Checkpoint>();
  const verifications = new ScopedMap<Verification>();
  const examinations = new ScopedMap<Examination>();
  const routingDecisions = new ScopedMap<RoutingDecision>();
  const artifacts = new ScopedMap<Artifact>();

  const all = [
    projects,
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
  ];

  /** Sequence counters, one per run. Never reused, so ordering is total. */
  const sequences = new Map<string, number>();
  /** Per-run arrival count, and global append order, for deferred numbering. */
  const arrivals = new Map<string, number>();
  const appendOrder: string[] = [];

  const projectStore: ProjectStore = {
    put: async (project) => {
      const parsed = ProjectSchema.parse(project);
      projects.set(parsed.projectId, parsed);
    },
    get: async (projectId: ProjectId) => projects.get(projectId),
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
      const existing = eventsByIdempotencyKey.get(idempotencyKey);
      if (existing !== undefined) return { stored: false, event: existing };

      const runKey = runPrefix(parsed);

      // Key by the event's ULID, matching the real adapter: the storage key cannot
      // depend on a sequence that may not exist yet.
      const key = `${runKey}${parsed.eventId}`;
      const arrival = (arrivals.get(runKey) ?? 0) + 1;
      arrivals.set(runKey, arrival);
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
    },
    listByRun: async (scope: RunScope, options?: PageRequest & { afterSequence?: number }) => {
      // Scan yields ULID order, which is append order. Numbered events are then
      // ordered by sequence, with unnumbered ones last — see `orderEvents` in core.
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
    clear: () => {
      for (const store of all) store.clear();
      sequences.clear();
      arrivals.clear();
      appendOrder.length = 0;
    },
    materializeSequences: () => {
      let stamped = 0;
      // Append order, so numbering matches the order an ordered stream consumer
      // would see. Per run, because sequences are per run.
      for (const key of appendOrder) {
        const event = events.get(key);
        if (event === undefined || event.sequence !== null) continue;
        const runKey = runPrefix(event);
        const next = sequences.get(runKey) ?? 0;
        sequences.set(runKey, next + 1);
        events.set(key, { ...event, sequence: next });
        const idemKey = `${runKey}${event.idempotencyKey}`;
        eventsByIdempotencyKey.set(idemKey, { ...event, sequence: next });
        stamped += 1;
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
