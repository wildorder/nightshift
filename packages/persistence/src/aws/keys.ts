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
import type { OrgId, ProgramId, ProjectId, RunId, UserId } from "@nightshift/contracts";
import type { ProgramScope, RunScope } from "@nightshift/core";

export interface TableKey {
  readonly PK: string;
  readonly SK: string;
}

export interface NodeIndexKey {
  readonly GSI1PK: string;
  readonly GSI1SK: string;
}

/** The one GSI (§4.2). Its name is part of the contract, not a CDK-generated value. */
export const NODE_INDEX_NAME = "gsi_node";

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
  artifact: "ART",
} as const;

export type RunRecordType = (typeof RUN_RECORD_TYPES)[keyof typeof RUN_RECORD_TYPES];

/** `CHILD` is what an execution node writes into its parent's index partition (§4.2). */
export type NodeIndexType = Exclude<RunRecordType, "NODE" | "JOB"> | "CHILD";

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

  idempotency: (scope: RunScope, idempotencyKey: string): TableKey => ({
    PK: `EVT#${runChain(scope)}`,
    SK: `${IDEMPOTENCY_SORT_PREFIX}${idempotencyKey}`,
  }),
} as const;

/** The S3 key prefix for a run's artifacts: `<projectId>/<programId>/<runId>/` (D-P2-08). */
export const artifactPrefix = (scope: RunScope): string =>
  `${scope.projectId}/${scope.programId}/${scope.runId}/`;
