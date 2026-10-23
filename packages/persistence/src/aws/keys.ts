/**
 * The single-table key schema (contract §4.1, §4.2; D-P2-02, D-P2-03, D-P2-17).
 *
 * Every key the DynamoDB adapter reads or writes is built here and nowhere else,
 * so the table in the contract and the code cannot drift apart silently: a new key
 * shape is a new function in this file, which is where review looks for one.
 *
 * `PK` always begins with a project, except for the identity rows that D-P2-17
 * places above every project. Composite values use `#` as a separator, which is
 * safe because no identifier or Cognito subject can contain one (both are
 * validated by the contracts before a key is ever built).
 */
import type {
  CalendarMonth,
  ComputeArchitecture,
  DispatchStatus,
  OrgId,
  ProgramId,
  ProjectId,
  Provider,
  RunId,
  UserId,
} from "@nightshift/contracts";
import type { ProgramScope, RunScope } from "@nightshift/core";

export interface TableKey {
  readonly PK: string;
  readonly SK: string;
}

export interface NodeIndexKey {
  readonly GSI1PK: string;
  readonly GSI1SK: string;
}

/** The node GSI (§4.2). Its name is part of the contract, not a CDK-generated value. */
export const NODE_INDEX_NAME = "gsi_node";

/**
 * The event-sequence GSI (2026-10-22): a run's events by `sequence`, so a reader
 * from sequence N reads what follows N and nothing before it. Sparse: an event
 * gains these two attributes when the materializer numbers it, and only then
 * appears in the index. Without it every page of a run's events, every poll from
 * a sequence and every full read paged by the API read the run's whole event
 * partition: P20's first run read ~2.25 million items per full read at 15,000
 * events, and the month's DynamoDB bill was $105 of reads.
 */
export const EVENT_SEQUENCE_INDEX_NAME = "gsi_event_sequence";
/** The index's partition key: the event's own `PK`, the run's event partition. */
export const EVENT_SEQUENCE_PARTITION_ATTRIBUTE = "SEQPK";
/** The index's sort key, a number: the event's `sequence`. */
export const EVENT_SEQUENCE_ATTRIBUTE = "SEQ";

/** Sort-key prefixes for run-scoped records, one per aggregate (§4.1). */
export const RUN_RECORD_TYPES = {
  executionNode: "NODE",
  jobContract: "JOB",
  agent: "AGENT",
  decision: "DEC",
  checkpoint: "CKPT",
  verification: "VER",
  examination: "EXAM",
  routingDecision: "ROUTE",
  measurement: "MEAS",
  artifact: "ART",
} as const;

export type RunRecordType = (typeof RUN_RECORD_TYPES)[keyof typeof RUN_RECORD_TYPES];

/** `CHILD` is what an execution node writes into its parent's index partition (§4.2). */
export type NodeIndexType = Exclude<RunRecordType, "NODE" | "JOB"> | "CHILD" | "EVT";

const runChain = (scope: RunScope): string =>
  `${scope.projectId}#${scope.programId}#${scope.runId}`;

export const EVENT_SORT_PREFIX = "ULID#";
export const COUNTER_SORT_KEY = "COUNTER";
export const IDEMPOTENCY_SORT_PREFIX = "IDEM#";

export const keys = {
  user: (userId: UserId): TableKey => ({ PK: `USER#${userId}`, SK: "META" }),

  membership: (userId: UserId, orgId: OrgId): TableKey => ({
    PK: `USER#${userId}`,
    SK: `MEMBER#${orgId}`,
  }),

  membershipPartition: (userId: UserId) => ({ PK: `USER#${userId}`, prefix: "MEMBER#" }),

  project: (projectId: ProjectId): TableKey => ({ PK: `PROJ#${projectId}`, SK: "META" }),

  orgProject: (orgId: OrgId, projectId: ProjectId): TableKey => ({
    PK: `ORG#${orgId}`,
    SK: `PROJ#${projectId}`,
  }),

  orgProjectPartition: (orgId: OrgId) => ({ PK: `ORG#${orgId}`, prefix: "PROJ#" }),

  /** An org's routing and examination policy (P8, D-P8-02). One row per org. */
  orgConfig: (orgId: OrgId): TableKey => ({ PK: `ORG#${orgId}`, SK: "CONFIG" }),

  /** An org's compute ledger for one month (P10, D-P10-19). */
  computeUsage: (orgId: OrgId, month: CalendarMonth): TableKey => ({
    PK: `ORG#${orgId}`,
    SK: `USAGE#${month}`,
  }),

  /**
   * An org's sealed provider key (P10, D-P10-23). In the **credentials table**,
   * never the main one: the only key shape that names another table.
   */
  credential: (orgId: OrgId, provider: Provider): TableKey => ({
    PK: `ORG#${orgId}`,
    SK: `PROVIDER#${provider}`,
  }),

  credentialPartition: (orgId: OrgId) => ({ PK: `ORG#${orgId}`, prefix: "PROVIDER#" }),

  /** A run's dispatch (P10, D-P10-18): one row beside the run's records. */
  dispatch: (scope: RunScope): TableKey => ({ PK: `RUN#${runChain(scope)}`, SK: "DISPATCH" }),

  /**
   * The reconciler's view of every dispatch by status (P10, D-P10-18), on the
   * one index: `gsi_node` carries a dispatch under its status as it carries a
   * node under its parent. The sort key orders by last update, oldest first.
   */
  dispatchIndex: (status: DispatchStatus, updatedAt: string, runId: RunId): NodeIndexKey => ({
    GSI1PK: `DISPATCH#${status}`,
    GSI1SK: `${updatedAt}#${runId}`,
  }),

  dispatchIndexPartition: (status: DispatchStatus) => ({
    GSI1PK: `DISPATCH#${status}`,
    prefix: "",
  }),

  /** A run's machine utilization (P10, D-P10-14b), under the project so a project's list together. */
  computeUtilization: (projectId: ProjectId, runId: RunId): TableKey => ({
    PK: `PROJ#${projectId}`,
    SK: `UTIL#${runId}`,
  }),

  computeUtilizationPartition: (projectId: ProjectId) => ({
    PK: `PROJ#${projectId}`,
    prefix: "UTIL#",
  }),

  /** The publisher's lock on a run's intents (P10, D-P10-22): one row per run, with an expiry. */
  publishLock: (runId: RunId): TableKey => ({ PK: `RUN#${runId}`, SK: "PUBLISH-LOCK" }),

  /** Which org holds a GitHub App installation (P10, D-P10-02): one row per installation. */
  installationClaim: (installationId: number): TableKey => ({
    PK: `INSTALL#${installationId}`,
    SK: "CLAIM",
  }),

  /** A project's warm snapshot (P10, D-P10-15), one per architecture. */
  warmCache: (projectId: ProjectId, architecture: ComputeArchitecture): TableKey => ({
    PK: `PROJ#${projectId}`,
    SK: `CACHE#${architecture}`,
  }),

  /** A project's gate-health record (P15, D-P15-07): one row per project. */
  gateHealth: (projectId: ProjectId): TableKey => ({
    PK: `PROJ#${projectId}`,
    SK: "GATE-HEALTH",
  }),

  /** A run's feedback (P20, D-04): one row per run, beside the runs of its program. */
  feedback: (scope: RunScope): TableKey => ({
    PK: `PROJ#${scope.projectId}#PROG#${scope.programId}`,
    SK: `FEEDBACK#${scope.runId}`,
  }),

  feedbackPartition: (scope: ProgramScope) => ({
    PK: `PROJ#${scope.projectId}#PROG#${scope.programId}`,
    prefix: "FEEDBACK#",
  }),

  /** A completion history (P20, D-05), under its project so it never crosses one. */
  completionHistory: (projectId: ProjectId, id: string): TableKey => ({
    PK: `PROJ#${projectId}`,
    SK: `COMPLETION#${id}`,
  }),

  completionPartition: (projectId: ProjectId) => ({
    PK: `PROJ#${projectId}`,
    prefix: "COMPLETION#",
  }),

  programContract: (projectId: ProjectId, programId: ProgramId): TableKey => ({
    PK: `PROJ#${projectId}`,
    SK: `PROG#${programId}`,
  }),

  programContractPartition: (projectId: ProjectId) => ({
    PK: `PROJ#${projectId}`,
    prefix: "PROG#",
  }),

  run: (scope: ProgramScope, runId: RunId): TableKey => ({
    PK: `PROJ#${scope.projectId}#PROG#${scope.programId}`,
    SK: `RUN#${runId}`,
  }),

  runPartition: (scope: ProgramScope) => ({
    PK: `PROJ#${scope.projectId}#PROG#${scope.programId}`,
    prefix: "RUN#",
  }),

  runRecord: (scope: RunScope, type: RunRecordType, id: string): TableKey => ({
    PK: `RUN#${runChain(scope)}`,
    SK: `${type}#${id}`,
  }),

  runRecordPartition: (scope: RunScope, type: RunRecordType) => ({
    PK: `RUN#${runChain(scope)}`,
    prefix: `${type}#`,
  }),

  nodeIndex: (scope: RunScope, nodeId: string, type: NodeIndexType, id: string): NodeIndexKey => ({
    GSI1PK: `NODE#${runChain(scope)}#${nodeId}`,
    GSI1SK: `${type}#${id}`,
  }),

  nodeIndexPartition: (scope: RunScope, nodeId: string, type: NodeIndexType) => ({
    GSI1PK: `NODE#${runChain(scope)}#${nodeId}`,
    prefix: `${type}#`,
  }),

  event: (scope: RunScope, eventId: string): TableKey => ({
    PK: `EVT#${runChain(scope)}`,
    SK: `${EVENT_SORT_PREFIX}${eventId}`,
  }),

  eventPartition: (scope: RunScope) => ({
    PK: `EVT#${runChain(scope)}`,
    prefix: EVENT_SORT_PREFIX,
  }),

  counter: (scope: RunScope): TableKey => ({ PK: `EVT#${runChain(scope)}`, SK: COUNTER_SORT_KEY }),

  /**
   * An event's place in the node index (2026-10-22): under its node, by type,
   * then identifier, so a reader of one kind of a node's events starts and
   * stops at that kind. A run-level event (no node) is not in it.
   */
  eventByNode: (scope: RunScope, nodeId: string, type: string, eventId: string): NodeIndexKey => ({
    GSI1PK: `NODE#${runChain(scope)}#${nodeId}`,
    GSI1SK: `EVT#${type}#${eventId}`,
  }),

  idempotency: (scope: RunScope, idempotencyKey: string): TableKey => ({
    PK: `EVT#${runChain(scope)}`,
    SK: `${IDEMPOTENCY_SORT_PREFIX}${idempotencyKey}`,
  }),
} as const;

/** The S3 key prefix for a run's artifacts: `<projectId>/<programId>/<runId>/` (D-P2-08). */
export const artifactPrefix = (scope: RunScope): string =>
  `${scope.projectId}/${scope.programId}/${scope.runId}/`;
