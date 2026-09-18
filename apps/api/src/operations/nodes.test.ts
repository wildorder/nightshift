import type { ExecutionNode, OrgId } from "@nightshift/contracts";
import {
  createFixedClock,
  createFixtures,
  type Fixtures,
  makeFailedVerification,
  makeMembership,
  makeNode,
  makeProgramContract,
  makeProject,
  makeRootNode,
  makeRun,
  makeVerification,
  nextUserId,
} from "@nightshift/core";
import { createInMemoryStores, type InMemoryStores } from "@nightshift/persistence/memory";
import { describe, expect, it } from "vitest";
import { handleRequest } from "../handler.js";
import type { ApiResponse } from "../http.js";

const COMMIT = "abcdefabcdefabcdefabcdefabcdefabcdefabcd";

interface World {
  readonly stores: InMemoryStores;
  readonly f: Fixtures;
  readonly orgId: OrgId;
  readonly call: (method: string, path: string, body?: unknown) => Promise<ApiResponse>;
  readonly runPath: string;
}

const setup = async (
  limits = { maxDepth: 3, maxConcurrency: 4 },
  { withRoot = true } = {},
): Promise<World> => {
  const stores = createInMemoryStores();
  const f = createFixtures();
  const subject = nextUserId(f);
  const orgId = f.ids.next("org");
  await stores.memberships.put(makeMembership(subject, orgId));
  const deps = { stores, clock: createFixedClock(Date.parse("2026-09-14T10:00:00.000Z")) };
  const call = (method: string, path: string, body?: unknown) =>
    handleRequest(deps, {
      method,
      path,
      query: {},
      body,
      principal: { kind: "user", userId: subject },
    });

  await stores.projects.put(makeProject(f, { orgId }));
  await stores.programContracts.put(makeProgramContract(f, { delegationLimits: limits }));
  await stores.runs.put(makeRun(f));
  const runPath = `/projects/${f.scope.projectId}/programs/${f.scope.programId}/runs/${f.scope.runId}`;
  const world = { stores, f, orgId, call, runPath };
  if (withRoot) expect((await putNode(world, makeRootNode(f))).status).toBe(201);
  return world;
};

const putNode = (w: World, node: ExecutionNode) =>
  w.call("PUT", `${w.runPath}/nodes/${node.executionNodeId}`, node);

const code = (response: ApiResponse): string =>
  (response.body as { error: { code: string } }).error.code;

let tick = 0;
/** The node with some fields changed and a later `updatedAt`. */
const next = (node: ExecutionNode, patch: Partial<ExecutionNode>): ExecutionNode => {
  tick += 1;
  return {
    ...node,
    ...patch,
    updatedAt: new Date(Date.parse("2026-09-14T11:00:00.000Z") + tick * 1000).toISOString(),
  };
};

describe("creating execution nodes", () => {
  it("creates the run's root, and treats an identical retry as 200", async () => {
    const w = await setup();
    expect((await putNode(w, makeRootNode(w.f))).status).toBe(200);
  });

  it("refuses a root the run does not declare", async () => {
    const w = await setup();
    const impostor = makeRootNode(w.f, { executionNodeId: w.f.ids.next("node") });
    const response = await putNode(w, impostor);
    expect(response.status).toBe(409);
    expect(code(response)).toBe("tree_structure");
  });

  it("refuses a root wider than the program contract's scope", async () => {
    const w = await setup(undefined, { withRoot: false });
    const wide = makeRootNode(w.f, {
      scope: { includes: ["**"], excludes: [], permissions: ["everything"], forbiddenActions: [] },
    });
    const response = await putNode(w, wide);
    expect(response.status).toBe(403);
    expect(code(response)).toBe("scope_widening");
  });

  it("creates a child under an existing parent", async () => {
    const w = await setup();
    expect((await putNode(w, makeNode(w.f, w.f.rootNodeId))).status).toBe(201);
  });

  it("404s a child whose parent is not in the run", async () => {
    const w = await setup();
    const response = await putNode(w, makeNode(w.f, w.f.ids.next("node")));
    expect(response.status).toBe(404);
  });

  it("refuses a child that misstates its depth", async () => {
    const w = await setup();
    const response = await putNode(w, makeNode(w.f, w.f.rootNodeId, { depth: 0 }));
    expect(response.status).toBe(409);
    expect(code(response)).toBe("tree_structure");
  });

  it("refuses delegation past the depth limit with 422", async () => {
    const w = await setup({ maxDepth: 1, maxConcurrency: 4 });
    const sub = makeNode(w.f, w.f.rootNodeId, { kind: "sub-program" });
    expect((await putNode(w, sub)).status).toBe(201);
    const response = await putNode(w, makeNode(w.f, sub.executionNodeId, { depth: 2 }));
    expect(response.status).toBe(422);
    expect(code(response)).toBe("depth_limit_exceeded");
  });

  it("refuses delegation past the concurrency limit with 429", async () => {
    const w = await setup({ maxDepth: 3, maxConcurrency: 1 });
    expect((await putNode(w, makeNode(w.f, w.f.rootNodeId, { status: "running" }))).status).toBe(
      201,
    );
    const response = await putNode(w, makeNode(w.f, w.f.rootNodeId));
    expect(response.status).toBe(429);
    expect(code(response)).toBe("concurrency_limit_exceeded");
  });

  it("refuses a child whose scope widens its parent's", async () => {
    const w = await setup();
    const response = await putNode(
      w,
      makeNode(w.f, w.f.rootNodeId, {
        scope: { includes: ["**"], excludes: [], permissions: [], forbiddenActions: [] },
      }),
    );
    expect(response.status).toBe(403);
    expect(code(response)).toBe("scope_widening");
  });

  it("refuses delegation from a leaf job", async () => {
    const w = await setup();
    const job = makeNode(w.f, w.f.rootNodeId);
    await putNode(w, job);
    const response = await putNode(w, makeNode(w.f, job.executionNodeId, { depth: 2 }));
    expect(response.status).toBe(403);
    expect(code(response)).toBe("delegation_refused");
  });

  it("refuses a node created already verified (A-05)", async () => {
    const w = await setup();
    const response = await putNode(
      w,
      makeNode(w.f, w.f.rootNodeId, { status: "verified", commitSha: COMMIT }),
    );
    expect(response.status).toBe(409);
    expect(code(response)).toBe("verification_evidence");
  });

  it("refuses a node body that lies about its ownership chain", async () => {
    const w = await setup();
    const other = createFixtures();
    const node = makeNode(w.f, w.f.rootNodeId, { projectId: other.scope.projectId });
    const response = await putNode(w, node);
    expect(response.status).toBe(403);
    expect(code(response)).toBe("ownership_violation");
  });
});

describe("updating execution nodes", () => {
  const jobIn = async (w: World) => {
    const node = makeNode(w.f, w.f.rootNodeId, { jobContractId: w.f.ids.next("job") });
    expect((await putNode(w, node)).status).toBe(201);
    return node;
  };

  /** Drives a node through legal transitions, asserting each is accepted. */
  const advance = async (w: World, node: ExecutionNode, patch: Partial<ExecutionNode>) => {
    const updated = next(node, patch);
    const response = await putNode(w, updated);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return updated;
  };

  it("accepts a legal transition and refuses an illegal one", async () => {
    const w = await setup();
    const queued = await advance(w, await jobIn(w), { status: "queued" });
    const response = await putNode(w, next(queued, { status: "sealed" }));
    expect(response.status).toBe(409);
    expect(code(response)).toBe("illegal_transition");
  });

  it("refuses a change to an immutable field", async () => {
    const w = await setup();
    const node = await jobIn(w);
    const response = await putNode(w, next(node, { kind: "sub-program" }));
    expect(response.status).toBe(409);
    expect(code(response)).toBe("conflict");
  });

  it("requires a commit to report implemented", async () => {
    const w = await setup();
    let node = await advance(w, await jobIn(w), { status: "queued" });
    node = await advance(w, node, { status: "running" });
    const bare = await putNode(w, next(node, { status: "implemented" }));
    expect(bare.status).toBe(422);
    expect(code(bare)).toBe("commit_required");
    await advance(w, node, { status: "implemented", commitSha: COMMIT });
  });

  it("asserts verified only with matching evidence, then freezes the commit", async () => {
    const w = await setup();
    let node = await advance(w, await jobIn(w), { status: "queued" });
    node = await advance(w, node, { status: "running" });
    node = await advance(w, node, { status: "implemented", commitSha: COMMIT });
    node = await advance(w, node, { status: "verifying" });

    const unevidenced = await putNode(w, next(node, { status: "verified" }));
    expect(unevidenced.status).toBe(409);
    expect(code(unevidenced)).toBe("verification_evidence");

    const verification = makeVerification(w.f, node);
    await w.call("PUT", `${w.runPath}/verifications/${verification.verificationId}`, verification);
    node = await advance(w, node, { status: "verified" });

    const moved = await putNode(
      w,
      next(node, { commitSha: "0000000000000000000000000000000000000000" }),
    );
    expect(moved.status).toBe(409);
    expect(code(moved)).toBe("verification_evidence");
  });

  it("records verification_failed only with a failed verification", async () => {
    const w = await setup();
    let node = await advance(w, await jobIn(w), { status: "queued" });
    node = await advance(w, node, { status: "running" });
    node = await advance(w, node, { status: "implemented", commitSha: COMMIT });
    node = await advance(w, node, { status: "verifying" });

    const unevidenced = await putNode(w, next(node, { status: "verification_failed" }));
    expect(code(unevidenced)).toBe("verification_evidence");

    const failure = makeFailedVerification(w.f, node);
    await w.call("PUT", `${w.runPath}/verifications/${failure.verificationId}`, failure);
    await advance(w, node, { status: "verification_failed" });
  });

  it("reads a node back", async () => {
    const w = await setup();
    const response = await w.call("GET", `${w.runPath}/nodes/${w.f.rootNodeId}`);
    expect(response.status).toBe(200);
    expect((await w.call("GET", `${w.runPath}/nodes/${w.f.ids.next("node")}`)).status).toBe(404);
  });
});
