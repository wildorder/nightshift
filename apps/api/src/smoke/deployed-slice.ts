/**
 * A slice context against the **deployed** control plane (P3 T9, shared by P5).
 *
 * Both `slice.smoke.ts` and `conformance.smoke.ts` drive the real server binary
 * against real AWS, and both need the same things around it: a machine token, a
 * throwaway project under a throwaway org, artifact reads from S3, a settle that
 * waits for the deployed materializer, and a cleanup that **reports its own
 * failure rather than swallowing it** (P2 T7). That lives here, once.
 *
 * It needs the AWS SDK, which is why it is in `apps/api` and not in `test/`
 * (AR-4).
 */
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type {
  DelegationLimits,
  ModelPolicy,
  OrgId,
  ProgramContract,
  ProjectId,
} from "@nightshift/contracts";
import { createUlidIdGenerator, nowIso, type RunScope, systemClock } from "@nightshift/core";
import {
  createAwsClients,
  createAwsStores,
  keys,
  type TableClient,
} from "@nightshift/persistence/aws";
import {
  createFetchTransport,
  createHttpArtifactBodyStore,
  createHttpStores,
  staticTokenProvider,
} from "@nightshift/persistence/http";
import { assertBuilt, materialiseFixtureRepo, type SliceContext } from "@nightshift/test/slice";
import { deleteObjectsUnder, deletePartitions } from "./cleanup.js";
import { fetchMachineToken, loadSmokeContext, REGION, subjectOf } from "./context.js";
import { waitForNumbering } from "./sequencing.js";

export interface DeployedSliceOptions {
  /** A short word for log lines and the throwaway project's name: `slice`, `conformance`. */
  readonly label: string;
  /** Replaces the fixture program's model policy. See `materialiseFixtureRepo`. */
  readonly modelPolicy?: ModelPolicy;
  /** Replaces the fixture program's limits, for a run that needs a tree (P6). */
  readonly delegationLimits?: DelegationLimits;
  /** P8: replaces the fixture's verification steps. */
  readonly verification?: ProgramContract["verification"];
  /** P8: files added to the fixture before its first commit. */
  readonly files?: Readonly<Record<string, string>>;
}

export interface DeployedSlice {
  readonly context: SliceContext;
  readonly apiEndpoint: string;
  readonly projectId: ProjectId;
  /** The throwaway org the machine principal acts for: its configuration is the suite's to set (P8). */
  readonly orgId: OrgId;
  /** Tell the slice about a run, so `settle` waits for it and cleanup removes it. */
  track(scope: RunScope): void;
  say(line: string): void;
  /** Removes everything this slice wrote. Throws, naming what is left, if it cannot. */
  cleanup(): Promise<void>;
}

export const openDeployedSlice = async (options: DeployedSliceOptions): Promise<DeployedSlice> => {
  const say = (line: string): void => {
    process.stdout.write(`[${options.label}] ${line}\n`);
  };

  await assertBuilt();
  const environment = await loadSmokeContext();
  const clients = createAwsClients({ region: REGION });
  const s3 = new S3Client({ region: REGION });
  const awsStores = createAwsStores({ tableName: environment.tableName, table: clients.table });
  const token = await fetchMachineToken(environment);
  const machineSubject = subjectOf(token);

  const ids = createUlidIdGenerator();
  const name = `${options.label}-${ids.next("evt").slice("evt_".length)}`;
  const orgId = ids.next("org");
  const projectId: ProjectId = ids.next("proj");
  const runScopes: RunScope[] = [];

  const transport = createFetchTransport({
    endpoint: environment.apiEndpoint,
    tokens: staticTokenProvider(token),
  });
  const stores = createHttpStores({ transport, actingOrg: orgId });
  const bodies = createHttpArtifactBodyStore({ transport });

  say(`stage ${environment.stage}; caller ${environment.callerArn}`);
  say(`project ${name} ${projectId}; org ${orgId}; machine principal ${machineSubject}`);

  // The machine principal must resolve to exactly one org, or the API cannot
  // pick one (`acting-org.ts`). A crashed earlier run can leave a stale empty
  // membership; those are cleared, and one holding projects is refused.
  for (const membership of await awsStores.memberships.listByUser(machineSubject as never)) {
    const projects = await awsStores.projects.listByOrg(membership.orgId, { limit: 1 });
    if (projects.items.length > 0) {
      throw new Error(
        `the machine principal already belongs to ${membership.orgId}, which holds projects; ` +
          "refusing to guess which org to act for",
      );
    }
    await clients.table.delete({
      TableName: environment.tableName,
      Key: keys.membership(machineSubject as never, membership.orgId),
    });
    say(`removed a stale membership in ${membership.orgId}`);
  }

  const now = nowIso(systemClock);
  await awsStores.users.put({
    schemaVersion: 1,
    userId: machineSubject as never,
    kind: "machine",
    createdAt: now,
  });
  await awsStores.memberships.put({
    schemaVersion: 1,
    userId: machineSubject as never,
    orgId,
    createdAt: now,
  });

  const fixture = await materialiseFixtureRepo({
    projectId,
    programId: ids.next("prog"),
    ...(options.modelPolicy === undefined ? {} : { modelPolicy: options.modelPolicy }),
    ...(options.delegationLimits === undefined
      ? {}
      : { delegationLimits: options.delegationLimits }),
    ...(options.verification === undefined ? {} : { verification: options.verification }),
    ...(options.files === undefined ? {} : { files: options.files }),
  });
  say(`fixture at ${fixture.repo}; program ${fixture.program.programId}`);

  await stores.projects.put({ schemaVersion: 1, projectId, orgId, name, createdAt: now });

  const context: SliceContext = {
    target: "deployed",
    fixture,
    stores,
    bodies,
    transport,
    ids,
    program: fixture.program,
    serverEnv: {
      NIGHTSHIFT_API_ENDPOINT: environment.apiEndpoint,
      NIGHTSHIFT_API_TOKEN: token,
      NIGHTSHIFT_STATE_DIR: fixture.stateDir,
    },
    // From S3 by the recorded key, which is what a human reading the API would
    // also have to do: there is no download route, by design.
    readArtifact: async (scope, artifactId) => {
      const key = `${scope.projectId}/${scope.programId}/${scope.runId}/${artifactId}`;
      try {
        const object = await s3.send(
          new GetObjectCommand({ Bucket: environment.bucketName, Key: key }),
        );
        return await object.Body?.transformToString();
      } catch {
        return undefined;
      }
    },
    // Numbering is the deployed materializer's, so waiting is the settle.
    settle: async () => {
      if (runScopes.length > 0) {
        await waitForNumbering(awsStores.events, runScopes, { timeoutMs: 60_000 });
      }
    },
    close: async () => {
      await fixture.remove();
    },
  };

  const cleanup = async (): Promise<void> => {
    const problems: string[] = [];
    const step = async (what: string, work: () => Promise<number | undefined>) => {
      try {
        const count = await work();
        say(`cleanup: ${what}${count === undefined ? "" : `: ${count} removed`}`);
      } catch (error) {
        problems.push(`${what}: ${error instanceof Error ? error.message : String(error)}`);
      }
    };

    // Let numbering finish before deleting, or the materializer will write a
    // counter into a partition after it has been read for deletion.
    await step("wait for numbering", async () => {
      if (runScopes.length > 0) {
        await waitForNumbering(awsStores.events, runScopes, { timeoutMs: 30_000 });
      }
      return undefined;
    });

    const partitions = [
      keys.user(machineSubject as never).PK,
      keys.orgProject(orgId, projectId).PK,
      keys.project(projectId).PK,
      keys.programContract(projectId, context.program.programId).PK,
      ...runScopes.flatMap((scope) => [
        keys.run(scope, scope.runId).PK,
        keys.runRecord(scope, "NODE", "x").PK,
        keys.event(scope, "x").PK,
      ]),
    ];
    await step(`${options.label} partitions`, () =>
      deletePartitions(clients.table as TableClient, environment.tableName, partitions),
    );
    await step(`S3 prefix ${projectId}/`, () =>
      deleteObjectsUnder(s3, environment.bucketName, `${projectId}/`),
    );
    await step("the fixture checkout", async () => {
      await context.close();
      return undefined;
    });

    if (problems.length > 0) {
      console.error(
        `[${options.label}] CLEANUP FAILED. Finish it by hand with the identifiers printed above:\n  ${problems.join("\n  ")}`,
      );
      throw new Error(`cleanup failed: ${problems.join("; ")}`);
    }
  };

  return {
    context,
    apiEndpoint: environment.apiEndpoint,
    projectId,
    orgId: orgId as OrgId,
    track: (scope) => {
      runScopes.push(scope);
    },
    say,
    cleanup,
  };
};
