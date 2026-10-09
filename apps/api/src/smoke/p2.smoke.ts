/**
 * The P2 smoke suite (T7, D-P2-12): the deployed control plane, end to end.
 *
 * Opt-in, never part of `npm test`: `AWS_PROFILE=nightshift npm run smoke`. Four
 * phases, in one file so nothing can reorder them:
 *
 * 1. Reachability and auth. The negative halves are the only proof the authorizer
 *    is wired rather than the API being open (SC-P2-07).
 * 2. The shared port conformance suite against the deployed table (SC-P2-12).
 * 3. Live-only assertions: isolation, S3 prefixes, large output, idempotency,
 *    sequencing and state reconstruction (SC-P2-05, -06, -08, -09, -10, -11).
 * 4. Cleanup of everything the run wrote, even when an assertion failed. Records
 *    and S3 prefixes only, never a stack (A-18).
 *
 * It writes into throwaway `smoke-<ulid>` projects and prints every identifier
 * first, so a half-cleaned run can be finished by hand. Two smoke runs must not
 * overlap: the conformance phase uses deterministic identifiers.
 */
import { createHash } from "node:crypto";
import { resolveNs } from "node:dns/promises";
import { HeadObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import {
  type Agent,
  AgentSchema,
  AppendEventResponseSchema,
  type Artifact,
  ArtifactUploadResponseSchema,
  type Event,
  EventPageSchema,
  type ExecutionNode,
  MAX_INLINE_PAYLOAD_BYTES,
  PlanDocumentUploadResponseSchema,
  ProgramContractSchema,
  ProgramIdSchema,
  ProjectIdSchema,
  ProjectPageSchema,
  type RoutingDecision,
  RunIdSchema,
  RunStateResponseSchema,
  UserIdSchema,
} from "@nightshift/contracts";
import {
  createUlidIdGenerator,
  emptyConversation,
  FIXTURE_COMMIT,
  type Fixtures,
  findSequenceGaps,
  highestSequence,
  keepMessages,
  makeAgent,
  makeCheckpoint,
  makeDecision,
  makeEvent,
  makeJobContract,
  makeNode,
  makeProgramContract,
  makeRootNode,
  makeRun,
  makeVerification,
  pendingCount,
  planHash,
  type RunScope,
  renderConversation,
} from "@nightshift/core";
import {
  createArtifactBodyStore,
  createAwsClients,
  createAwsStores,
  estimateItemBytes,
  keys,
  type TableClient,
} from "@nightshift/persistence/aws";
import { describePortConformance } from "@nightshift/test/conformance";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deleteConformanceLitter, deleteObjectsUnder, deletePartitions } from "./cleanup.js";
import {
  fetchMachineToken,
  forgedExpiredToken,
  loadSmokeContext,
  REGION,
  subjectOf,
} from "./context.js";
import { type ApiResult, smokeApiClient } from "./http.js";
import { waitForNumbering } from "./sequencing.js";

const say = (line: string): void => {
  process.stdout.write(`[smoke] ${line}\n`);
};

const startedAt = Date.now();
const findings: Record<string, unknown> = {};

// --- Where, and as whom --------------------------------------------------------------
const context = await loadSmokeContext();
const clients = createAwsClients({ region: REGION });
const s3 = new S3Client({ region: REGION });
const tableName = context.tableName;
const stores = createAwsStores({ tableName, table: clients.table });
const bodies = createArtifactBodyStore({
  bucketName: context.bucketName,
  objects: clients.objects,
});
const token = await fetchMachineToken(context);
const machineSubject = UserIdSchema.parse(subjectOf(token));
const api = smokeApiClient(context.apiEndpoint, token);

// D-P3-18: whether the stable hostname can be tested at all. Decided here, at the
// module's top level, because `describe` bodies are synchronous.
const customEndpoint = context.apiCustomEndpoint;
const delegated =
  customEndpoint === undefined
    ? false
    : await resolveNs("nightshift.wildorder.dev").then(
        () => true,
        () => false,
      );
const skipReason =
  customEndpoint === undefined
    ? "the API stack was deployed zone-only"
    : delegated
      ? undefined
      : "nightshift.wildorder.dev is not delegated yet";

// --- What this run writes ------------------------------------------------------------
const ids = createUlidIdGenerator();
const runLabel = `smoke-${ids.next("evt").slice("evt_".length)}`;
const orgId = ids.next("org");
const programId = ids.next("prog");
const runId = ids.next("run");
const rootNodeId = ids.next("node");
// Two projects sharing every identifier below the project, so only the project tells them apart.
const worldA: Fixtures = {
  ids,
  scope: { projectId: ids.next("proj"), programId, runId },
  rootNodeId,
};
const worldB: Fixtures = {
  ids,
  scope: { projectId: ids.next("proj"), programId, runId },
  rootNodeId,
};

say(`stage ${context.stage}; caller ${context.callerArn}; run ${runLabel}`);
say(
  `identifiers: org ${orgId}; project A ${worldA.scope.projectId}; project B ${worldB.scope.projectId}; ` +
    `program ${programId}; run ${runId}; root node ${rootNodeId}; machine principal ${machineSubject}`,
);

const projectPath = (f: Fixtures) => `/projects/${f.scope.projectId}`;
const programPath = (f: Fixtures) => `${projectPath(f)}/programs/${programId}`;
const runPath = (f: Fixtures) => `${programPath(f)}/runs/${runId}`;

const expectStatus = (result: ApiResult, status: number): void => {
  expect(result.status, JSON.stringify(result.body)).toBe(status);
};

/** An append body: an event without the fields the control plane assigns. */
const appendBody = (f: Fixtures, overrides: Partial<Record<keyof Event, unknown>> = {}) => {
  const { sequence: _sequence, recordedAt: _recordedAt, ...body } = makeEvent(f, overrides);
  return body;
};

const rootNodeFor = (f: Fixtures) => makeRootNode(f, { status: "validated" });

/**
 * A second run under project A's program, used only by the P3 lifecycle
 * assertions. Separate so the run the state-reconstruction test reads (SC-P2-10)
 * is never moved out from under it.
 */
const lifecycleRunId = ids.next("run");
const lifecycleRootNodeId = ids.next("node");
const lifecycleScope: RunScope = { ...worldA.scope, runId: lifecycleRunId };
const lifecycleWorld: Fixtures = { ids, scope: lifecycleScope, rootNodeId: lifecycleRootNodeId };
const lifecycleRunPath = `${programPath(worldA)}/runs/${lifecycleRunId}`;

/**
 * A planned program under project A (P7, T1), with a run of its own. Separate
 * from `programId` so ratifying it never touches the contract every other
 * assertion here shares.
 */
const plannedScope: RunScope = {
  projectId: worldA.scope.projectId,
  programId: ids.next("prog"),
  runId: ids.next("run"),
};
const plannedRootNodeId = ids.next("node");
const plannedWorld: Fixtures = { ids, scope: plannedScope, rootNodeId: plannedRootNodeId };
const plannedProgramPath = `${projectPath(worldA)}/programs/${plannedScope.programId}`;
const sha256Hex = (input: string | Uint8Array): string =>
  createHash("sha256").update(input).digest("hex");

// --- Conformance bookkeeping (phase 2) ------------------------------------------------
// The suite expects fresh stores per test, and its identifiers repeat between tests,
// so every partition a test writes is remembered and emptied before the next.
const written = new Set<string>();
const remember = (partition: unknown): void => {
  if (typeof partition === "string") written.add(partition);
};
const trackingTable: TableClient = {
  ...clients.table,
  put: (input) => {
    remember(input.Item?.PK);
    return clients.table.put(input);
  },
  update: (input) => {
    remember(input.Key?.PK);
    return clients.table.update(input);
  },
  transactWrite: (input) => {
    for (const item of input.TransactItems ?? []) {
      remember(item.Put?.Item?.PK ?? item.Update?.Key?.PK ?? item.Delete?.Key?.PK);
    }
    return clients.table.transactWrite(input);
  },
};
const writtenRuns = (): RunScope[] =>
  [...written]
    .filter((partition) => partition.startsWith("EVT#"))
    .map((partition) => {
      const [, projectId, programIdPart, runIdPart] = partition.split("#");
      return {
        projectId: ProjectIdSchema.parse(projectId),
        programId: ProgramIdSchema.parse(programIdPart),
        runId: RunIdSchema.parse(runIdPart),
      };
    });

// --- Setup and phase 4 ------------------------------------------------------------------
beforeAll(async () => {
  say(
    `removed ${await deleteConformanceLitter(clients.table, tableName)} items of earlier conformance litter`,
  );

  // A crashed earlier run can leave the machine principal a member of an org it no
  // longer needs. Holding two memberships, the API could not pick one (T9's rule),
  // so empty orgs are cleared; an org holding projects is not the suite's to touch.
  for (const membership of await stores.memberships.listByUser(machineSubject)) {
    const projects = await stores.projects.listByOrg(membership.orgId, { limit: 1 });
    if (projects.items.length > 0) {
      throw new Error(
        `the machine principal already belongs to ${membership.orgId}, which holds projects; ` +
          "refusing to guess which org to act for",
      );
    }
    await clients.table.delete({
      TableName: tableName,
      Key: keys.membership(machineSubject, membership.orgId),
    });
    say(`removed a stale membership in ${membership.orgId}`);
  }

  const now = new Date().toISOString();
  await stores.users.put({
    schemaVersion: 1,
    userId: machineSubject,
    kind: "machine",
    createdAt: now,
  });
  await stores.memberships.put({ schemaVersion: 1, userId: machineSubject, orgId, createdAt: now });
});

afterAll(async () => {
  const problems: string[] = [];
  const step = async (label: string, work: () => Promise<number | undefined>) => {
    try {
      const count = await work();
      say(`cleanup: ${label}${count === undefined ? "" : `: ${count} removed`}`);
    } catch (error) {
      problems.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  // Let numbering finish first, or the materializer could write a counter into a
  // partition after it has been read for deletion.
  await step("wait for numbering", async () => {
    await waitForNumbering(stores.events, [worldA.scope, worldB.scope, ...writtenRuns()], {
      timeoutMs: 30_000,
    });
    return undefined;
  });

  // `runRecord` and `event` build one partition per run, shared by every
  // run-scoped record type — NODE, JOB, AGENT, DEC, CKPT, VER, EXAM, ROUTE, ART
  // — so the job contracts, agents and examinations P3 adds need no new entry
  // here: emptying the run's partition removes them all. What did need adding is
  // the second run (`lifecycleRunId`), which has partitions of its own.
  const partitions = [
    keys.user(machineSubject).PK,
    keys.orgProject(orgId, worldA.scope.projectId).PK,
    ...[worldA, worldB].flatMap((f) => [
      keys.project(f.scope.projectId).PK,
      keys.run(f.scope, runId).PK,
      keys.runRecord(f.scope, "NODE", rootNodeId).PK,
      keys.event(f.scope, rootNodeId).PK,
    ]),
    keys.run(lifecycleScope, lifecycleRunId).PK,
    keys.runRecord(lifecycleScope, "NODE", lifecycleRootNodeId).PK,
    keys.event(lifecycleScope, lifecycleRootNodeId).PK,
    // P7: the planned program's run. Its contract sits in project A's partition.
    keys.run(plannedScope, plannedScope.runId).PK,
    keys.runRecord(plannedScope, "NODE", plannedRootNodeId).PK,
    keys.event(plannedScope, plannedRootNodeId).PK,
  ];
  await step("smoke partitions", () => deletePartitions(clients.table, tableName, partitions));
  for (const f of [worldA, worldB]) {
    const prefix = `${f.scope.projectId}/`;
    await step(`S3 prefix ${prefix}`, () => deleteObjectsUnder(s3, context.bucketName, prefix));
  }
  // P7: ratified plan documents live under their own prefix, not the project's.
  const planPrefix = `plans/${worldA.scope.projectId}/`;
  await step(`S3 prefix ${planPrefix}`, () =>
    deleteObjectsUnder(s3, context.bucketName, planPrefix),
  );
  await step("conformance litter", () => deleteConformanceLitter(clients.table, tableName));
  await step("conformance litter in the credentials table", () =>
    deleteConformanceLitter(clients.table, context.credentialsTableName),
  );

  say(
    `runtime ${((Date.now() - startedAt) / 1000).toFixed(1)} s; findings ${JSON.stringify(findings)}`,
  );
  if (problems.length > 0) {
    console.error(
      `[smoke] CLEANUP FAILED. Finish it by hand with the identifiers printed above:\n  ${problems.join("\n  ")}`,
    );
    throw new Error(`cleanup failed: ${problems.join("; ")}`);
  }
});

// --- Phase 1 ----------------------------------------------------------------------------
/**
 * The two codes the gateway answers with, and why they differ (P4).
 *
 * With the JWT authorizer both cases were 401. Nightshift's Lambda authorizer
 * (D-P4-04) is a **request** authorizer, and API Gateway distinguishes: a
 * request missing the identity source never reaches the function and is 401; a
 * function that answers `isAuthorized: false` is 403. Both are the gateway
 * refusing before the handler runs, which is what SC-P2-07 and SC-P4-05 claim —
 * only the status code moved, and it is the gateway's to choose.
 */
const NO_IDENTITY_SOURCE = 401;
const AUTHORIZER_DENIED = 403;

describe("phase 1: reachability and auth (SC-P2-07)", () => {
  it("rejects a request with no token at the gateway", async () => {
    expectStatus(await api.withAuthorization(undefined, "GET", "/projects"), NO_IDENTITY_SOURCE);
  });

  it("rejects a malformed token", async () => {
    expectStatus(
      await api.withAuthorization("Bearer not-a-jwt", "GET", "/projects"),
      AUTHORIZER_DENIED,
    );
  });

  it("rejects a well-formed token that expired and was signed by nothing", async () => {
    const forged = `Bearer ${forgedExpiredToken(context)}`;
    expectStatus(await api.withAuthorization(forged, "GET", "/projects"), AUTHORIZER_DENIED);
  });

  it("accepts a valid machine token and resolves its org", async () => {
    const result = await api.get("/projects");
    expectStatus(result, 200);
    expect(ProjectPageSchema.parse(result.body).items).toEqual([]);
  });

  /**
   * D-P3-18, SC-P3-18: the hostname a CLI stores. Skipped, with the reason in
   * the name, until the API stack has been deployed in `full` mode *and* the
   * zone is delegated from `wildorder.dev` (H-P3-05): before either, the name
   * resolves to nothing and a failure here would say nothing new.
   */
  it.skipIf(skipReason !== undefined)(
    `serves the same authorized API on the stable hostname${skipReason === undefined ? "" : ` (skipped: ${skipReason})`}`,
    async () => {
      if (customEndpoint === undefined) throw new Error("unreachable: skipped above");
      const stable = smokeApiClient(customEndpoint, token);
      expectStatus(
        await stable.withAuthorization(undefined, "GET", "/projects"),
        NO_IDENTITY_SOURCE,
      );
      const result = await stable.get("/projects");
      expectStatus(result, 200);
      expect(ProjectPageSchema.parse(result.body).items).toEqual([]);
      findings.stableHostname = new URL(customEndpoint).hostname;
      say(
        `stable hostname ${new URL(customEndpoint).hostname} answers with the authorizer in front`,
      );
    },
  );
});

// --- Phase 2 ----------------------------------------------------------------------------
describePortConformance(
  "phase 2: the deployed DynamoDB adapter (SC-P2-12)",
  async () => {
    await waitForNumbering(stores.events, writtenRuns());
    await deletePartitions(clients.table, tableName, written);
    written.clear();
    // P10 (D-P10-23): the credentials table too, so the identity section proves
    // the deployed table and not a refusal.
    return createAwsStores({
      tableName,
      table: trackingTable,
      credentialsTableName: context.credentialsTableName,
    });
  },
  {
    // The deployed adapter implements both halves of the split (T2).
    identity: (deployed) => deployed,
    settle: async () => {
      await waitForNumbering(stores.events, writtenRuns());
    },
  },
);

// --- Phase 3 ----------------------------------------------------------------------------
describe("phase 3: live-only assertions", () => {
  it("keeps Project A / Program X and Project B / Program X apart (SC-P2-05)", async () => {
    for (const [f, label] of [
      [worldA, "A"],
      [worldB, "B"],
    ] as const) {
      const project = {
        schemaVersion: 1,
        projectId: f.scope.projectId,
        name: `${runLabel}-${label}`,
        createdAt: new Date().toISOString(),
      };
      expectStatus(await api.put(projectPath(f), project), 201);
      const contract = makeProgramContract(f, {
        objective: `${runLabel}: the program of project ${label}`,
      });
      expectStatus(await api.put(programPath(f), contract), 201);
      expectStatus(await api.put(runPath(f), makeRun(f)), 201);
      expectStatus(await api.put(`${runPath(f)}/nodes/${rootNodeId}`, rootNodeFor(f)), 201);
    }

    const programA = ProgramContractSchema.parse((await api.get(programPath(worldA))).body);
    expect(programA.projectId).toBe(worldA.scope.projectId);
    expect(programA.objective).toContain("project A");

    for (const f of [worldA, worldB]) {
      const run = await stores.runs.get(f.scope, runId);
      expect(run?.projectId).toBe(f.scope.projectId);
      const nodes = (await stores.executionNodes.listByRun(f.scope)).items;
      expect(nodes.map((node) => node.projectId)).toEqual([f.scope.projectId]);
    }

    const listed = ProjectPageSchema.parse((await api.get("/projects")).body).items;
    expect(listed.map((p) => p.projectId).sort()).toEqual(
      [worldA.scope.projectId, worldB.scope.projectId].sort(),
    );
  });

  it("prefixes every artifact object with its own project (SC-P2-06)", async () => {
    const artifactId = ids.next("art");
    const inA = await bodies.put(worldA.scope, artifactId, `${runLabel}: body of A`, "text/plain");
    const inB = await bodies.put(worldB.scope, artifactId, `${runLabel}: body of B`, "text/plain");

    expect(inA.key).toBe(`${worldA.scope.projectId}/${programId}/${runId}/${artifactId}`);
    expect(inB.key).toBe(`${worldB.scope.projectId}/${programId}/${runId}/${artifactId}`);

    const underA = await s3.send(
      new ListObjectsV2Command({
        Bucket: context.bucketName,
        Prefix: `${worldA.scope.projectId}/`,
      }),
    );
    const keysUnderA = (underA.Contents ?? []).map((object) => object.Key);
    expect(keysUnderA).toContain(inA.key);
    expect(keysUnderA).not.toContain(inB.key);
    expect(new TextDecoder().decode(await bodies.get(worldA.scope, artifactId))).toContain(
      "body of A",
    );
  });

  it("refuses an oversized payload inline, keeps it in S3, and the item stays small (SC-P2-11)", async () => {
    const events = `${runPath(worldA)}/events`;
    const blob = "x".repeat(MAX_INLINE_PAYLOAD_BYTES * 3);

    const inline = {
      ...appendBody(worldA, { idempotencyKey: `${runLabel}-inline` }),
      payload: { blob },
    };
    const refused = await api.post(events, inline);
    expectStatus(refused, 400);
    expect((refused.body as { error: { code: string } }).error.code).toBe("validation_failed");

    const payloadArtifactId = ids.next("art");
    const stored = await bodies.put(
      worldA.scope,
      payloadArtifactId,
      JSON.stringify({ blob }),
      "application/json",
    );
    const artifact: Artifact = {
      schemaVersion: 1,
      ...worldA.scope,
      artifactId: payloadArtifactId,
      executionNodeId: rootNodeId,
      kind: "other",
      uri: stored.uri,
      sizeBytes: stored.sizeBytes,
      contentType: "application/json",
      sha256: stored.sha256,
      createdAt: new Date().toISOString(),
    };
    expectStatus(await api.put(`${runPath(worldA)}/artifacts/${payloadArtifactId}`, artifact), 201);

    const byReference = appendBody(worldA, {
      idempotencyKey: `${runLabel}-by-reference`,
      payload: { summary: "the full payload is an artifact" },
      payloadArtifactId,
    });
    const appended = await api.post(events, byReference);
    expectStatus(appended, 201);
    const { event } = AppendEventResponseSchema.parse(appended.body);

    const item = await clients.table.get({
      TableName: tableName,
      Key: keys.event(worldA.scope, event.eventId),
      ConsistentRead: true,
    });
    const itemBytes = estimateItemBytes(item.Item ?? {});
    findings.largeOutput = { payloadBytes: stored.sizeBytes, eventItemBytes: itemBytes };
    expect(stored.sizeBytes).toBeGreaterThan(MAX_INLINE_PAYLOAD_BYTES);
    expect(itemBytes).toBeLessThan(2_000);
  });

  it("stores one event for a repeated idempotency key (SC-P2-08)", async () => {
    const events = `${runPath(worldA)}/events`;
    const body = appendBody(worldA, { idempotencyKey: `${runLabel}-duplicate` });

    const first = await api.post(events, body);
    expectStatus(first, 201);
    const second = await api.post(events, { ...body, eventId: ids.next("evt") });
    expectStatus(second, 200);

    const firstEvent = AppendEventResponseSchema.parse(first.body);
    const secondEvent = AppendEventResponseSchema.parse(second.body);
    expect(secondEvent.stored).toBe(false);
    expect(secondEvent.event.eventId).toBe(firstEvent.event.eventId);
    const stored = (await stores.events.listByRun(worldA.scope)).items;
    expect(stored.filter((e) => e.idempotencyKey === body.idempotencyKey)).toHaveLength(1);
  });

  it("numbers events densely from zero once durable, and records the lag (SC-P2-09)", async () => {
    const events = `${runPath(worldA)}/events`;
    for (let i = 0; i < 12; i += 1) {
      expectStatus(
        await api.post(events, appendBody(worldA, { idempotencyKey: `${runLabel}-burst-${i}` })),
        201,
      );
    }
    const { elapsedMs } = await waitForNumbering(stores.events, [worldA.scope]);
    findings.sequencingLagMs = elapsedMs;
    say(`observed sequencing lag: ${elapsedMs} ms from the last append to the last number`);

    const listed = EventPageSchema.parse((await api.get(events)).body).items;
    expect(pendingCount(listed)).toBe(0);
    expect(listed.map((e) => e.sequence)).toEqual(listed.map((_, index) => index));
    expect(findSequenceGaps(listed)).toEqual([]);
  });

  it("rebuilds current run state from stored records alone (SC-P2-10)", async () => {
    const state = RunStateResponseSchema.parse((await api.get(`${runPath(worldA)}/state`)).body);

    // Rebuilt independently, from the table, with the API not involved.
    const run = await stores.runs.get(worldA.scope, runId);
    const nodes = (await stores.executionNodes.listByRun(worldA.scope)).items;
    const events = (await stores.events.listByRun(worldA.scope)).items;

    expect(state.run).toEqual(run);
    expect(state.nodes).toEqual(nodes);
    expect(state.highestSequence).toBe(highestSequence(events) ?? null);
    expect(state.pendingEvents).toBe(pendingCount(events));

    // And both agree with what the suite wrote.
    expect(state.run).toEqual(makeRun(worldA));
    expect(state.nodes).toEqual([rootNodeFor(worldA)]);
    expect(state.highestSequence).toBe(events.length - 1);
  });

  // -------------------------------------------------------------------------
  // The P3 additions (T2, D-P3-13). Every route P3 added is exercised here,
  // against the deployed stack, because a route the smoke suite does not touch
  // is a route nobody has proved is wired.
  // -------------------------------------------------------------------------

  it("round trips a job contract and an agent, and applies the agent table (T2)", async () => {
    const job = makeJobContract(worldA, { objective: `${runLabel}: the smoke job` });
    expectStatus(await api.put(`${runPath(worldA)}/jobs/${job.jobContractId}`, job), 201);
    expect((await api.get(`${runPath(worldA)}/jobs/${job.jobContractId}`)).body).toEqual(job);
    const listedJobs = (await api.get(`${runPath(worldA)}/jobs`)).body as { items: unknown[] };
    expect(listedJobs.items).toEqual([job]);

    const agent: Agent = makeAgent(worldA, rootNodeId, { role: "worker" });
    const agentPath = `${runPath(worldA)}/agents/${agent.agentId}`;
    expectStatus(await api.put(agentPath, agent), 201);
    expect(AgentSchema.parse((await api.get(agentPath)).body).status).toBe("created");

    // Legal: created -> started.
    const startedAt = new Date().toISOString();
    const started = { ...agent, status: "started", startedAt };
    expectStatus(await api.put(agentPath, started), 200);

    // Illegal: started -> created. The table has no such edge.
    const backwards = await api.put(agentPath, agent);
    expectStatus(backwards, 409);
    expect((backwards.body as { error: { code: string } }).error.code).toBe("illegal_transition");

    // And an ending with no reason is refused even though the edge exists.
    const silent = await api.put(agentPath, {
      ...started,
      status: "failed",
      endedAt: new Date().toISOString(),
    });
    expectStatus(silent, 422);

    const listedAgents = (await api.get(`${runPath(worldA)}/nodes/${rootNodeId}/agents`)).body as {
      items: { agentId: string }[];
    };
    expect(listedAgents.items.map((a) => a.agentId)).toEqual([agent.agentId]);
  });

  it("moves a run pending, running, succeeded, and refuses an illegal jump (T2)", async () => {
    const pending = makeRun(lifecycleWorld, { status: "pending" });
    expectStatus(await api.put(lifecycleRunPath, pending), 201);
    expectStatus(
      await api.put(
        `${lifecycleRunPath}/nodes/${lifecycleRootNodeId}`,
        rootNodeFor(lifecycleWorld),
      ),
      201,
    );

    // pending cannot jump straight to succeeded.
    const jump = await api.put(lifecycleRunPath, {
      ...pending,
      status: "succeeded",
      endedAt: new Date().toISOString(),
    });
    expectStatus(jump, 409);

    const running = { ...pending, status: "running" };
    expectStatus(await api.put(lifecycleRunPath, running), 200);

    const succeeded = { ...running, status: "succeeded", endedAt: new Date().toISOString() };
    expectStatus(await api.put(lifecycleRunPath, succeeded), 200);
    expect((await api.get(lifecycleRunPath)).body).toEqual(succeeded);

    const listedRuns = (await api.get(`${programPath(worldA)}/runs`)).body as {
      items: { runId: string }[];
    };
    expect(listedRuns.items.map((r) => r.runId).sort()).toEqual([runId, lifecycleRunId].sort());

    const listedPrograms = (await api.get(`${projectPath(worldA)}/programs`)).body as {
      items: { programId: string }[];
    };
    expect(listedPrograms.items.map((p) => p.programId)).toEqual([programId]);
  });

  it("ends a program node succeeded, never a job, and fills a routing decision in once (P5, D-P5-06)", async () => {
    const nodePath = (nodeId: string) => `${lifecycleRunPath}/nodes/${nodeId}`;
    const step = async (node: ExecutionNode, status: ExecutionNode["status"]) => {
      const next = { ...node, status, updatedAt: new Date().toISOString() };
      expectStatus(await api.put(nodePath(node.executionNodeId), next), 200);
      return next;
    };

    let root: ExecutionNode = rootNodeFor(lifecycleWorld);
    root = await step(await step(root, "queued"), "running");

    let job: ExecutionNode = makeNode(lifecycleWorld, lifecycleRootNodeId, {
      jobContractId: ids.next("job"),
    });
    expectStatus(await api.put(nodePath(job.executionNodeId), job), 201);
    job = await step(await step(job, "queued"), "running");

    // A job is never `succeeded`: its only way to done is through `verified`.
    const asJob = await api.put(nodePath(job.executionNodeId), {
      ...job,
      status: "succeeded",
      updatedAt: new Date().toISOString(),
    });
    expectStatus(asJob, 409);
    expect((asJob.body as { error: { code: string } }).error.code).toBe("illegal_transition");

    // Nor may a program node end while anything under it is in flight (D-P6-03).
    expectStatus(
      await api.put(nodePath(root.executionNodeId), {
        ...root,
        status: "succeeded",
        updatedAt: new Date().toISOString(),
      }),
      409,
    );
    job = await step(job, "failed");

    root = await step(root, "succeeded");
    expectStatus(await api.put(nodePath(root.executionNodeId), { ...root, status: "failed" }), 409);

    // The routing decision: written before the work, completed once after it.
    const decision: RoutingDecision = {
      schemaVersion: 1,
      ...lifecycleScope,
      routingDecisionId: ids.next("route"),
      executionNodeId: job.executionNodeId,
      attempt: 1,
      eligibleOptions: [
        { target: { harness: "codex", provider: "openai", model: "smoke" }, eligible: true },
      ],
      chosen: { harness: "codex", provider: "openai", model: "smoke" },
      ruleId: "p5-configured",
      wasOverride: false,
      usage: {},
      outcome: "pending",
      previousRouteId: null,
      createdAt: new Date().toISOString(),
    };
    const routePath = `${lifecycleRunPath}/routing-decisions/${decision.routingDecisionId}`;
    expectStatus(await api.put(routePath, decision), 201);
    const finished = {
      ...decision,
      usage: { inputTokens: 1200, outputTokens: 340, wallClockMs: 9000 },
      outcome: "verified",
    };
    expectStatus(await api.put(routePath, finished), 200);
    expectStatus(await api.put(routePath, finished), 200);
    expectStatus(await api.put(routePath, { ...finished, usage: { inputTokens: 1 } }), 409);
    expectStatus(await api.put(routePath, { ...finished, outcome: "failed" }), 409);
    expectStatus(await api.put(routePath, { ...finished, ruleId: "rewritten" }), 409);

    const listed = (await api.get(`${nodePath(job.executionNodeId)}/routing-decisions`)).body as {
      items: RoutingDecision[];
    };
    expect(listed.items).toEqual([finished]);
  });

  it("ratifies a plan it holds byte for byte, gates the run on it, and takes a prerequisite only from an exit code (P7, SC-P7-04, SC-P7-05)", async () => {
    const plan = `# ${runLabel}\n\n## Strands\n\n### S-01 The only strand\n\nA module exists.\n`;
    const contract = makeProgramContract(plannedWorld, {
      status: "planning",
      strands: [
        {
          id: "S-01",
          name: "The only strand",
          scope: { summary: "the source tree", includes: ["src/**"], excludes: [] },
          acceptance: ["its tests pass"],
          successCriteria: ["SC-01"],
          dependsOn: [],
          prerequisites: ["HP-01"],
        },
      ],
      prerequisites: [
        {
          id: "HP-01",
          description: "A registry token exists.",
          remediation: "npm login",
          verifyCommand: "npm whoami",
          status: "pending",
        },
      ],
    });
    const runPathPlanned = `${plannedProgramPath}/runs/${plannedScope.runId}`;
    const run = makeRun(plannedWorld, { status: "pending" });

    // The gate: a planned program that nobody ratified does not run.
    expectStatus(await api.put(plannedProgramPath, contract), 201);
    const refused = await api.put(runPathPlanned, run);
    expectStatus(refused, 409);
    expect((refused.body as { error: { code: string } }).error.code).toBe("plan_not_ratified");
    // And ratification never arrives by writing the contract as ratified.
    expectStatus(await api.put(plannedProgramPath, { ...contract, status: "ratified" }), 400);

    // Upload the document, program scoped, named by its own digest.
    const hash = planHash(contract, plan, sha256Hex);
    const sizeBytes = Buffer.byteLength(plan);
    const signed = await api.post(`${plannedProgramPath}/plan-documents/${hash.plan}/upload-url`, {
      sizeBytes,
    });
    expectStatus(signed, 200);
    const target = PlanDocumentUploadResponseSchema.parse(signed.body);
    expect(target.key).toBe(
      `plans/${plannedScope.projectId}/${plannedScope.programId}/${hash.plan}.md`,
    );

    // Ratifying before the bytes are there is refused: the plane reads its own store.
    const request = { contract, planHash: hash.hash, planSha256: hash.plan };
    expectStatus(await api.post(`${plannedProgramPath}/ratifications`, request), 404);

    const uploaded = await fetch(target.uploadUrl, {
      method: "PUT",
      headers: { "content-type": target.contentType, "content-length": String(sizeBytes) },
      body: plan,
    });
    expect(uploaded.status, await uploaded.text()).toBe(200);

    // A hash of some other contract is refused; the right one ratifies.
    const wrong = await api.post(`${plannedProgramPath}/ratifications`, {
      ...request,
      planHash: "0".repeat(64),
    });
    expectStatus(wrong, 422);
    const ratifiedResponse = await api.post(`${plannedProgramPath}/ratifications`, request);
    expectStatus(ratifiedResponse, 200);
    const ratified = ProgramContractSchema.parse(ratifiedResponse.body);
    expect(ratified.status).toBe("ratified");
    expect(ratified.planHash).toBe(hash.hash);
    expect(ratified.planDocument).toEqual({
      uri: `s3://${context.bucketName}/${target.key}`,
      sha256: hash.plan,
      sizeBytes,
    });
    expect(ratified.ratifications).toHaveLength(1);

    // Readable from the control plane alone, byte for byte, by its hash (SC-P7-04).
    const document = await api.get(`${plannedProgramPath}/plan-documents/${hash.plan}`);
    expectStatus(document, 200);
    const text = (document.body as { text: string }).text;
    expect(text).toBe(plan);
    expect(sha256Hex(text)).toBe(hash.plan);

    // Only an exit code moves a prerequisite, and it does not move the plan hash.
    const prerequisite = `${plannedProgramPath}/prerequisites/HP-01`;
    expectStatus(await api.put(prerequisite, { status: "satisfied" }), 400);
    const failed = await api.put(prerequisite, { kind: "check", exitCode: 1 });
    expect(failed.body).toMatchObject({ status: "pending", lastCheck: { exitCode: 1 } });
    const passed = await api.put(prerequisite, { kind: "check", exitCode: 0 });
    expect(passed.body).toMatchObject({ status: "satisfied", lastCheck: { exitCode: 0 } });
    const listed = await api.get(`${plannedProgramPath}/prerequisites`);
    expect((listed.body as { items: { id: string; status: string }[] }).items).toMatchObject([
      { id: "HP-01", status: "satisfied" },
    ]);
    const after = ProgramContractSchema.parse((await api.get(plannedProgramPath)).body);
    expect(planHash(after, plan, sha256Hex).hash).toBe(hash.hash);

    // Ratified, it runs, and its program node carries the plan it runs.
    expectStatus(await api.put(runPathPlanned, run), 201);
    const root = makeRootNode(plannedWorld, { status: "validated" });
    const nodePath = `${runPathPlanned}/nodes/${plannedRootNodeId}`;
    expectStatus(await api.put(nodePath, root), 422);
    const withPlan = {
      ...root,
      plan: { planHash: ratified.planHash, planDocument: ratified.planDocument },
    };
    expectStatus(await api.put(nodePath, withPlan), 201);
    expect((await api.get(nodePath)).body).toEqual(withPlan);

    // P14 (SC-P14-06): the kept conversation is stored beside the plan, the
    // stories' quotes are held to the bytes the plane holds, and it is served back.
    const conversation = renderConversation(
      keepMessages(
        emptyConversation("smoke"),
        {
          harness: "claude",
          sessionId: runLabel,
          messages: [{ index: 1, role: "human", text: "never show one tenant another's invoices" }],
        },
        [1],
        "The smoke's owner wants tenants isolated.",
      ),
    );
    const conversationSha256 = sha256Hex(conversation);
    const conversationBytes = Buffer.byteLength(conversation);
    const signedConversation = PlanDocumentUploadResponseSchema.parse(
      (
        await api.post(`${plannedProgramPath}/plan-documents/${conversationSha256}/upload-url`, {
          sizeBytes: conversationBytes,
        })
      ).body,
    );
    const putConversation = await fetch(signedConversation.uploadUrl, {
      method: "PUT",
      headers: {
        "content-type": signedConversation.contentType,
        "content-length": String(conversationBytes),
      },
      body: conversation,
    });
    expect(putConversation.status, await putConversation.text()).toBe(200);
    const quoting = (words: string) => ({
      ...contract,
      stories: (contract.stories ?? []).map((story) => ({ ...story, words: [words] })),
    });
    const requestFor = (words: string) => {
      const quoted = quoting(words);
      const quotedHash = planHash(quoted, plan, sha256Hex);
      return {
        contract: quoted,
        planHash: quotedHash.hash,
        planSha256: quotedHash.plan,
        conversationSha256,
      };
    };
    expectStatus(
      await api.post(
        `${plannedProgramPath}/ratifications`,
        requestFor("tenants may share invoices"),
      ),
      422,
    );
    const withConversation = await api.post(
      `${plannedProgramPath}/ratifications`,
      requestFor("never show one tenant another's invoices"),
    );
    expectStatus(withConversation, 200);
    expect(ProgramContractSchema.parse(withConversation.body).conversation).toEqual({
      uri: `s3://${context.bucketName}/${signedConversation.key}`,
      sha256: conversationSha256,
      sizeBytes: conversationBytes,
    });
    const served = await api.get(`${plannedProgramPath}/plan-documents/${conversationSha256}`);
    expectStatus(served, 200);
    expect((served.body as { text: string }).text).toBe(conversation);
  });

  it("signs an upload the client completes, then records the Artifact (A-08, T2)", async () => {
    const artifactId = ids.next("art");
    const body = `${runLabel}: verification log
step test: exit 0
`;
    const contentType = "text/plain";
    const sizeBytes = Buffer.byteLength(body);

    const signed = await api.post(`${runPath(worldA)}/artifacts/${artifactId}/upload-url`, {
      kind: "verification-log",
      contentType,
      sizeBytes,
    });
    expectStatus(signed, 200);
    const target = ArtifactUploadResponseSchema.parse(signed.body);
    expect(target.key).toBe(`${worldA.scope.projectId}/${programId}/${runId}/${artifactId}`);
    expect(target.uri).toBe(`s3://${context.bucketName}/${target.key}`);

    // The client uploads. The function never sees the bytes. Both headers are in
    // the signature, so both must match exactly.
    const uploaded = await fetch(target.uploadUrl, {
      method: "PUT",
      headers: { "content-type": contentType, "content-length": String(sizeBytes) },
      body,
    });
    expect(uploaded.status, await uploaded.text()).toBe(200);

    // The object is under this project's prefix with the type the signature pinned.
    const head = await s3.send(
      new HeadObjectCommand({ Bucket: context.bucketName, Key: target.key }),
    );
    expect(head.ContentType).toBe(contentType);
    expect(head.ContentLength).toBe(sizeBytes);
    expect(new TextDecoder().decode(await bodies.get(worldA.scope, artifactId))).toBe(body);

    // Only now is the reference recorded: the record follows the durable bytes.
    const artifact: Artifact = {
      schemaVersion: 1,
      ...worldA.scope,
      artifactId,
      executionNodeId: rootNodeId,
      kind: "verification-log",
      uri: target.uri,
      sizeBytes,
      contentType,
      createdAt: new Date().toISOString(),
    };
    expectStatus(await api.put(`${runPath(worldA)}/artifacts/${artifactId}`, artifact), 201);
    expect((await api.get(`${runPath(worldA)}/artifacts/${artifactId}`)).body).toEqual(artifact);
    const listed = (await api.get(`${runPath(worldA)}/artifacts`)).body as {
      items: { artifactId: string }[];
    };
    expect(listed.items.map((a) => a.artifactId)).toContain(artifactId);

    // The signature pins the type and the length. Both are enforced by S3, which
    // is only true because the signer hoists them into its signed headers; the
    // default presigned PUT enforces neither. Each mismatch is a 403
    // SignatureDoesNotMatch.
    const wrongType = await fetch(target.uploadUrl, {
      method: "PUT",
      headers: { "content-type": "application/json", "content-length": String(sizeBytes) },
      body: "x".repeat(sizeBytes),
    });
    expect(wrongType.status, await wrongType.text()).toBe(403);

    const wrongLength = await fetch(target.uploadUrl, {
      method: "PUT",
      headers: { "content-type": contentType, "content-length": String(sizeBytes + 1) },
      body: `${body}!`,
    });
    expect(wrongLength.status, await wrongLength.text()).toBe(403);
  });

  it("round trips an examination, and moves a finding only forward (P8, D-P8-13)", async () => {
    const node = rootNodeFor(worldA);
    const verification = makeVerification(worldA, { ...node, commitSha: FIXTURE_COMMIT });
    expectStatus(
      await api.put(
        `${runPath(worldA)}/verifications/${verification.verificationId}`,
        verification,
      ),
      201,
    );

    const examinationId = ids.next("exam");
    const examination = {
      schemaVersion: 1,
      ...worldA.scope,
      examinationId,
      executionNodeId: rootNodeId,
      verificationId: verification.verificationId,
      commitSha: verification.commitSha,
      patchId: "0".repeat(40),
      implementerAgentId: ids.next("agent"),
      examinerAgentId: ids.next("agent"),
      examinerRoute: { harness: "codex", provider: "openai", model: "gpt-6-sol" },
      requiredByRisk: "high",
      blocking: true,
      fixAttempt: 0,
      questions: [],
      outcome: "findings_raised",
      findings: [
        {
          id: "F-01",
          severity: "material",
          summary: "a placeholder finding",
          evidence: [{ kind: "contract", clause: "written by the smoke suite" }],
          resolution: "unresolved",
        },
      ],
      createdAt: new Date().toISOString(),
    };
    const path = `${runPath(worldA)}/examinations/${examinationId}`;
    expectStatus(await api.put(path, examination), 201);
    expect((await api.get(path)).body).toEqual(examination);
    const listed = (await api.get(`${runPath(worldA)}/nodes/${rootNodeId}/examinations`)).body as {
      items: { examinationId: string }[];
    };
    expect(listed.items.map((e) => e.examinationId)).toEqual([examinationId]);

    const at = new Date().toISOString();
    const moved = (resolution: string, resolvedBy: Record<string, unknown>) => ({
      ...examination,
      findings: examination.findings.map((finding) => ({
        ...finding,
        resolution,
        resolvedBy: { at, ...resolvedBy },
      })),
    });
    // Only a human accepts a risk; a softened verdict is refused outright.
    expectStatus(await api.put(path, moved("risk_accepted", { authority: "agent" })), 409);
    expectStatus(await api.put(path, { ...examination, outcome: "passed", findings: [] }), 409);
    expectStatus(
      await api.put(path, moved("disputed", { authority: "agent", reason: "smoke" })),
      200,
    );
  });

  it("serves an org its configuration and refuses a stale write (P8, D-P8-02)", async () => {
    const path = `/orgs/${orgId}/config`;
    const seeded = (await api.get(path)).body as {
      version: number;
      routingPolicy: unknown;
      examinationPolicy: unknown;
    };
    expect(seeded.version).toBe(0);
    const body = {
      routingPolicy: seeded.routingPolicy,
      examinationPolicy: seeded.examinationPolicy,
      replacesVersion: 0,
    };
    expect(((await api.put(path, body)).body as { version: number }).version).toBe(1);
    expectStatus(await api.put(path, body), 409);
    expectStatus(await api.get(`/orgs/${ids.next("org")}/config`), 403);
  });

  it("reads back every remaining list route the http adapter needs (T2)", async () => {
    const checkpoint = makeCheckpoint(worldA, rootNodeId);
    expectStatus(
      await api.put(`${runPath(worldA)}/checkpoints/${checkpoint.checkpointId}`, checkpoint),
      201,
    );
    const decision = makeDecision(worldA, rootNodeId, {
      checkpointBefore: checkpoint.checkpointId,
    });
    expectStatus(
      await api.put(`${runPath(worldA)}/decisions/${decision.decisionId}`, decision),
      201,
    );
    const routing: RoutingDecision = {
      schemaVersion: 1,
      ...worldA.scope,
      routingDecisionId: ids.next("route"),
      executionNodeId: rootNodeId,
      attempt: 1,
      eligibleOptions: [
        {
          target: { harness: "claude", provider: "anthropic", model: "claude-sonnet-5" },
          eligible: true,
        },
      ],
      chosen: { harness: "claude", provider: "anthropic", model: "claude-sonnet-5" },
      ruleId: "p3-fixed",
      wasOverride: false,
      usage: {},
      outcome: "pending",
      previousRouteId: null,
      createdAt: new Date().toISOString(),
    };
    expectStatus(
      await api.put(`${runPath(worldA)}/routing-decisions/${routing.routingDecisionId}`, routing),
      201,
    );

    const expectOne = async (path: string, field: string, value: string) => {
      const result = await api.get(path);
      expectStatus(result, 200);
      const items = (result.body as { items: Record<string, unknown>[] }).items;
      expect(
        items.map((item) => item[field]),
        path,
      ).toContain(value);
    };

    await expectOne(`${runPath(worldA)}/decisions`, "decisionId", decision.decisionId);
    await expectOne(`${runPath(worldA)}/checkpoints`, "checkpointId", checkpoint.checkpointId);
    await expectOne(`${runPath(worldA)}/nodes`, "executionNodeId", rootNodeId);
    await expectOne(
      `${runPath(worldA)}/nodes/${rootNodeId}/routing-decisions`,
      "routingDecisionId",
      routing.routingDecisionId,
    );
    expect((await api.get(`${runPath(worldA)}/decisions/${decision.decisionId}`)).body).toEqual(
      decision,
    );
    expect(
      (await api.get(`${runPath(worldA)}/checkpoints/${checkpoint.checkpointId}`)).body,
    ).toEqual(checkpoint);
    // The root node has no children; an empty listing is a listing, not a 404.
    const children = await api.get(`${runPath(worldA)}/nodes/${rootNodeId}/children`);
    expectStatus(children, 200);
    expect((children.body as { items: unknown[] }).items).toEqual([]);
  });
});
