/**
 * The deployed slice (T9 deliverable 4, T10 deliverables 1 and 2).
 *
 * The same job, the same fixture and the same real server binary as the offline
 * suite — against the **deployed control plane**, with a real Cognito token,
 * real DynamoDB, real S3 and real presigned uploads.
 *
 *   AWS_PROFILE=nightshift npm run slice
 *
 * ## Why it lives here rather than in `test/`
 *
 * It needs the AWS SDK: a machine token, S3 reads for artifact bodies, and
 * cleanup. `test/` may not import `@nightshift/persistence/aws` (AR-4), and
 * quite rightly — so the *shape* of a slice context is exported from
 * `@nightshift/test/slice` and the AWS-specific construction is here, beside the
 * smoke suite, in the one package allowed to reach AWS.
 *
 * ## What it writes, and what it removes
 *
 * A throwaway `slice-<ulid>` project, a membership for the machine principal if
 * it needs one, and everything one run produces. Cleanup runs even when an
 * assertion fails, and **reports its own failure rather than swallowing it**
 * (P2 T7): litter in the only account matters more with one account, not less.
 */
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { ProjectId } from "@nightshift/contracts";
import { createUlidIdGenerator, nowIso, type RunScope, systemClock } from "@nightshift/core";
import { git, nodeGitRunner, revParse, sealedRef, tryRevParse } from "@nightshift/execution";
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
import {
  assertBuilt,
  type MaterialisedRepo,
  materialiseFixtureRepo,
  type Orchestrator,
  PROGRAM_BRANCH,
  type SliceContext,
  sliceHarness,
  startOrchestrator,
} from "@nightshift/test/slice";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deleteObjectsUnder, deletePartitions } from "./cleanup.js";
import { fetchMachineToken, loadSmokeContext, REGION, subjectOf } from "./context.js";
import { waitForNumbering } from "./sequencing.js";

const say = (line: string): void => {
  process.stdout.write(`[slice] ${line}\n`);
};

const startedAt = Date.now();
const harness = sliceHarness();

await assertBuilt();
const environment = await loadSmokeContext();
const clients = createAwsClients({ region: REGION });
const s3 = new S3Client({ region: REGION });
const awsStores = createAwsStores({ tableName: environment.tableName, table: clients.table });
const token = await fetchMachineToken(environment);
const machineSubject = subjectOf(token);

const ids = createUlidIdGenerator();
const label = `slice-${ids.next("evt").slice("evt_".length)}`;
const orgId = ids.next("org");
const projectId: ProjectId = ids.next("proj");

const transport = createFetchTransport({
  endpoint: environment.apiEndpoint,
  tokens: staticTokenProvider(token),
});
const stores = createHttpStores({ transport, actingOrg: orgId });
const bodies = createHttpArtifactBodyStore({ transport });

let fixture: MaterialisedRepo;
let context: SliceContext;
let mcp: Orchestrator | undefined;
/** Every run this file created, so cleanup can find their partitions. */
const runScopes: RunScope[] = [];

say(`stage ${environment.stage}; caller ${environment.callerArn}; harness ${harness}`);
say(`label ${label}; org ${orgId}; project ${projectId}; machine principal ${machineSubject}`);

beforeAll(async () => {
  // The machine principal must resolve to exactly one org, or the API cannot
  // pick one (`acting-org.ts`). A crashed earlier run can leave a stale empty
  // membership; the smoke suite clears those, and this refuses to guess.
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

  fixture = await materialiseFixtureRepo({ projectId, programId: ids.next("prog") });
  say(`fixture at ${fixture.repo}; program ${fixture.program.programId}`);

  await stores.projects.put({
    schemaVersion: 1,
    projectId,
    orgId,
    name: label,
    createdAt: now,
  });

  context = {
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
});

afterAll(async () => {
  const problems: string[] = [];
  const step = async (what: string, work: () => Promise<number | undefined>) => {
    try {
      const count = await work();
      say(`cleanup: ${what}${count === undefined ? "" : `: ${count} removed`}`);
    } catch (error) {
      problems.push(`${what}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  await mcp?.close().catch(() => {});

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
    keys.programContract(projectId, context?.program.programId ?? ("" as never)).PK,
    ...runScopes.flatMap((scope) => [
      keys.run(scope, scope.runId).PK,
      keys.runRecord(scope, "NODE", "x").PK,
      keys.event(scope, "x").PK,
    ]),
  ];
  await step("slice partitions", () =>
    deletePartitions(clients.table as TableClient, environment.tableName, partitions),
  );
  await step(`S3 prefix ${projectId}/`, () =>
    deleteObjectsUnder(s3, environment.bucketName, `${projectId}/`),
  );
  await step("the fixture checkout", async () => {
    await context?.close();
    return undefined;
  });

  say(`runtime ${((Date.now() - startedAt) / 1000).toFixed(1)} s`);
  if (problems.length > 0) {
    console.error(
      `[slice] CLEANUP FAILED. Finish it by hand with the identifiers printed above:\n  ${problems.join("\n  ")}`,
    );
    throw new Error(`cleanup failed: ${problems.join("; ")}`);
  }
});

const DELEGATION = {
  objective: "Add a median helper to src/math.js, with tests for odd and even lengths.",
  scope: { includes: ["src/**", "test/**"] },
  acceptance: ["median([3,1,2]) is 2", "median([1,2,3,4]) is 2.5", "the existing tests still pass"],
};

describe(`the deployed slice, with the ${harness} harness`, () => {
  it("runs one job from delegation to an integrated, checkpointed commit", async () => {
    const started = Date.now();
    mcp = await startOrchestrator({ context, script: "implement", harness });

    const run = await mcp.call("run.start", {
      programContractPath: "nightshift.program.json",
      model: "claude-sonnet-5",
    });
    expect(run.ok, JSON.stringify(run)).toBe(true);
    const scope: RunScope = {
      projectId,
      programId: context.program.programId,
      runId: String(run.runId) as never,
    };
    runScopes.push(scope);
    say(`run ${scope.runId}; root node ${String(run.rootNodeId)}`);

    const delegatedAt = Date.now();
    const job = await mcp.call("delegate", DELEGATION);
    expect(job.ok, JSON.stringify(job)).toBe(true);
    say(
      `job ${String(job.jobId)}; node ${String(job.nodeId)}; agent ${String(job.agentId)}; ` +
        `worker started in ${Date.now() - delegatedAt} ms`,
    );

    let report = await mcp.call("job.wait", { jobId: job.jobId });
    while (report.timedOut === true) report = await mcp.call("job.wait", { jobId: job.jobId });
    say(`job settled as ${String(report.status)} after ${Date.now() - delegatedAt} ms`);

    expect(report.status, JSON.stringify(report)).toBe("integrated");
    const sha = String(report.commitSha);

    // --- The same assertions the offline suite makes, against real AWS -------
    expect(await revParse(nodeGitRunner, fixture.repo, PROGRAM_BRANCH)).toBe(sha);
    expect(await tryRevParse(nodeGitRunner, fixture.repo, sealedRef(String(report.nodeId)))).toBe(
      sha,
    );
    const commit = await git(nodeGitRunner, ["log", "-1", "--format=%an%n%B", sha], {
      cwd: fixture.repo,
    });
    expect(commit).toContain("Nightshift");
    expect(commit).toContain(`Nightshift-Run: ${scope.runId}`);

    const verifications = await stores.verifications.listByNode(
      scope,
      String(report.nodeId) as never,
    );
    expect(verifications[0]?.outcome).toBe("passed");
    expect(verifications[0]?.commands).toHaveLength(2);

    // The log really is in S3, fetched by its recorded key.
    const logArtifactId = verifications[0]?.commands[0]?.logArtifactId;
    expect(logArtifactId).toBeDefined();
    const log = await context.readArtifact(scope, String(logArtifactId));
    expect(log, "the verification log is readable from S3 by its recorded URI").toContain("# pass");

    const artifacts = await stores.artifacts.listByRun(scope);
    say(
      `artifacts: ${artifacts.items.map((artifact) => `${artifact.kind}=${artifact.sizeBytes}B`).join(", ")}`,
    );

    // --- Routing usage, for the as-built -------------------------------------
    const routing = await stores.routingDecisions.listByNode(scope, String(report.nodeId) as never);
    say(
      `routing ${routing[0]?.ruleId ?? "?"} chose ${routing[0]?.chosen.model ?? "?"}; ` +
        `usage ${JSON.stringify(routing[0]?.usage ?? {})}`,
    );

    const finished = await mcp.call("run.finish", { outcome: "succeeded" });
    expect(finished.ok, JSON.stringify(finished)).toBe(true);

    say(`total wall clock ${((Date.now() - started) / 1000).toFixed(1)} s`);
    say(
      `READ IT BACK: GET ${environment.apiEndpoint}/projects/${projectId}/programs/${scope.programId}/runs/${scope.runId}/state`,
    );
  });

  /**
   * The lifecycle, reconstructed from the event stream alone (SC-P3-16's
   * "readable from `GET …/state` and `GET …/events`").
   */
  it("leaves a lifecycle a reader can reconstruct from events alone", async () => {
    const scope = runScopes[0];
    expect(scope, "the first test must have run").toBeDefined();
    if (scope === undefined) return;

    await context.settle();
    const events = (await stores.events.listByRun(scope)).items;
    const types = events.map((event) => event.type);

    for (const expected of [
      "run.created",
      "run.started",
      "node.delegated",
      "node.queued",
      "agent.created",
      "routing.decided",
      "node.started",
      "agent.started",
      "node.implemented",
      "verification.requested",
      "verification.completed",
      "node.integrated",
      "checkpoint.created",
      "run.completed",
    ]) {
      expect(types, expected).toContain(expected);
    }

    // Numbered densely from zero, with nothing left pending.
    const sequences = events.map((event) => event.sequence);
    expect(sequences).toEqual(sequences.map((_, index) => index));
  });
});
