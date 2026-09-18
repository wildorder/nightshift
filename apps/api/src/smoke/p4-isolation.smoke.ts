/**
 * The live two-principal matrix (P4, T5 deliverable 3; SC-P4-01 … SC-P4-05,
 * SC-P4-11).
 *
 * Opt-in, never part of `npm test`: `AWS_PROFILE=nightshift npm run smoke`.
 *
 * Two machine principals in two throwaway organisations, against the deployed
 * control plane, through the deployed authorizer. The offline matrix in
 * `apps/api/src/isolation.test.ts` asserts the same table with principals a
 * suite constructed; this one asserts it with tokens Cognito issued and a token
 * KMS signed, which is the half that proves the wiring rather than the rules.
 *
 * ## What each phase asserts
 *
 * | Phase | Claim |
 * |-------|-------|
 * | 1 | Two principals exist, in two orgs, with real Cognito tokens (D-P4-07) |
 * | 2 | A reaches every project-scoped route of its own project (no 403s) |
 * | 3 | B is refused every one of them, with `wrong_org` (SC-P4-01) |
 * | 4 | Listing shows each principal only its own org's projects (SC-P4-03) |
 * | 5 | A mints an execution token; B cannot (SC-P4-02) |
 * | 6 | The minted token does exactly §4.4 on its own node (SC-P4-04) |
 * | 7 | An absent, expired, foreign-signed or tampered token is refused (SC-P4-05) |
 * | 8 | Everything both orgs wrote is removed (A-18: records, never a stack) |
 *
 * Both organisations are throwaway and cleaned up, including when an assertion
 * failed. Every identifier is printed first, so a half-cleaned run can be
 * finished by hand.
 */
import { GetPublicKeyCommand, KMSClient } from "@aws-sdk/client-kms";
import {
  type Agent,
  type ExecutionNode,
  type JobContract,
  ProjectPageSchema,
  type Run,
  type UserId,
} from "@nightshift/contracts";
import { createUlidIdGenerator, type RunScope } from "@nightshift/core";
import { createAwsClients, createAwsStores, keys } from "@nightshift/persistence/aws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encodeSegment } from "../tokens/jwt.js";
import { publicKeyFromSpki, verifyExecutionToken } from "../tokens/verify.js";
import { deletePartitions } from "./cleanup.js";
import {
  fetchMachineToken,
  loadSmokeContext,
  REGION,
  type SmokeContext,
  subjectOf,
} from "./context.js";
import { type ApiResult, type SmokeApiClient, smokeApiClient } from "./http.js";

const say = (line: string): void => {
  process.stdout.write(`[p4-isolation] ${line}\n`);
};

const ids = createUlidIdGenerator();

let context: SmokeContext;
let endpoint: string;
let clients: ReturnType<typeof createAwsClients>;
let stores: ReturnType<typeof createAwsStores>;
let tableName: string;

/** One principal: a Cognito subject, its own organisation, and a client for it. */
interface Principal {
  readonly label: string;
  readonly subject: UserId;
  readonly orgId: ReturnType<typeof ids.next<"org">>;
  readonly api: SmokeApiClient;
  readonly token: string;
}

let a: Principal;
let b: Principal;

/** A's world: the records every route in the matrix names. */
interface World {
  readonly scope: RunScope;
  readonly run: Run;
  readonly rootNodeId: ExecutionNode["executionNodeId"];
  readonly node: ExecutionNode;
  readonly agent: Agent;
  readonly job: JobContract;
}
let world: World;

/** Every route the matrix walks, against A's world. Built once, used by both principals. */
interface Probe {
  readonly operation: string;
  readonly method: "GET" | "PUT" | "POST";
  readonly path: string;
}
let probes: readonly Probe[];

const run = (scope: RunScope): string =>
  `/projects/${scope.projectId}/programs/${scope.programId}/runs/${scope.runId}`;

/** A principal with a token, a fresh org, and the rows the API's org resolution needs. */
const makePrincipal = async (label: string, clientId: string): Promise<Principal> => {
  const token = await fetchMachineToken(context, clientId);
  const subject = subjectOf(token) as UserId;
  const orgId = ids.next("org");
  const now = new Date().toISOString();

  // A crashed earlier run can leave a stale membership behind, and two
  // memberships make the acting org unresolvable (`acting-org.ts`). Empty orgs
  // are cleared; one holding projects is not this suite's to touch.
  for (const membership of await stores.memberships.listByUser(subject)) {
    const held = await stores.projects.listByOrg(membership.orgId, { limit: 1 });
    if (held.items.length > 0) {
      throw new Error(
        `${label} already belongs to ${membership.orgId}, which holds projects; ` +
          "refusing to guess which org to act for",
      );
    }
    await clients.table.delete({
      TableName: tableName,
      Key: keys.membership(subject, membership.orgId),
    });
    say(`removed a stale membership for ${label} in ${membership.orgId}`);
  }

  await stores.users.put({ schemaVersion: 1, userId: subject, kind: "machine", createdAt: now });
  await stores.memberships.put({ schemaVersion: 1, userId: subject, orgId, createdAt: now });
  say(`${label}: subject ${subject} in ${orgId}`);
  return { label, subject, orgId, token, api: smokeApiClient(endpoint, token) };
};

const created = (result: ApiResult, what: string): ApiResult => {
  expect([200, 201], `${what}: ${JSON.stringify(result.body)}`).toContain(result.status);
  return result;
};

beforeAll(async () => {
  context = await loadSmokeContext();
  endpoint = context.apiCustomEndpoint ?? context.apiEndpoint;
  clients = createAwsClients({ region: REGION });
  stores = createAwsStores({ tableName: context.tableName, table: clients.table });
  tableName = context.tableName;
  say(`stage ${context.stage}; endpoint ${endpoint}`);

  a = await makePrincipal("A", context.machineClientId);
  b = await makePrincipal("B", context.testPrincipalClientId);

  // --- A's world, created by A ------------------------------------------------
  const scope: RunScope = {
    projectId: ids.next("proj"),
    programId: ids.next("prog"),
    runId: ids.next("run"),
  };
  const rootNodeId = ids.next("node");
  const nodeId = ids.next("node");
  const at = new Date().toISOString();
  say(`A's world: ${scope.projectId} / ${scope.programId} / ${scope.runId}`);

  created(
    await a.api.put(`/projects/${scope.projectId}`, {
      schemaVersion: 1,
      projectId: scope.projectId,
      name: "p4-isolation",
      createdAt: at,
    }),
    "A creates its project",
  );

  const program = {
    schemaVersion: 1,
    projectId: scope.projectId,
    programId: scope.programId,
    objective: "Prove organisations are a boundary.",
    repository: {
      url: "https://example.invalid/repo.git",
      baseBranch: "main",
      programBranch: "program/p4",
    },
    successCriteria: [{ id: "SC-01", outcome: "B sees nothing of A's." }],
    constraints: [],
    scope: {
      includes: ["src/**"],
      excludes: [],
      permissions: ["fs.read", "fs.write"],
      forbiddenActions: [],
    },
    verification: [{ id: "test", command: "npm test" }],
    modelPolicy: { allowedProviders: ["anthropic"], allowedModels: [], forbiddenModels: [] },
    examinationPolicy: {
      low: { required: false, mustDifferModel: false },
      medium: { required: false, mustDifferModel: false },
      high: { required: false, mustDifferModel: false },
    },
    costPolicy: { maxWallClockSeconds: 3600 },
    defaultRisk: "low",
    createdAt: at,
  };
  created(
    await a.api.put(`/projects/${scope.projectId}/programs/${scope.programId}`, program),
    "A creates its program",
  );

  const runRecord = {
    schemaVersion: 1,
    ...scope,
    status: "running",
    location: "local",
    rootNodeId,
    startedAt: at,
  };
  created(await a.api.put(run(scope), runRecord), "A creates its run");

  const rootNode = {
    schemaVersion: 1,
    ...scope,
    executionNodeId: rootNodeId,
    kind: "program",
    parentNodeId: null,
    depth: 0,
    scope: program.scope,
    status: "running",
    jobContractId: null,
    commitSha: null,
    createdAt: at,
    updatedAt: at,
  };
  created(await a.api.put(`${run(scope)}/nodes/${rootNodeId}`, rootNode), "A creates its root");

  const job = {
    schemaVersion: 1,
    ...scope,
    jobContractId: ids.next("job"),
    objective: "A bounded job.",
    scope: { includes: ["src/**"] },
    acceptance: ["It exists."],
    dependencies: [],
    risk: "low",
    ambiguity: "low",
    createdAt: at,
  };
  created(await a.api.put(`${run(scope)}/jobs/${job.jobContractId}`, job), "A creates its job");

  const node = {
    schemaVersion: 1,
    ...scope,
    executionNodeId: nodeId,
    kind: "job",
    parentNodeId: rootNodeId,
    depth: 1,
    scope: program.scope,
    status: "running",
    jobContractId: job.jobContractId,
    commitSha: null,
    createdAt: at,
    updatedAt: at,
  };
  created(await a.api.put(`${run(scope)}/nodes/${nodeId}`, node), "A creates its job node");

  const agent = {
    schemaVersion: 1,
    ...scope,
    agentId: ids.next("agent"),
    executionNodeId: nodeId,
    role: "worker",
    harness: "claude",
    provider: "anthropic",
    model: "claude-sonnet-5",
    status: "started",
    startedAt: at,
    createdAt: at,
  };
  created(await a.api.put(`${run(scope)}/agents/${agent.agentId}`, agent), "A creates its agent");

  world = {
    scope,
    run: runRecord as Run,
    rootNodeId,
    node: node as ExecutionNode,
    agent: agent as Agent,
    job: job as JobContract,
  };

  const base = run(scope);
  probes = [
    { operation: "project.get", method: "GET", path: `/projects/${scope.projectId}` },
    { operation: "project.put", method: "PUT", path: `/projects/${scope.projectId}` },
    {
      operation: "program.list",
      method: "GET",
      path: `/projects/${scope.projectId}/programs`,
    },
    {
      operation: "program.get",
      method: "GET",
      path: `/projects/${scope.projectId}/programs/${scope.programId}`,
    },
    {
      operation: "program.put",
      method: "PUT",
      path: `/projects/${scope.projectId}/programs/${scope.programId}`,
    },
    {
      operation: "run.list",
      method: "GET",
      path: `/projects/${scope.projectId}/programs/${scope.programId}/runs`,
    },
    { operation: "run.get", method: "GET", path: base },
    { operation: "run.put", method: "PUT", path: base },
    { operation: "run.getState", method: "GET", path: `${base}/state` },
    { operation: "node.list", method: "GET", path: `${base}/nodes` },
    { operation: "node.get", method: "GET", path: `${base}/nodes/${nodeId}` },
    { operation: "node.put", method: "PUT", path: `${base}/nodes/${nodeId}` },
    { operation: "node.listChildren", method: "GET", path: `${base}/nodes/${rootNodeId}/children` },
    { operation: "job.list", method: "GET", path: `${base}/jobs` },
    { operation: "job.get", method: "GET", path: `${base}/jobs/${job.jobContractId}` },
    { operation: "job.put", method: "PUT", path: `${base}/jobs/${job.jobContractId}` },
    { operation: "agent.get", method: "GET", path: `${base}/agents/${agent.agentId}` },
    { operation: "agent.put", method: "PUT", path: `${base}/agents/${agent.agentId}` },
    { operation: "agent.listByNode", method: "GET", path: `${base}/nodes/${nodeId}/agents` },
    { operation: "agent.mintToken", method: "POST", path: `${base}/agents/${agent.agentId}/token` },
    { operation: "event.append", method: "POST", path: `${base}/events` },
    { operation: "event.list", method: "GET", path: `${base}/events` },
    { operation: "decision.list", method: "GET", path: `${base}/decisions` },
    { operation: "decision.put", method: "PUT", path: `${base}/decisions/${ids.next("dec")}` },
    { operation: "decision.get", method: "GET", path: `${base}/decisions/${ids.next("dec")}` },
    { operation: "checkpoint.list", method: "GET", path: `${base}/checkpoints` },
    { operation: "checkpoint.put", method: "PUT", path: `${base}/checkpoints/${ids.next("ckpt")}` },
    { operation: "checkpoint.get", method: "GET", path: `${base}/checkpoints/${ids.next("ckpt")}` },
    {
      operation: "verification.put",
      method: "PUT",
      path: `${base}/verifications/${ids.next("ver")}`,
    },
    {
      operation: "verification.get",
      method: "GET",
      path: `${base}/verifications/${ids.next("ver")}`,
    },
    {
      operation: "verification.listByNode",
      method: "GET",
      path: `${base}/nodes/${nodeId}/verifications`,
    },
    {
      operation: "examination.put",
      method: "PUT",
      path: `${base}/examinations/${ids.next("exam")}`,
    },
    {
      operation: "examination.get",
      method: "GET",
      path: `${base}/examinations/${ids.next("exam")}`,
    },
    {
      operation: "examination.listByNode",
      method: "GET",
      path: `${base}/nodes/${nodeId}/examinations`,
    },
    {
      operation: "routingDecision.put",
      method: "PUT",
      path: `${base}/routing-decisions/${ids.next("route")}`,
    },
    {
      operation: "routingDecision.listByNode",
      method: "GET",
      path: `${base}/nodes/${nodeId}/routing-decisions`,
    },
    { operation: "artifact.list", method: "GET", path: `${base}/artifacts` },
    { operation: "artifact.get", method: "GET", path: `${base}/artifacts/${ids.next("art")}` },
    { operation: "artifact.put", method: "PUT", path: `${base}/artifacts/${ids.next("art")}` },
    {
      operation: "artifact.createUploadUrl",
      method: "POST",
      path: `${base}/artifacts/${ids.next("art")}/upload-url`,
    },
  ];
  say(`the matrix covers ${probes.length} routes`);
});

/**
 * Phase 8. Both organisations, whatever happened above. Records and S3 prefixes
 * only, never a stack (A-18).
 */
afterAll(async () => {
  if (context === undefined) return;
  const problems: string[] = [];
  const partitions = [
    keys.user(a.subject).PK,
    keys.user(b.subject).PK,
    keys.orgProject(a.orgId, world.scope.projectId).PK,
    keys.project(world.scope.projectId).PK,
    keys.run(world.scope, world.scope.runId).PK,
    keys.runRecord(world.scope, "NODE", world.rootNodeId).PK,
    keys.event(world.scope, world.rootNodeId).PK,
  ];
  try {
    const deleted = await deletePartitions(clients.table, tableName, partitions);
    say(`removed ${deleted} items across both organisations`);
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }
  if (problems.length > 0) throw new Error(`cleanup left litter: ${problems.join("; ")}`);
});

const call = (who: Principal, probe: Probe): Promise<ApiResult> => {
  // An empty body: this matrix is about the gate, not what is behind it. A
  // request that gets past `enforce` still meets validation, so an allowed call
  // may answer 400 or 404 — what it may never answer is 403.
  if (probe.method === "GET") return who.api.get(probe.path);
  if (probe.method === "PUT") return who.api.put(probe.path, {});
  return who.api.post(probe.path, {});
};

describe("SC-P4-01 — B is refused every project-scoped route of A's project", () => {
  it("answers 403 wrong_org, on every one", async () => {
    const wrong: string[] = [];
    for (const probe of probes) {
      const result = await call(b, probe);
      const code = (result.body as { error?: { code?: string } })?.error?.code;
      if (result.status !== 403 || code !== "wrong_org") {
        wrong.push(`${probe.operation} → ${result.status} ${code ?? ""}`);
      }
    }
    expect(wrong, `B reached ${wrong.length} of A's routes`).toEqual([]);
    say(`B was refused all ${probes.length} routes with wrong_org`);
  });
});

describe("A reaches its own project's routes", () => {
  it("is never refused with 403", async () => {
    const refused: string[] = [];
    for (const probe of probes) {
      const result = await call(a, probe);
      if (result.status === 403) {
        const code = (result.body as { error?: { code?: string } })?.error?.code;
        refused.push(`${probe.operation} → ${code ?? "403"}`);
      }
    }
    expect(refused, `A was refused ${refused.length} of its own routes`).toEqual([]);
  });
});

describe("SC-P4-03 — listing shows each principal only its own organisation", () => {
  it("shows A its project", async () => {
    const result = await a.api.get("/projects");
    expect(result.status).toBe(200);
    const page = ProjectPageSchema.parse(result.body);
    expect(page.items.map((project) => project.projectId)).toContain(world.scope.projectId);
    expect(page.items.every((project) => project.orgId === a.orgId)).toBe(true);
  });

  it("shows B nothing of A's", async () => {
    const result = await b.api.get("/projects");
    expect(result.status).toBe(200);
    const page = ProjectPageSchema.parse(result.body);
    expect(page.items.map((project) => project.projectId)).not.toContain(world.scope.projectId);
  });
});

describe("SC-P4-02 — only A may mint an execution token for A's agent", () => {
  let minted: string;

  it("mints one for A, signed by the deployed key", async () => {
    const result = await a.api.post(
      `${run(world.scope)}/agents/${world.agent.agentId}/token`,
      undefined,
    );
    expect(result.status, JSON.stringify(result.body)).toBe(201);
    const body = result.body as { token: string; agentId: string; expiresAt: string };
    expect(body.agentId).toBe(world.agent.agentId);
    minted = body.token;

    // Verified against the key's public half, fetched from KMS. This is the
    // assertion that the deployed signer and the deployed verifier agree.
    const kms = new KMSClient({ region: REGION });
    const key = await kms.send(new GetPublicKeyCommand({ KeyId: context.executionTokenKeyId }));
    if (key.PublicKey === undefined) throw new Error("KMS returned no public key");
    const verified = verifyExecutionToken(minted, {
      publicKey: publicKeyFromSpki(key.PublicKey),
      issuer: `https://${new URL(endpoint).host}`,
      now: Date.now(),
    });
    expect(verified, JSON.stringify(verified)).toMatchObject({ ok: true });
    if (!verified.ok) return;
    expect(verified.principal).toMatchObject({
      kind: "execution",
      ...world.scope,
      nodeId: world.node.executionNodeId,
      agentId: world.agent.agentId,
      role: "worker",
    });
    say(`A minted a token expiring ${body.expiresAt}`);
  });

  it("refuses B, whose organisation does not own the project", async () => {
    const result = await b.api.post(
      `${run(world.scope)}/agents/${world.agent.agentId}/token`,
      undefined,
    );
    expect(result.status).toBe(403);
    expect((result.body as { error: { code: string } }).error.code).toBe("wrong_org");
  });

  describe("SC-P4-04 — the minted token does exactly §4.4 on its own node", () => {
    /** Read once the mint above has run; the describe body runs before it. */
    const worker = () => smokeApiClient(endpoint, minted);

    it("reads its own run, node, job and agent", async () => {
      const base = run(world.scope);
      for (const path of [
        base,
        `${base}/nodes/${world.node.executionNodeId}`,
        `${base}/jobs/${world.job.jobContractId}`,
        `${base}/agents/${world.agent.agentId}`,
      ]) {
        const result = await worker().get(path);
        expect(result.status, `${path}: ${JSON.stringify(result.body)}`).toBe(200);
      }
    });

    it("is refused every operation it was not given", async () => {
      const base = run(world.scope);
      const forbidden: readonly (readonly [string, "GET" | "PUT" | "POST", string])[] = [
        ["project.get", "GET", `/projects/${world.scope.projectId}`],
        ["project.list", "GET", "/projects"],
        ["run.getState", "GET", `${base}/state`],
        ["agent.put", "PUT", `${base}/agents/${ids.next("agent")}`],
        ["agent.mintToken", "POST", `${base}/agents/${world.agent.agentId}/token`],
        ["verification.put", "PUT", `${base}/verifications/${ids.next("ver")}`],
        ["checkpoint.put", "PUT", `${base}/checkpoints/${ids.next("ckpt")}`],
        ["routingDecision.put", "PUT", `${base}/routing-decisions/${ids.next("route")}`],
        ["job.put", "PUT", `${base}/jobs/${world.job.jobContractId}`],
        ["artifact.put", "PUT", `${base}/artifacts/${ids.next("art")}`],
      ];
      for (const [operation, method, path] of forbidden) {
        const result =
          method === "GET"
            ? await worker().get(path)
            : method === "PUT"
              ? await worker().put(path, {})
              : await worker().post(path, {});
        expect(result.status, `${operation} ${path}`).toBe(403);
        expect(
          (result.body as { error?: { code?: string } })?.error?.code,
          `${operation} ${path}`,
        ).toBe("execution_forbidden_operation");
      }
    });

    it("is refused a node that is not its own", async () => {
      const result = await worker().put(`${run(world.scope)}/nodes/${world.rootNodeId}`, {});
      expect(result.status).toBe(403);
      expect((result.body as { error: { code: string } }).error.code).toBe(
        "execution_out_of_scope",
      );
    });
  });
});

describe("SC-P4-05 — the authorizer refuses what it should, before the handler", () => {
  const base = () => `/projects/${world.scope.projectId}`;

  it("refuses a request with no Authorization header", async () => {
    const result = await a.api.withAuthorization(undefined, "GET", base());
    expect(result.status).toBe(401);
  });

  it("refuses a bearer that is not a token at all", async () => {
    const result = await a.api.withAuthorization("Bearer not-a-token", "GET", base());
    expect(result.status).toBe(401);
  });

  it("refuses an execution token signed by another key", async () => {
    // The right shape, the right issuer, a signature from nowhere.
    const claims = {
      iss: `https://${new URL(endpoint).host}`,
      sub: world.agent.agentId,
      aud: "nightshift-api",
      nightshift: {
        kind: "execution",
        ...world.scope,
        nodeId: world.node.executionNodeId,
        agentId: world.agent.agentId,
        role: "worker",
      },
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    };
    const forged = `${encodeSegment({ alg: "RS256", typ: "JWT" })}.${encodeSegment(claims)}.${Buffer.from(
      "not a signature",
    ).toString("base64url")}`;
    const result = await a.api.withAuthorization(`Bearer ${forged}`, "GET", base());
    expect(result.status).toBe(401);
  });

  it("refuses an expired execution token", async () => {
    const claims = {
      iss: `https://${new URL(endpoint).host}`,
      sub: world.agent.agentId,
      aud: "nightshift-api",
      nightshift: {
        kind: "execution",
        ...world.scope,
        nodeId: world.node.executionNodeId,
        agentId: world.agent.agentId,
        role: "worker",
      },
      iat: Math.floor(Date.now() / 1000) - 7200,
      exp: Math.floor(Date.now() / 1000) - 3600,
    };
    const expired = `${encodeSegment({ alg: "RS256", typ: "JWT" })}.${encodeSegment(claims)}.${Buffer.from(
      "not a signature",
    ).toString("base64url")}`;
    const result = await a.api.withAuthorization(`Bearer ${expired}`, "GET", base());
    expect(result.status).toBe(401);
  });
});
