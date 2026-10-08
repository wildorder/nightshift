/**
 * Every `@nightshift/core` port on the single DynamoDB table (contract §4, T3).
 *
 * The in-memory adapter is the reference behaviour, and the shared conformance
 * suite is the specification this module is held to. Keys come only from
 * `keys.ts`; records are re-parsed through their schemas on the way in and out.
 */
import {
  AgentSchema,
  ArtifactSchema,
  CheckpointSchema,
  ComputeUtilizationSchema,
  DecisionSchema,
  type Dispatch,
  DispatchSchema,
  ExaminationSchema,
  ExecutionNodeSchema,
  GateHealthSchema,
  JobContractSchema,
  MembershipSchema,
  OrgComputeUsageSchema,
  OrgConfigSchema,
  OrgCredentialSchema,
  type OrgId,
  ProgramContractSchema,
  ProjectSchema,
  RoutingDecisionSchema,
  RunSchema,
  UserSchema,
  VerificationSchema,
  WarmCacheSchema,
} from "@nightshift/contracts";
import {
  type CredentialsStore,
  type NightshiftStores,
  OwnershipViolationError,
  type Page,
  type PageRequest,
  type ProjectStore,
  runScopeOf,
  StaleWriteError,
} from "@nightshift/core";
import { createEventStore } from "./events.js";
import { fromItem, type Item, type Parser, toItem } from "./items.js";
import { keys, type NodeIndexKey, type TableKey } from "./keys.js";
import { type PartitionQuery, queryAll, queryPage } from "./query.js";
import { conditionFailures, isConditionalCheckFailure, type TableClient } from "./table-client.js";

export interface AwsStoresConfig {
  readonly tableName: string;
  readonly table: TableClient;
  /**
   * The credentials table (P10, D-P10-23): an org's sealed provider keys, in a
   * table of their own with no stream and one reader. Absent until the data
   * stack deploys it (T2); the credentials store then refuses every call by
   * name rather than writing a key into the main table.
   */
  readonly credentialsTableName?: string;
}

/** The credentials table was not configured. The API answers 501 for it. */
export class CredentialsTableUnavailableError extends Error {
  override readonly name = "CredentialsTableUnavailableError";
  constructor() {
    super(
      "this control plane has no credentials table configured (NIGHTSHIFT_CREDENTIALS_TABLE_NAME)",
    );
  }
}

const noCredentialsTable = async (): Promise<never> => {
  throw new CredentialsTableUnavailableError();
};

export const createAwsStores = ({
  tableName,
  table,
  credentialsTableName,
}: AwsStoresConfig): NightshiftStores => {
  const getRecord = async <T>(schema: Parser<T>, key: TableKey): Promise<T | undefined> => {
    const output = await table.get({ TableName: tableName, Key: key, ConsistentRead: true });
    return output.Item === undefined ? undefined : fromItem(schema, output.Item);
  };

  const putRecord = async (
    entity: string,
    key: TableKey,
    record: object,
    index?: NodeIndexKey,
  ): Promise<void> => {
    await table.put({ TableName: tableName, Item: toItem(entity, key, record, index) });
  };

  const listPage = async <T>(
    schema: Parser<T>,
    query: PartitionQuery,
    page?: PageRequest,
  ): Promise<Page<T>> => {
    const result = await queryPage(table, tableName, query, page);
    const items = result.items.map((item: Item) => fromItem(schema, item));
    return result.cursor === undefined ? { items } : { items, cursor: result.cursor };
  };

  const listAll = async <T>(schema: Parser<T>, query: PartitionQuery): Promise<readonly T[]> =>
    (await queryAll(table, tableName, query)).map((item) => fromItem(schema, item));

  // The credentials table (D-P10-23). Same client, another table name, and the
  // only reads and writes that ever name it.
  const credentials: CredentialsStore =
    credentialsTableName === undefined
      ? { put: noCredentialsTable, view: noCredentialsTable, sealed: noCredentialsTable }
      : {
          put: async (credential) => {
            const parsed = OrgCredentialSchema.parse(credential);
            await table.put({
              TableName: credentialsTableName,
              Item: toItem("OrgCredential", keys.credential(parsed.orgId, parsed.provider), parsed),
            });
          },
          view: async (orgId) => {
            const partition = keys.credentialPartition(orgId);
            const items = await queryAll(table, credentialsTableName, {
              partition: partition.PK,
              prefix: partition.prefix,
            });
            return items
              .map((item) => fromItem(OrgCredentialSchema, item))
              .map(({ provider, lastFour, setAt }) => ({ provider, lastFour, setAt }));
          },
          sealed: async (orgId, provider) => {
            const output = await table.get({
              TableName: credentialsTableName,
              Key: keys.credential(orgId, provider),
              ConsistentRead: true,
            });
            return output.Item === undefined
              ? undefined
              : fromItem(OrgCredentialSchema, output.Item);
          },
        };

  /** A table partition from a key helper. */
  const inTable = (p: { readonly PK: string; readonly prefix: string }): PartitionQuery => ({
    partition: p.PK,
    prefix: p.prefix,
  });

  /** A `gsi_node` partition from a key helper. */
  const inIndex = (p: { readonly GSI1PK: string; readonly prefix: string }): PartitionQuery => ({
    partition: p.GSI1PK,
    prefix: p.prefix,
    index: true,
  });

  const projects: ProjectStore = {
    put: async (project) => {
      const parsed = ProjectSchema.parse(project);
      try {
        // The project and its org listing are written together, and only if the
        // project is new or already in this org. Moving orgs would strand the old
        // listing, so it is refused atomically rather than half-applied.
        await table.transactWrite({
          TransactItems: [
            {
              Put: {
                TableName: tableName,
                Item: toItem("Project", keys.project(parsed.projectId), parsed),
                ConditionExpression: "attribute_not_exists(#pk) OR #orgId = :orgId",
                ExpressionAttributeNames: { "#pk": "PK", "#orgId": "orgId" },
                ExpressionAttributeValues: { ":orgId": parsed.orgId },
              },
            },
            {
              Put: {
                TableName: tableName,
                Item: toItem("Project", keys.orgProject(parsed.orgId, parsed.projectId), parsed),
              },
            },
          ],
        });
      } catch (error) {
        if (conditionFailures(error)?.[0] !== true) throw error;
        const existing = await getRecord(ProjectSchema, keys.project(parsed.projectId));
        throw new OwnershipViolationError("orgId", existing?.orgId ?? "unknown", parsed.orgId);
      }
    },
    get: (projectId) => getRecord(ProjectSchema, keys.project(projectId)),
    listByOrg: (orgId, page) =>
      listPage(ProjectSchema, inTable(keys.orgProjectPartition(orgId)), page),
  };

  return {
    projects,
    credentials,

    // P10 (D-P10-19): one row per org and month, read to refuse a dispatch.
    computeLedger: {
      get: (orgId, month) => getRecord(OrgComputeUsageSchema, keys.computeUsage(orgId, month)),
      put: async (usage) => {
        const parsed = OrgComputeUsageSchema.parse(usage);
        await putRecord("OrgComputeUsage", keys.computeUsage(parsed.orgId, parsed.month), parsed);
      },
    },

    // P10 (D-P10-18): one dispatch per run, a row beside the run's records.
    dispatches: {
      put: async (dispatch) => {
        const parsed = DispatchSchema.parse(dispatch);
        await putRecord(
          "Dispatch",
          keys.dispatch(runScopeOf(parsed)),
          parsed,
          keys.dispatchIndex(parsed.status, parsed.updatedAt, parsed.runId),
        );
      },
      get: (scope) => getRecord(DispatchSchema, keys.dispatch(scope)),
      listByStatus: async (statuses) => {
        const found: Dispatch[] = [];
        for (const status of statuses) {
          found.push(
            ...(await listAll(DispatchSchema, inIndex(keys.dispatchIndexPartition(status)))),
          );
        }
        return found;
      },
    },

    // P10 (D-P10-14b): under the project, newest run first.
    computeUtilizations: {
      put: async (utilization) => {
        const parsed = ComputeUtilizationSchema.parse(utilization);
        await putRecord(
          "ComputeUtilization",
          keys.computeUtilization(parsed.projectId, parsed.runId),
          parsed,
        );
      },
      get: (scope) =>
        getRecord(ComputeUtilizationSchema, keys.computeUtilization(scope.projectId, scope.runId)),
      listByProject: (projectId, page) =>
        listPage(
          ComputeUtilizationSchema,
          { ...inTable(keys.computeUtilizationPartition(projectId)), descending: true },
          page,
        ),
    },

    // P10 (D-P10-15): one per project and architecture.
    warmCaches: {
      put: async (cache) => {
        const parsed = WarmCacheSchema.parse(cache);
        await putRecord("WarmCache", keys.warmCache(parsed.projectId, parsed.architecture), parsed);
      },
      get: (projectId, architecture) =>
        getRecord(WarmCacheSchema, keys.warmCache(projectId, architecture)),
      delete: async (projectId, architecture) => {
        await table.delete({ TableName: tableName, Key: keys.warmCache(projectId, architecture) });
      },
    },

    // P15 (D-P15-07): one per project, replaced by each put.
    gateHealth: {
      put: async (record) => {
        const parsed = GateHealthSchema.parse(record);
        await putRecord("GateHealth", keys.gateHealth(parsed.projectId), parsed);
      },
      get: (projectId) => getRecord(GateHealthSchema, keys.gateHealth(projectId)),
    },

    installationClaims: {
      claim: async (installationId, orgId, at) => {
        const key = keys.installationClaim(installationId);
        try {
          await table.put({
            TableName: tableName,
            Item: toItem("InstallationClaim", key, { installationId, orgId, at }),
            ConditionExpression: "attribute_not_exists(#pk) OR #orgId = :orgId",
            ExpressionAttributeNames: { "#pk": "PK", "#orgId": "orgId" },
            ExpressionAttributeValues: { ":orgId": orgId },
          });
          return { ok: true };
        } catch (error) {
          if (!isConditionalCheckFailure(error)) throw error;
          const held = await table.get({ TableName: tableName, Key: key });
          const heldBy = (held.Item as { orgId?: string } | undefined)?.orgId;
          if (heldBy === undefined) throw error;
          return { ok: false, heldBy: heldBy as OrgId };
        }
      },
      release: async (installationId, orgId) => {
        try {
          await table.delete({
            TableName: tableName,
            Key: keys.installationClaim(installationId),
            ConditionExpression: "#orgId = :orgId",
            ExpressionAttributeNames: { "#orgId": "orgId" },
            ExpressionAttributeValues: { ":orgId": orgId },
          });
        } catch (error) {
          // Absent, or another org's: nothing of this org's to hand back.
          if (!isConditionalCheckFailure(error)) throw error;
        }
      },
    },

    programContracts: {
      put: async (contract) => {
        const parsed = ProgramContractSchema.parse(contract);
        await putRecord(
          "ProgramContract",
          keys.programContract(parsed.projectId, parsed.programId),
          parsed,
        );
      },
      get: (projectId, programId) =>
        getRecord(ProgramContractSchema, keys.programContract(projectId, programId)),
      listByProject: (projectId, page) =>
        listPage(ProgramContractSchema, inTable(keys.programContractPartition(projectId)), page),
    },

    runs: {
      put: async (run) => {
        const parsed = RunSchema.parse(run);
        await putRecord("Run", keys.run(parsed, parsed.runId), parsed);
      },
      get: (scope, runId) => getRecord(RunSchema, keys.run(scope, runId)),
      listByProgram: (scope, page) => listPage(RunSchema, inTable(keys.runPartition(scope)), page),
    },

    executionNodes: {
      put: async (node) => {
        const parsed = ExecutionNodeSchema.parse(node);
        const scope = runScopeOf(parsed);
        // A node indexes itself under its parent, so one GSI query lists children (§4.2).
        const index =
          parsed.parentNodeId === null
            ? undefined
            : keys.nodeIndex(scope, parsed.parentNodeId, "CHILD", parsed.executionNodeId);
        await putRecord(
          "ExecutionNode",
          keys.runRecord(scope, "NODE", parsed.executionNodeId),
          parsed,
          index,
        );
      },
      get: (scope, id) => getRecord(ExecutionNodeSchema, keys.runRecord(scope, "NODE", id)),
      listByRun: (scope, page) =>
        listPage(ExecutionNodeSchema, inTable(keys.runRecordPartition(scope, "NODE")), page),
      listChildren: (scope, parentNodeId) =>
        listAll(
          ExecutionNodeSchema,
          inIndex(keys.nodeIndexPartition(scope, parentNodeId, "CHILD")),
        ),
    },

    jobContracts: {
      put: async (contract) => {
        const parsed = JobContractSchema.parse(contract);
        await putRecord(
          "JobContract",
          keys.runRecord(runScopeOf(parsed), "JOB", parsed.jobContractId),
          parsed,
        );
      },
      get: (scope, id) => getRecord(JobContractSchema, keys.runRecord(scope, "JOB", id)),
      listByRun: (scope, page) =>
        listPage(JobContractSchema, inTable(keys.runRecordPartition(scope, "JOB")), page),
    },

    agents: {
      put: async (agent) => {
        const parsed = AgentSchema.parse(agent);
        const scope = runScopeOf(parsed);
        await putRecord(
          "Agent",
          keys.runRecord(scope, "AGENT", parsed.agentId),
          parsed,
          keys.nodeIndex(scope, parsed.executionNodeId, "AGENT", parsed.agentId),
        );
      },
      get: (scope, id) => getRecord(AgentSchema, keys.runRecord(scope, "AGENT", id)),
      listByNode: (scope, nodeId) =>
        listAll(AgentSchema, inIndex(keys.nodeIndexPartition(scope, nodeId, "AGENT"))),
    },

    events: createEventStore({ tableName, table }),

    decisions: {
      put: async (decision) => {
        const parsed = DecisionSchema.parse(decision);
        const scope = runScopeOf(parsed);
        await putRecord(
          "Decision",
          keys.runRecord(scope, "DEC", parsed.decisionId),
          parsed,
          keys.nodeIndex(scope, parsed.executionNodeId, "DEC", parsed.decisionId),
        );
      },
      get: (scope, id) => getRecord(DecisionSchema, keys.runRecord(scope, "DEC", id)),
      listByRun: (scope, page) =>
        listPage(DecisionSchema, inTable(keys.runRecordPartition(scope, "DEC")), page),
    },

    checkpoints: {
      put: async (checkpoint) => {
        const parsed = CheckpointSchema.parse(checkpoint);
        // Not in the §4.2 list of node-indexed records, so no GSI attributes.
        await putRecord(
          "Checkpoint",
          keys.runRecord(runScopeOf(parsed), "CKPT", parsed.checkpointId),
          parsed,
        );
      },
      get: (scope, id) => getRecord(CheckpointSchema, keys.runRecord(scope, "CKPT", id)),
      listByRun: (scope, page) =>
        listPage(CheckpointSchema, inTable(keys.runRecordPartition(scope, "CKPT")), page),
    },

    verifications: {
      put: async (verification) => {
        const parsed = VerificationSchema.parse(verification);
        const scope = runScopeOf(parsed);
        await putRecord(
          "Verification",
          keys.runRecord(scope, "VER", parsed.verificationId),
          parsed,
          keys.nodeIndex(scope, parsed.executionNodeId, "VER", parsed.verificationId),
        );
      },
      get: (scope, id) => getRecord(VerificationSchema, keys.runRecord(scope, "VER", id)),
      listByNode: (scope, nodeId) =>
        listAll(VerificationSchema, inIndex(keys.nodeIndexPartition(scope, nodeId, "VER"))),
    },

    examinations: {
      put: async (examination) => {
        const parsed = ExaminationSchema.parse(examination);
        const scope = runScopeOf(parsed);
        await putRecord(
          "Examination",
          keys.runRecord(scope, "EXAM", parsed.examinationId),
          parsed,
          keys.nodeIndex(scope, parsed.executionNodeId, "EXAM", parsed.examinationId),
        );
      },
      get: (scope, id) => getRecord(ExaminationSchema, keys.runRecord(scope, "EXAM", id)),
      listByNode: (scope, nodeId) =>
        listAll(ExaminationSchema, inIndex(keys.nodeIndexPartition(scope, nodeId, "EXAM"))),
    },

    routingDecisions: {
      put: async (decision) => {
        const parsed = RoutingDecisionSchema.parse(decision);
        const scope = runScopeOf(parsed);
        await putRecord(
          "RoutingDecision",
          keys.runRecord(scope, "ROUTE", parsed.routingDecisionId),
          parsed,
          keys.nodeIndex(scope, parsed.executionNodeId, "ROUTE", parsed.routingDecisionId),
        );
      },
      listByNode: (scope, nodeId) =>
        listAll(RoutingDecisionSchema, inIndex(keys.nodeIndexPartition(scope, nodeId, "ROUTE"))),
    },

    artifacts: {
      put: async (artifact) => {
        // Strict schema, no content field: inline output is refused here (A-08).
        const parsed = ArtifactSchema.parse(artifact);
        const scope = runScopeOf(parsed);
        await putRecord(
          "Artifact",
          keys.runRecord(scope, "ART", parsed.artifactId),
          parsed,
          keys.nodeIndex(scope, parsed.executionNodeId, "ART", parsed.artifactId),
        );
      },
      get: (scope, id) => getRecord(ArtifactSchema, keys.runRecord(scope, "ART", id)),
      listByRun: (scope, page) =>
        listPage(ArtifactSchema, inTable(keys.runRecordPartition(scope, "ART")), page),
    },

    users: {
      put: async (user) => {
        const parsed = UserSchema.parse(user);
        await putRecord("User", keys.user(parsed.userId), parsed);
      },
      get: (userId) => getRecord(UserSchema, keys.user(userId)),
    },

    memberships: {
      put: async (membership) => {
        const parsed = MembershipSchema.parse(membership);
        await putRecord("Membership", keys.membership(parsed.userId, parsed.orgId), parsed);
      },
      listByUser: (userId) => listAll(MembershipSchema, inTable(keys.membershipPartition(userId))),
    },

    // A compare-and-swap on `version`, in the table, so two writers cannot both
    // win (D-P8-02). The first write of an org's config finds no row.
    orgConfigs: {
      get: (orgId) => getRecord(OrgConfigSchema, keys.orgConfig(orgId)),
      put: async (config) => {
        const parsed = OrgConfigSchema.parse(config);
        const previous = parsed.version - 1;
        try {
          await table.put({
            TableName: tableName,
            Item: toItem("OrgConfig", keys.orgConfig(parsed.orgId), parsed),
            ConditionExpression:
              previous === 0 ? "attribute_not_exists(#pk)" : "#version = :previous",
            ExpressionAttributeNames: previous === 0 ? { "#pk": "PK" } : { "#version": "version" },
            ...(previous === 0 ? {} : { ExpressionAttributeValues: { ":previous": previous } }),
          });
        } catch (error) {
          if (!isConditionalCheckFailure(error)) throw error;
          const stored = await getRecord(OrgConfigSchema, keys.orgConfig(parsed.orgId));
          throw new StaleWriteError(
            `the configuration of ${parsed.orgId}`,
            previous,
            stored?.version ?? 0,
          );
        }
      },
    },
  };
};
