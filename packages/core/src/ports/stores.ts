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
 * - **Event appends are idempotent.** `append` reports whether it stored a new
 *   event or found an existing one with the same key, so a replayed local spool
 *   converges (A-06).
 */
import type {
  Agent,
  AgentId,
  Artifact,
  ArtifactId,
  Checkpoint,
  CheckpointId,
  Decision,
  DecisionId,
  Event,
  Examination,
  ExaminationId,
  ExecutionNode,
  ExecutionNodeId,
  JobContract,
  JobContractId,
  ProgramContract,
  ProgramId,
  Project,
  ProjectId,
  RoutingDecision,
  Run,
  RunId,
  Verification,
  VerificationId,
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
  put(project: Project): Promise<void>;
  get(projectId: ProjectId): Promise<Project | undefined>;
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
   * Appends `event`, assigning it the next sequence for its run.
   *
   * Idempotent on `idempotencyKey` within a run: a duplicate submission returns
   * the previously stored event and does not advance the sequence.
   */
  append(event: Event): Promise<AppendResult>;
  /** Events in ascending `sequence` order. Ordering must be stable across calls. */
  listByRun(
    scope: RunScope,
    options?: PageRequest & { readonly afterSequence?: number },
  ): Promise<Page<Event>>;
  /** The sequence the next append to this run will receive. */
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
 * Everything the control plane persists, in one injectable bundle. The execution
 * layer depends on this interface; only an application wires a concrete set.
 */
export interface NightshiftStores {
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
}
