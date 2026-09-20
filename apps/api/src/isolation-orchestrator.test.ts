/**
 * A sub-program orchestrator's token, through the real gate (P6, SC-P6-13).
 *
 * `isolation.test.ts` is P4's and is unchanged. This is its counterpart for the
 * second execution role: every route, asked by a delegating token, against its
 * own node, a node it delegated, a sibling's node, and another run. What places
 * a node in its subtree is the **stored tree**, so the tree here is real:
 *
 * ```text
 * root ── C   (sub-program; the token's own node)
 *     │   └── C1   (a job C delegated)
 *     └── A   (a sibling job the token must not reach)
 * ```
 */
import type { ExecutionPrincipal, UserId } from "@nightshift/contracts";
import {
  createFixedClock,
  createFixtures,
  EXECUTION_NODE_STATUSES,
  makeAgent,
  makeMembership,
  makeNode,
  makeProgramContract,
  makeProject,
  makeRootNode,
  makeRun,
  nextUserId,
  ORCHESTRATOR_ACCESS,
  ORCHESTRATOR_WRITABLE_NODE_STATUSES,
} from "@nightshift/core";
import { createInMemoryStores, type InMemoryStores } from "@nightshift/persistence/memory";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROUTES } from "./handler.js";
import {
  encodeTestPrincipal,
  type LocalControlPlane,
  startLocalControlPlane,
} from "./testing/local-control-plane.js";

interface World {
  readonly userId: UserId;
  readonly orchestrator: ExecutionPrincipal;
  readonly ids: ReturnType<typeof createFixtures>["ids"];
  readonly base: Readonly<Record<string, string>>;
  readonly own: string;
  readonly descendant: string;
  readonly sibling: string;
  readonly root: string;
}

const seed = async (stores: InMemoryStores): Promise<World> => {
  const f = createFixtures();
  const orgId = f.ids.next("org");
  const userId = nextUserId(f);
  await stores.memberships.put(makeMembership(userId, orgId));
  await stores.projects.put(makeProject(f, { orgId }));
  await stores.programContracts.put(
    makeProgramContract(f, { delegationLimits: { maxDepth: 3, maxConcurrency: 4 } }),
  );
  const root = makeRootNode(f);
  await stores.runs.put(makeRun(f, { rootNodeId: root.executionNodeId }));
  const c = makeNode(f, root.executionNodeId, { kind: "sub-program", status: "running" });
  const c1 = makeNode(f, c.executionNodeId, { depth: 2, status: "running" });
  const a = makeNode(f, root.executionNodeId, { status: "running" });
  for (const node of [root, c, c1, a]) await stores.executionNodes.put(node);
  const agent = makeAgent(f, c.executionNodeId, { role: "orchestrator", status: "started" });
  const siblingAgent = makeAgent(f, a.executionNodeId, { status: "started" });
  await stores.agents.put(agent);
  await stores.agents.put(siblingAgent);

  return {
    userId,
    ids: f.ids,
    orchestrator: {
      kind: "execution",
      ...f.scope,
      nodeId: c.executionNodeId,
      agentId: agent.agentId,
      role: "orchestrator",
    },
    base: {
      ...f.scope,
      jobContractId: f.ids.next("job"),
      decisionId: f.ids.next("dec"),
      checkpointId: f.ids.next("ckpt"),
      verificationId: f.ids.next("ver"),
      examinationId: f.ids.next("exam"),
      routingDecisionId: f.ids.next("route"),
      artifactId: f.ids.next("art"),
      agentId: agent.agentId,
      siblingAgentId: siblingAgent.agentId,
    },
    own: c.executionNodeId,
    descendant: c1.executionNodeId,
    sibling: a.executionNodeId,
    root: root.executionNodeId,
  };
};

let plane: LocalControlPlane;
let w: World;
let other: World;

beforeAll(async () => {
  const stores = createInMemoryStores();
  w = await seed(stores);
  other = await seed(stores);
  plane = await startLocalControlPlane({
    stores,
    clock: createFixedClock(Date.parse("2026-09-19T12:00:00.000Z")),
    principal: { kind: "user", userId: w.userId },
  });
});

afterAll(async () => {
  await plane?.close();
});

interface Answer {
  readonly status: number;
  readonly code: string | undefined;
}

const ask = async (
  principal: ExecutionPrincipal,
  method: string,
  template: string,
  world: World,
  nodeId: string,
  body: Readonly<Record<string, unknown>> = {},
): Promise<Answer> => {
  const params: Record<string, string> = {
    ...world.base,
    nodeId,
    agentId:
      nodeId === world.own ? (world.base.agentId as string) : (world.base.siblingAgentId as string),
  };
  const path = template.replace(/\{(\w+)\}/g, (_m, name: string) => {
    const value = params[name];
    if (value === undefined) throw new Error(`no fixture for path parameter ${name}`);
    return value;
  });
  const response = await fetch(`${plane.url}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${encodeTestPrincipal(principal)}`,
      "content-type": "application/json",
    },
    ...(method === "GET" ? {} : { body: JSON.stringify({ executionNodeId: nodeId, ...body }) }),
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
const refusalFor = (access: string): string =>
  access === "forbidden" ? "execution_forbidden_operation" : "execution_out_of_scope";

describe("a delegating token does exactly what D-P6-04 grants, on its own node", () => {
  it.each(eachRoute)("%s", async (operation, route) => {
    const answer = await ask(w.orchestrator, route.method, route.path, w, w.own, {
      status: "failed",
    });
    if (ORCHESTRATOR_ACCESS[operation] === "forbidden") {
      expect(answer).toEqual({ status: 403, code: "execution_forbidden_operation" });
      return;
    }
    expect(answer.status, `${route.method} ${route.path} answered ${answer.code}`).not.toBe(403);
  });
});

describe("a delegating token reaches a node it delegated only where the table says subtree", () => {
  it.each(eachRoute)("%s", async (operation, route) => {
    const answer = await ask(w.orchestrator, route.method, route.path, w, w.descendant, {
      status: "cancelled",
    });
    const access = ORCHESTRATOR_ACCESS[operation];
    if (access === "own_subtree" || access === "own_run") {
      expect(answer.status, `${route.method} ${route.path} answered ${answer.code}`).not.toBe(403);
      return;
    }
    expect(answer).toEqual({ status: 403, code: refusalFor(access) });
  });
});

describe("a delegating token reaches nothing on a sibling's node", () => {
  it.each(eachRoute.filter(([operation]) => ORCHESTRATOR_ACCESS[operation] !== "own_run"))(
    "%s",
    async (operation, route) => {
      for (const nodeId of [w.sibling, w.root]) {
        const answer = await ask(w.orchestrator, route.method, route.path, w, nodeId, {
          status: "cancelled",
        });
        expect(answer, nodeId).toEqual({
          status: 403,
          code: refusalFor(ORCHESTRATOR_ACCESS[operation]),
        });
      }
    },
  );
});

describe("a delegating token reaches nothing in another run", () => {
  it.each(eachRoute)("%s", async (operation, route) => {
    const answer = await ask(other.orchestrator, route.method, route.path, w, w.own, {
      status: "failed",
    });
    expect(answer).toEqual({ status: 403, code: refusalFor(ORCHESTRATOR_ACCESS[operation]) });
  });
});

describe("delegating: creating a child", () => {
  const nodeRoute = "/projects/{projectId}/programs/{programId}/runs/{runId}/nodes/{nodeId}";

  it("is allowed past the gate under its own node, and only as validated", async () => {
    const fresh = w.ids.next("node");
    const allowed = await ask(w.orchestrator, "PUT", nodeRoute, w, fresh, {
      parentNodeId: w.own,
      status: "validated",
    });
    // Past the gate: the body is not a whole node, so the operation refuses it
    // for its own reasons, which is not this file's subject.
    expect(allowed.status).not.toBe(403);

    for (const status of [
      "queued",
      "running",
      "implemented",
      "verified",
      "integrated",
      "succeeded",
    ]) {
      const refused = await ask(w.orchestrator, "PUT", nodeRoute, w, w.ids.next("node"), {
        parentNodeId: w.own,
        status,
      });
      expect(refused, status).toEqual({ status: 403, code: "execution_forbidden_operation" });
    }
  });

  it("is refused under the root, under a sibling, and under its own child", async () => {
    for (const parentNodeId of [w.root, w.sibling, w.descendant]) {
      const answer = await ask(w.orchestrator, "PUT", nodeRoute, w, w.ids.next("node"), {
        parentNodeId,
        status: "validated",
      });
      expect(answer, parentNodeId).toEqual({ status: 403, code: "execution_out_of_scope" });
    }
  });

  it("places an existing node by the stored tree, whatever the body claims about its parent", async () => {
    const answer = await ask(w.orchestrator, "PUT", nodeRoute, w, w.sibling, {
      parentNodeId: w.own,
      status: "cancelled",
    });
    expect(answer).toEqual({ status: 403, code: "execution_out_of_scope" });
  });

  it("may ask for exactly the statuses its place allows, over every status", async () => {
    const places = [
      ["self", w.own],
      ["descendant", w.descendant],
    ] as const;
    for (const [relation, nodeId] of places) {
      for (const status of EXECUTION_NODE_STATUSES) {
        const answer = await ask(w.orchestrator, "PUT", nodeRoute, w, nodeId, { status });
        const writable = (
          ORCHESTRATOR_WRITABLE_NODE_STATUSES[relation] as readonly string[]
        ).includes(status);
        expect(answer.status === 403, `${relation} → ${status}`).toBe(!writable);
      }
    }
  });

  it("cannot mint a token, even for its own agent", async () => {
    const answer = await ask(
      w.orchestrator,
      "POST",
      "/projects/{projectId}/programs/{programId}/runs/{runId}/agents/{agentId}/token",
      w,
      w.own,
    );
    expect(answer).toEqual({ status: 403, code: "execution_forbidden_operation" });
  });
});
