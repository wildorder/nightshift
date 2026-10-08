/**
 * The two-principal matrix, offline (T3 deliverable 5; SC-P4-01 … SC-P4-05).
 *
 * Every route in the table, driven over real HTTP against the real handler, as
 * each of four callers:
 *
 * - **user A**, whose organisation owns the target project;
 * - **user B**, in another organisation entirely;
 * - **an execution** bound to a node inside A's run;
 * - **an execution** bound to a node in a different run.
 *
 * The assertion is about **authorisation only**. A request that gets past
 * `enforce` still meets validation, referential integrity and the domain rules,
 * so an allowed call here may well answer 400, 404 or 409 — what it may never
 * answer is 403. That is deliberate: this file proves the boundary, and the
 * suites beside it prove the behaviour. Bodies are therefore not built; a `PUT`
 * with no body is refused *after* the check that is under test.
 *
 * The deployed half of the same matrix is the smoke suite (T5).
 */
import type { ExecutionPrincipal, OrgId, UserId } from "@nightshift/contracts";
import {
  createFixedClock,
  createFixtures,
  EXECUTION_ACCESS,
  EXECUTION_NODE_STATUSES,
  EXECUTION_WRITABLE_NODE_STATUSES,
  type Fixtures,
  makeAgent,
  makeMembership,
  makeNode,
  makeProgramContract,
  makeProject,
  makeRootNode,
  makeRun,
  nextUserId,
} from "@nightshift/core";
import { createInMemoryStores, type InMemoryStores } from "@nightshift/persistence/memory";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RequestPrincipal } from "./auth/principal.js";
import { ROUTES } from "./handler.js";
import {
  encodeTestPrincipal,
  type LocalControlPlane,
  startLocalControlPlane,
} from "./testing/local-control-plane.js";

const NOW = Date.parse("2026-09-17T12:00:00.000Z");

/**
 * Every path parameter the route table uses, named rather than indexed, so a
 * route that grows a new segment fails to compile here instead of substituting
 * `undefined` into a URL.
 */
interface RouteParams {
  readonly projectId: string;
  readonly programId: string;
  readonly runId: string;
  readonly nodeId: string;
  readonly agentId: string;
  readonly jobContractId: string;
  readonly decisionId: string;
  readonly checkpointId: string;
  readonly verificationId: string;
  readonly examinationId: string;
  readonly routingDecisionId: string;
  readonly artifactId: string;
  readonly [name: string]: string;
}

interface World {
  readonly f: Fixtures;
  readonly orgId: OrgId;
  readonly userId: UserId;
  readonly params: RouteParams;
  readonly execution: ExecutionPrincipal;
}

/** One org, one user, and a run complete enough for every route to name something real. */
const seed = async (stores: InMemoryStores): Promise<World> => {
  const f = createFixtures();
  const orgId = f.ids.next("org");
  const userId = nextUserId(f);
  await stores.memberships.put(makeMembership(userId, orgId));

  const project = makeProject(f, { orgId });
  const program = makeProgramContract(f);
  const root = makeRootNode(f);
  const run = makeRun(f, { rootNodeId: root.executionNodeId });
  const node = makeNode(f, root.executionNodeId);
  const agent = makeAgent(f, node.executionNodeId, { status: "started" });

  await stores.projects.put(project);
  await stores.programContracts.put(program);
  await stores.runs.put(run);
  await stores.executionNodes.put(root);
  await stores.executionNodes.put(node);
  await stores.agents.put(agent);

  return {
    f,
    orgId,
    userId,
    params: {
      projectId: f.scope.projectId,
      programId: f.scope.programId,
      runId: f.scope.runId,
      nodeId: node.executionNodeId,
      agentId: agent.agentId,
      jobContractId: f.ids.next("job"),
      decisionId: f.ids.next("dec"),
      checkpointId: f.ids.next("ckpt"),
      verificationId: f.ids.next("ver"),
      examinationId: f.ids.next("exam"),
      routingDecisionId: f.ids.next("route"),
      artifactId: f.ids.next("art"),
      // Program-scoped planning routes (P7): named by a digest and an `HP-nn`, not by an id.
      // P8: an org's own configuration routes are named by the org.
      orgId,
      sha256: "a".repeat(64),
      prerequisiteId: "HP-01",
      // P10: an org's provider key routes are named by the provider, and an
      // installation route by the installation.
      provider: "anthropic",
      installationId: "1",
    },
    execution: {
      kind: "execution",
      projectId: f.scope.projectId,
      programId: f.scope.programId,
      runId: f.scope.runId,
      nodeId: node.executionNodeId,
      agentId: agent.agentId,
      role: "worker",
    },
  };
};

let plane: LocalControlPlane;
let a: World;
let b: World;

beforeAll(async () => {
  const stores = createInMemoryStores();
  a = await seed(stores);
  b = await seed(stores);
  plane = await startLocalControlPlane({
    stores,
    clock: createFixedClock(NOW),
    principal: { kind: "user", userId: a.userId },
  });
});

afterAll(async () => {
  await plane?.close();
});

const pathFor = (template: string, params: RouteParams): string =>
  template.replace(/\{(\w+)\}/g, (_match, name: string) => {
    const value = params[name];
    if (value === undefined) throw new Error(`no fixture for path parameter ${name}`);
    return value;
  });

interface Answer {
  readonly status: number;
  readonly code: string | undefined;
}

/**
 * `nodeId` is the node the body names, for the two routes whose node is a field
 * rather than a path segment (`event.append`, `decision.put`). Every other route
 * ignores it, and no route here sends a body complete enough to be stored — this
 * file is about the gate, not what is behind it.
 */
const callAs = async (
  principal: RequestPrincipal,
  method: string,
  path: string,
  nodeId: string,
  extra: Readonly<Record<string, unknown>> = {},
): Promise<Answer> => {
  const response = await fetch(`${plane.url}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${encodeTestPrincipal(principal)}`,
      "content-type": "application/json",
    },
    // `status: "implemented"` is what a worker's `node.put` asks for when it is
    // doing its job; `authorize` refuses an execution any other (see the block at
    // the end of this file). Every other route ignores the field.
    ...(method === "GET"
      ? {}
      : { body: JSON.stringify({ executionNodeId: nodeId, status: "implemented", ...extra }) }),
  });
  const text = await response.text();
  let code: string | undefined;
  try {
    code = (JSON.parse(text) as { error?: { code?: string } }).error?.code;
  } catch {
    code = undefined;
  }
  return { status: response.status, code };
};

const eachRoute = ROUTES.map((route) => [route.operation, route] as const);

describe("SC-P4-01 — a user in another organisation is refused every project-scoped route", () => {
  it.each(eachRoute)("%s", async (_operation, route) => {
    const path = pathFor(route.path, a.params);
    const answer = await callAs(
      { kind: "user", userId: b.userId },
      route.method,
      path,
      a.params.nodeId,
    );

    if (route.path === "/projects" || route.path === "/github/app") {
      // The routes with no target project or org: `/projects` is scoped by
      // filtering, not by refusing, and SC-P4-03 below is where that is
      // asserted; `/github/app` (P10) names the one App every org installs.
      expect(answer.status).not.toBe(403);
      return;
    }
    expect(answer.status).toBe(403);
    expect(answer.code).toBe("wrong_org");
  });
});

describe("a user in the owning organisation is refused nothing", () => {
  it.each(eachRoute)("%s", async (_operation, route) => {
    const path = pathFor(route.path, a.params);
    const answer = await callAs(
      { kind: "user", userId: a.userId },
      route.method,
      path,
      a.params.nodeId,
    );
    // Never 403. It may be anything else: an empty body is not a valid record.
    expect(answer.status, `${route.method} ${path} answered ${answer.code}`).not.toBe(403);
  });
});

describe("SC-P4-03 — listing projects returns only the caller's organisation's", () => {
  it("shows A its own project and nothing of B's", async () => {
    const response = await fetch(`${plane.url}/projects`, {
      headers: {
        authorization: `Bearer ${encodeTestPrincipal({ kind: "user", userId: a.userId })}`,
      },
    });
    const body = (await response.json()) as { items: { projectId: string; orgId: string }[] };
    expect(response.status).toBe(200);
    expect(body.items.map((project) => project.projectId)).toEqual([a.params.projectId]);
    expect(body.items.every((project) => project.orgId === a.orgId)).toBe(true);
  });

  it("shows B its own project and nothing of A's", async () => {
    const response = await fetch(`${plane.url}/projects`, {
      headers: {
        authorization: `Bearer ${encodeTestPrincipal({ kind: "user", userId: b.userId })}`,
      },
    });
    const body = (await response.json()) as { items: { projectId: string }[] };
    expect(body.items.map((project) => project.projectId)).toEqual([b.params.projectId]);
  });
});

describe("SC-P4-04 — an execution token does exactly what §4.4 grants, on its own node", () => {
  it.each(eachRoute)("%s", async (operation, route) => {
    const path = pathFor(route.path, a.params);
    const answer = await callAs(a.execution, route.method, path, a.params.nodeId);
    const access = EXECUTION_ACCESS[operation];

    if (access === "forbidden") {
      expect(answer.status).toBe(403);
      expect(answer.code).toBe("execution_forbidden_operation");
      return;
    }
    expect(answer.status, `${route.method} ${path} answered ${answer.code}`).not.toBe(403);
  });
});

describe("SC-P4-04 — an execution token reaches nothing in another run", () => {
  it.each(eachRoute)("%s", async (operation, route) => {
    const path = pathFor(route.path, a.params);
    // B's execution principal against A's run: a real token, the wrong chain.
    const answer = await callAs(b.execution, route.method, path, a.params.nodeId);
    expect(answer.status).toBe(403);
    expect(answer.code).toBe(
      EXECUTION_ACCESS[operation] === "forbidden"
        ? "execution_forbidden_operation"
        : "execution_out_of_scope",
    );
  });
});

describe("an execution token reaches nothing on a sibling node of its own run", () => {
  it.each(eachRoute.filter(([operation]) => EXECUTION_ACCESS[operation] === "own_node"))(
    "%s",
    async (_operation, route) => {
      const sibling = { ...a.params, nodeId: b.params.nodeId, agentId: b.params.agentId };
      const answer = await callAs(
        a.execution,
        route.method,
        pathFor(route.path, sibling),
        b.params.nodeId,
      );
      expect(answer.status).toBe(403);
      expect(answer.code).toBe("execution_out_of_scope");
    },
  );
});

describe("SC-P4-02 — only a user whose org owns the project may mint a token", () => {
  const tokenPath = (world: World) =>
    `/projects/${world.params.projectId}/programs/${world.params.programId}` +
    `/runs/${world.params.runId}/agents/${world.params.agentId}/token`;

  it("refuses a user in another organisation", async () => {
    const answer = await callAs(
      { kind: "user", userId: b.userId },
      "POST",
      tokenPath(a),
      a.params.nodeId,
    );
    expect(answer.status).toBe(403);
    expect(answer.code).toBe("wrong_org");
  });

  it("refuses an execution token, even for its own agent", async () => {
    const answer = await callAs(a.execution, "POST", tokenPath(a), a.params.nodeId);
    expect(answer.status).toBe(403);
    expect(answer.code).toBe("execution_forbidden_operation");
  });

  it("allows the owning organisation's user as far as the signer", async () => {
    // This plane has no signer wired, so the honest answer past `enforce` is 501.
    // What matters is that it is not 403.
    const answer = await callAs(
      { kind: "user", userId: a.userId },
      "POST",
      tokenPath(a),
      a.params.nodeId,
    );
    expect(answer.status).not.toBe(403);
  });
});

describe("the refusals themselves", () => {
  it("names no record and leaks no existence", async () => {
    const stranger = `${a.f.ids.next("proj")}`;
    const node = a.params.nodeId;
    const mine = await callAs(
      { kind: "user", userId: b.userId },
      "GET",
      `/projects/${a.params.projectId}`,
      node,
    );
    const absent = await callAs(
      { kind: "user", userId: b.userId },
      "GET",
      `/projects/${stranger}`,
      node,
    );
    // A project that exists in another org is a 403; one that exists nowhere is a
    // 404. The pair is the whole leak surface, and it reveals only non-existence.
    expect(mine.status).toBe(403);
    expect(absent.status).toBe(404);
  });

  it("refuses a caller whose principal is unreadable", async () => {
    const response = await fetch(`${plane.url}/projects`, {
      headers: { authorization: "Bearer test-principal.not-base64url-json" },
    });
    expect(response.status).toBe(401);
  });
});

/**
 * An allowed operation is not an allowed content (found in review after P4
 * merged). `node.put` on its own node is how a worker reports, and the only two
 * things it may report are `implemented` and `failed`. Everything else is
 * Nightshift's to assert, and is refused at the gate, before the operation
 * parses a byte of the body.
 */
describe("an execution token may only report its own node implemented or failed", () => {
  const ownNodePath = () =>
    pathFor("/projects/{projectId}/programs/{programId}/runs/{runId}/nodes/{nodeId}", a.params);

  it.each(
    EXECUTION_NODE_STATUSES.filter(
      (status) => !EXECUTION_WRITABLE_NODE_STATUSES.includes(status),
    ).map((status) => [status] as const),
  )("is refused %s", async (status) => {
    const answer = await callAs(a.execution, "PUT", ownNodePath(), a.params.nodeId, { status });
    expect(answer.status).toBe(403);
    expect(answer.code).toBe("execution_forbidden_operation");
  });

  it.each(EXECUTION_WRITABLE_NODE_STATUSES.map((status) => [status] as const))(
    "is let through the gate for %s",
    async (status) => {
      const answer = await callAs(a.execution, "PUT", ownNodePath(), a.params.nodeId, { status });
      // Past the gate the body is incomplete and validation answers; what it may
      // never answer is 403.
      expect(answer.status).not.toBe(403);
    },
  );

  it("is refused a node.put that names no status at all", async () => {
    const answer = await callAs(a.execution, "PUT", ownNodePath(), a.params.nodeId, {
      status: undefined,
    });
    expect(answer.status).toBe(403);
    expect(answer.code).toBe("execution_forbidden_operation");
  });

  it("leaves a user free to assert any status the transition table allows", async () => {
    const answer = await callAs(
      { kind: "user", userId: a.userId },
      "PUT",
      ownNodePath(),
      a.params.nodeId,
      { status: "verifying" },
    );
    expect(answer.status).not.toBe(403);
  });
});
