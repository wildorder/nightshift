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
import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import {
  AppendEventResponseSchema,
  type Artifact,
  type Event,
  EventPageSchema,
  MAX_INLINE_PAYLOAD_BYTES,
  ProgramContractSchema,
  ProgramIdSchema,
  ProjectIdSchema,
  ProjectPageSchema,
  RunIdSchema,
  RunStateResponseSchema,
  UserIdSchema,
} from "@nightshift/contracts";
import {
  createUlidIdGenerator,
  type Fixtures,
  findSequenceGaps,
  highestSequence,
  makeEvent,
  makeProgramContract,
  makeRootNode,
  makeRun,
  pendingCount,
  type RunScope,
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

  const partitions = [
    keys.user(machineSubject).PK,
    keys.orgProject(orgId, worldA.scope.projectId).PK,
    ...[worldA, worldB].flatMap((f) => [
      keys.project(f.scope.projectId).PK,
      keys.run(f.scope, runId).PK,
      keys.runRecord(f.scope, "NODE", rootNodeId).PK,
      keys.event(f.scope, rootNodeId).PK,
    ]),
  ];
  await step("smoke partitions", () => deletePartitions(clients.table, tableName, partitions));
  for (const f of [worldA, worldB]) {
    const prefix = `${f.scope.projectId}/`;
    await step(`S3 prefix ${prefix}`, () => deleteObjectsUnder(s3, context.bucketName, prefix));
  }
  await step("conformance litter", () => deleteConformanceLitter(clients.table, tableName));

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
describe("phase 1: reachability and auth (SC-P2-07)", () => {
  it("rejects a request with no token at the gateway", async () => {
    expectStatus(await api.withAuthorization(undefined, "GET", "/projects"), 401);
  });

  it("rejects a malformed token", async () => {
    expectStatus(await api.withAuthorization("Bearer not-a-jwt", "GET", "/projects"), 401);
  });

  it("rejects a well-formed token that expired and was signed by nothing", async () => {
    const forged = `Bearer ${forgedExpiredToken(context)}`;
    expectStatus(await api.withAuthorization(forged, "GET", "/projects"), 401);
  });

  it("accepts a valid machine token and resolves its org", async () => {
    const result = await api.get("/projects");
    expectStatus(result, 200);
    expect(ProjectPageSchema.parse(result.body).items).toEqual([]);
  });
});

// --- Phase 2 ----------------------------------------------------------------------------
describePortConformance(
  "phase 2: the deployed DynamoDB adapter (SC-P2-12)",
  async () => {
    await waitForNumbering(stores.events, writtenRuns());
    await deletePartitions(clients.table, tableName, written);
    written.clear();
    return createAwsStores({ tableName, table: trackingTable });
  },
  {
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
});
