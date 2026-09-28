/**
 * The Studio's live suite (P11, T2 deliverable 6; SC-P11-08, SC-P11-09,
 * SC-P11-11).
 *
 * Opt-in, never part of `npm test`: `AWS_PROFILE=nightshift npm run studio:smoke`.
 *
 * What the hosted Studio needs from the control plane, proven against the
 * deployed stage rather than a template: the app is served on its hostname with
 * a `config.json` that names this stage; the API answers a preflight from the
 * Studio's origins and grants nothing to another; and an artifact's bytes come
 * back through a URL the control plane signs, for a user and never for an
 * execution token. What is served may be the placeholder page until T1's build
 * is deployed; the suite asks for the page, not for the app's markup.
 *
 * | Phase | Claim |
 * |-------|-------|
 * | 1 | `https://studio.<stage>…/` answers 200 with a page; `/config.json` names the stage's API, auth domain and client id (SC-P11-09) |
 * | 2 | A preflight from the Studio's origins is granted; one from `https://example.com` is not (SC-P11-08) |
 * | 3 | A download URL is issued for an artifact the suite uploaded and the bytes read back through it; an unrecorded artifact is refused; an execution token is refused (D-P11-06, SC-P11-05) |
 * | 4 | Everything the run wrote is removed (A-18: records and objects, never a stack) |
 *
 * It writes into a throwaway organisation and prints every identifier first,
 * so a half-cleaned run can be finished by hand.
 */
import { S3Client } from "@aws-sdk/client-s3";
import {
  type AgentId,
  type Artifact,
  ArtifactDownloadResponseSchema,
  ArtifactUploadResponseSchema,
  type ExecutionNodeId,
  type UserId,
} from "@nightshift/contracts";
import {
  createFixtures,
  createUlidIdGenerator,
  makeAgent,
  makeJobContract,
  makeNode,
  makeProgramContract,
  makeProject,
  makeRootNode,
  makeRun,
  type RunScope,
} from "@nightshift/core";
import { createAwsClients, createAwsStores, keys } from "@nightshift/persistence/aws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadStudioEnvironment, type StudioEnvironment } from "../aws/stack-outputs.js";
import { deleteObjectsUnder, deletePartitions } from "./cleanup.js";
import {
  fetchMachineToken,
  loadSmokeContext,
  REGION,
  type SmokeContext,
  subjectOf,
} from "./context.js";
import { type ApiResult, type SmokeApiClient, smokeApiClient } from "./http.js";

const say = (line: string): void => {
  process.stdout.write(`[studio] ${line}\n`);
};

const ids = createUlidIdGenerator();
const startedAt = Date.now();
const findings: Record<string, unknown> = {};

let context: SmokeContext;
let studio: StudioEnvironment;
/** The address the Studio calls (D-P11-03): the stable hostname when the stack has one. */
let endpoint: string;
let clients: ReturnType<typeof createAwsClients>;
let stores: ReturnType<typeof createAwsStores>;
let s3: S3Client;
let tableName: string;

let api: SmokeApiClient;
let subject: UserId;
let orgId: ReturnType<typeof ids.next<"org">>;

/** The run every artifact here belongs to, and the agent whose token is refused. */
interface World {
  readonly scope: RunScope;
  readonly rootNodeId: ExecutionNodeId;
  readonly nodeId: ExecutionNodeId;
  readonly agentId: AgentId;
}
let world: World;

const runPath = (scope: RunScope): string =>
  `/projects/${scope.projectId}/programs/${scope.programId}/runs/${scope.runId}`;

const expectStatus = (result: ApiResult, status: number): void => {
  expect(result.status, JSON.stringify(result.body)).toBe(status);
};

const errorCodeOf = (result: ApiResult): string | undefined =>
  (result.body as { error?: { code?: string } } | undefined)?.error?.code;

/** The Studio's origins for this stage: the hosted one, and on `dev` the local one (D-P11-01). */
const studioOrigins = (): readonly string[] => [
  studio.studioUrl,
  ...(context.stage === "dev" ? ["http://localhost:5173"] : []),
];

const preflight = (origin: string): Promise<Response> =>
  fetch(`${endpoint}/projects`, {
    method: "OPTIONS",
    headers: {
      origin,
      "access-control-request-method": "GET",
      "access-control-request-headers": "authorization,content-type",
    },
  });

beforeAll(async () => {
  context = await loadSmokeContext();
  studio = await loadStudioEnvironment(context.stage);
  endpoint = context.apiCustomEndpoint ?? context.apiEndpoint;
  clients = createAwsClients({ region: REGION });
  stores = createAwsStores({ tableName: context.tableName, table: clients.table });
  s3 = new S3Client({ region: REGION });
  tableName = context.tableName;
  say(
    `stage ${context.stage}; caller ${context.callerArn}; studio ${studio.studioUrl}; api ${endpoint}`,
  );

  // --- As whom ------------------------------------------------------------------
  const token = await fetchMachineToken(context);
  subject = subjectOf(token) as UserId;
  orgId = ids.next("org");
  api = smokeApiClient(endpoint, token);

  // A crashed earlier run can leave a stale membership behind, and two
  // memberships make the acting org unresolvable. Empty orgs are cleared; one
  // holding projects is not this suite's to touch.
  for (const membership of await stores.memberships.listByUser(subject)) {
    const held = await stores.projects.listByOrg(membership.orgId, { limit: 1 });
    if (held.items.length > 0) {
      throw new Error(
        `the machine principal already belongs to ${membership.orgId}, which holds projects; ` +
          "refusing to guess which org to act for",
      );
    }
    await clients.table.delete({
      TableName: tableName,
      Key: keys.membership(subject, membership.orgId),
    });
    say(`removed a stale membership in ${membership.orgId}`);
  }
  const now = new Date().toISOString();
  await stores.users.put({ schemaVersion: 1, userId: subject, kind: "machine", createdAt: now });
  await stores.memberships.put({ schemaVersion: 1, userId: subject, orgId, createdAt: now });

  // --- The world, assigned before the first write so cleanup knows it --------------
  const f = createFixtures(ids);
  const job = makeJobContract(f);
  const node = makeNode(f, f.rootNodeId, { status: "validated", jobContractId: job.jobContractId });
  const agent = makeAgent(f, node.executionNodeId);
  world = {
    scope: f.scope,
    rootNodeId: f.rootNodeId,
    nodeId: node.executionNodeId,
    agentId: agent.agentId,
  };
  say(
    `identifiers: org ${orgId}; project ${f.scope.projectId}; program ${f.scope.programId}; ` +
      `run ${f.scope.runId}; root node ${f.rootNodeId}; principal ${subject}`,
  );

  const created = (result: ApiResult, what: string): void => {
    expect([200, 201], `${what}: ${JSON.stringify(result.body)}`).toContain(result.status);
  };
  const { orgId: _orgId, ...projectBody } = makeProject(f);
  const base = runPath(f.scope);
  created(await api.put(`/projects/${f.scope.projectId}`, projectBody), "project");
  created(
    await api.put(
      `/projects/${f.scope.projectId}/programs/${f.scope.programId}`,
      makeProgramContract(f),
    ),
    "program",
  );
  created(await api.put(base, makeRun(f)), "run");
  created(await api.put(`${base}/nodes/${f.rootNodeId}`, makeRootNode(f)), "root node");
  created(await api.put(`${base}/jobs/${job.jobContractId}`, job), "job");
  created(await api.put(`${base}/nodes/${node.executionNodeId}`, node), "job node");
  created(await api.put(`${base}/agents/${agent.agentId}`, agent), "agent");
});

/** Phase 4. Records and objects only, never a stack (A-18). */
afterAll(async () => {
  if (context === undefined) return;
  const problems: string[] = [];
  const step = async (label: string, work: () => Promise<number>) => {
    try {
      say(`cleanup: ${label}: ${await work()} removed`);
    } catch (error) {
      problems.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const partitions = [
    ...(subject === undefined ? [] : [keys.user(subject).PK]),
    ...(world === undefined
      ? []
      : [
          keys.orgProject(orgId, world.scope.projectId).PK,
          keys.project(world.scope.projectId).PK,
          keys.run(world.scope, world.scope.runId).PK,
          keys.runRecord(world.scope, "NODE", world.rootNodeId).PK,
          keys.event(world.scope, world.rootNodeId).PK,
        ]),
  ];
  await step("partitions", () => deletePartitions(clients.table, tableName, partitions));
  if (world !== undefined) {
    const prefix = `${world.scope.projectId}/`;
    await step(`S3 prefix ${prefix}`, () => deleteObjectsUnder(s3, context.bucketName, prefix));
  }
  say(
    `runtime ${((Date.now() - startedAt) / 1000).toFixed(1)} s; findings ${JSON.stringify(findings)}`,
  );
  if (problems.length > 0) {
    console.error(
      `[studio] CLEANUP FAILED. Finish it by hand with the identifiers printed above:\n  ${problems.join("\n  ")}`,
    );
    throw new Error(`cleanup failed: ${problems.join("; ")}`);
  }
});

// --- Phase 1 ----------------------------------------------------------------------------
describe("phase 1: the hosted Studio and its configuration (SC-P11-09)", () => {
  it("serves a page on the stage's hostname over HTTPS", async () => {
    expect(studio.studioUrl).toBe(`https://${studio.studioHostname}`);
    expect(studio.studioHostname).toBe(`studio.${context.stage}.nightshift.wildorder.dev`);
    const response = await fetch(`${studio.studioUrl}/`);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const page = await response.text();
    expect(page).toContain("<html");
    findings.placeholder = page.includes("studio-placeholder");
    say(`the page is ${findings.placeholder ? "the placeholder" : "the app"}`);
  });

  it("serves config.json naming this stage's API, auth domain and Studio client", async () => {
    const response = await fetch(`${studio.studioUrl}/config.json`);
    expect(response.status).toBe(200);
    const config = (await response.json()) as Record<string, unknown>;
    expect(Object.keys(config).sort()).toEqual(["apiEndpoint", "authDomain", "clientId", "stage"]);
    // The hostname the CLI calls (D-P11-03), never the generated endpoint.
    expect(config.apiEndpoint).toBe(`https://api.${context.stage}.nightshift.wildorder.dev`);
    if (context.apiCustomEndpoint !== undefined) {
      expect(config.apiEndpoint).toBe(context.apiCustomEndpoint);
    }
    expect(config.authDomain).toBe(context.authDomain);
    expect(config.clientId).toBe(context.studioClientId);
    expect(config.stage).toBe(context.stage);
    findings.clientId = config.clientId;
  });

  it("answers a deep link with the page, so the router owns the path", async () => {
    const response = await fetch(`${studio.studioUrl}/projects/${world.scope.projectId}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
  });
});

// --- Phase 2 ----------------------------------------------------------------------------
describe("phase 2: preflight from the Studio's origins (SC-P11-08)", () => {
  it("grants each of the Studio's origins, with the methods and headers a bearer client needs", async () => {
    for (const origin of studioOrigins()) {
      const response = await preflight(origin);
      expect(response.status, origin).toBe(204);
      expect(response.headers.get("access-control-allow-origin"), origin).toBe(origin);
      const methods = response.headers.get("access-control-allow-methods") ?? "";
      for (const method of ["GET", "PUT", "POST", "OPTIONS"]) {
        expect(methods, `${origin}: ${method}`).toContain(method);
      }
      const headers = (response.headers.get("access-control-allow-headers") ?? "").toLowerCase();
      expect(headers, origin).toContain("authorization");
      expect(headers, origin).toContain("content-type");
      // Bearer tokens, not cookies.
      expect(response.headers.get("access-control-allow-credentials"), origin).toBeNull();
    }
    say(`preflight granted for ${studioOrigins().join(", ")}`);
  });

  it("grants nothing to another origin", async () => {
    const response = await preflight("https://example.com");
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(response.headers.get("access-control-allow-methods")).toBeNull();
    findings.strangerPreflightStatus = response.status;
  });

  it("answers a real request from the Studio's origin with the origin echoed", async () => {
    const response = await fetch(`${endpoint}/projects`, {
      headers: {
        origin: studio.studioUrl,
        authorization: `Bearer ${await fetchMachineToken(context)}`,
      },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(studio.studioUrl);
  });
});

// --- Phase 3 ----------------------------------------------------------------------------
describe("phase 3: a signed download (D-P11-06, SC-P11-05)", () => {
  const artifactId = ids.next("art");
  const body = `studio smoke ${artifactId}: transcript\nline two\n`;
  const contentType = "text/plain";
  const sizeBytes = Buffer.byteLength(body);

  it("uploads and records an artifact, as the execution layer does", async () => {
    const signed = await api.post(`${runPath(world.scope)}/artifacts/${artifactId}/upload-url`, {
      kind: "transcript",
      contentType,
      sizeBytes,
    });
    expectStatus(signed, 200);
    const target = ArtifactUploadResponseSchema.parse(signed.body);
    const uploaded = await fetch(target.uploadUrl, {
      method: "PUT",
      headers: { "content-type": contentType, "content-length": String(sizeBytes) },
      body,
    });
    expect(uploaded.status, await uploaded.text()).toBe(200);

    const artifact: Artifact = {
      schemaVersion: 1,
      ...world.scope,
      artifactId,
      executionNodeId: world.nodeId,
      kind: "transcript",
      uri: target.uri,
      sizeBytes,
      contentType,
      createdAt: new Date().toISOString(),
    };
    expectStatus(await api.put(`${runPath(world.scope)}/artifacts/${artifactId}`, artifact), 201);
  });

  it("issues a download URL for it, and the bytes read back through it", async () => {
    const before = Date.now();
    const result = await api.post(
      `${runPath(world.scope)}/artifacts/${artifactId}/download-url`,
      undefined,
    );
    expectStatus(result, 200);
    const target = ArtifactDownloadResponseSchema.parse(result.body);
    // Fifteen minutes, as the upload's (D-P11-06).
    const ttlMs = Date.parse(target.expiresAt) - before;
    expect(ttlMs).toBeGreaterThan(14 * 60 * 1000);
    expect(ttlMs).toBeLessThan(16 * 60 * 1000);
    expect(target.url).toContain(context.bucketName);
    expect(target.url).toContain(artifactId);

    // The bytes come from S3 with the type the upload pinned. No Nightshift
    // route serves them and no token goes with the request.
    const response = await fetch(target.url);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(response.headers.get("content-type")).toBe(contentType);
    expect(await response.text()).toBe(body);
    say(`read ${sizeBytes} bytes back through a signed URL expiring ${target.expiresAt}`);
  });

  it("refuses to sign for an artifact nobody recorded", async () => {
    const result = await api.post(
      `${runPath(world.scope)}/artifacts/${ids.next("art")}/download-url`,
      undefined,
    );
    expectStatus(result, 404);
    expect(errorCodeOf(result)).toBe("not_found");
  });

  it("refuses an execution token, whatever it asks for", async () => {
    const minted = await api.post(
      `${runPath(world.scope)}/agents/${world.agentId}/token`,
      undefined,
    );
    expectStatus(minted, 201);
    const { token } = minted.body as { token: string };
    const worker = smokeApiClient(endpoint, token);

    // Its own run's artifact, which it may list and read the reference of.
    expectStatus(await worker.get(`${runPath(world.scope)}/artifacts/${artifactId}`), 200);
    // And whose bytes it may not have.
    const refused = await worker.post(
      `${runPath(world.scope)}/artifacts/${artifactId}/download-url`,
      undefined,
    );
    expectStatus(refused, 403);
    expect(errorCodeOf(refused)).toBe("execution_forbidden_operation");
    say("an execution token was refused a download URL for its own run's artifact");
  });
});
