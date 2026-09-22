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

  it("accepts delegation past the concurrency limit, and refuses the *start* with 429 (D-P6-02)", async () => {
    const w = await setup({ maxDepth: 3, maxConcurrency: 1 });
    const first = makeNode(w.f, w.f.rootNodeId, { status: "running" });
    expect((await putNode(w, first)).status).toBe(201);

    // Excess work queues: the node exists, and may wait as long as it has to.
    const second = makeNode(w.f, w.f.rootNodeId);
    expect((await putNode(w, second)).status).toBe(201);
    const queued = next(second, { status: "queued" });
    expect((await putNode(w, queued)).status).toBe(200);

    // The limit is the start edge's, whatever asks.
    const early = await putNode(w, next(queued, { status: "running" }));
    expect(early.status).toBe(429);
    expect(code(early)).toBe("concurrency_limit_exceeded");

    // A slot frees, and the same request is accepted.
    expect((await putNode(w, next(first, { status: "failed" }))).status).toBe(200);
    expect((await putNode(w, next(queued, { status: "running" }))).status).toBe(200);
  });

  it("counts slots per parent: a running sub-program never blocks its own children", async () => {
    const w = await setup({ maxDepth: 3, maxConcurrency: 1 });
    const sub = makeNode(w.f, w.f.rootNodeId, { kind: "sub-program", status: "running" });
    expect((await putNode(w, sub)).status).toBe(201);
    const child = makeNode(w.f, sub.executionNodeId, {
      depth: 2,
      jobContractId: w.f.ids.next("job"),
    });
    expect((await putNode(w, child)).status).toBe(201);
    const queued = next(child, { status: "queued" });
    expect((await putNode(w, queued)).status).toBe(200);
    expect((await putNode(w, next(queued, { status: "running" }))).status).toBe(200);
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

  it("lets a running program node end succeeded, once, and never a job (D-P5-06)", async () => {
    const w = await setup();
    // The fixture's root is already `running`.
    let root = makeRootNode(w.f);
    // Not from anywhere but `running`: a queued sub-program cannot.
    const queuedChild = await advance(
      w,
      await (async () => {
        const node = makeNode(w.f, w.f.rootNodeId, { kind: "sub-program" });
        expect((await putNode(w, node)).status).toBe(201);
        return node;
      })(),
      { status: "queued" },
    );
    const early = await putNode(w, next(queuedChild, { status: "succeeded" }));
    expect(early.status).toBe(409);
    expect(code(early)).toBe("illegal_transition");

    const job = await advance(w, await advance(w, await jobIn(w), { status: "queued" }), {
      status: "running",
    });

    const asJob = await putNode(w, next(job, { status: "succeeded" }));
    expect(asJob.status).toBe(409);
    expect(code(asJob)).toBe("illegal_transition");

    // Not while anything under it is still in flight (D-P6-03).
    const busy = await putNode(w, next(root, { status: "succeeded" }));
    expect(busy.status).toBe(409);
    expect(code(busy)).toBe("conflict");
    await advance(w, job, { status: "failed" });
    await advance(w, queuedChild, { status: "cancelled" });

    root = await advance(w, root, { status: "succeeded" });
    // Terminal: nothing leaves it.
    // And a finished program takes no further children.
    expect((await putNode(w, makeNode(w.f, w.f.rootNodeId))).status).toBe(403);
    for (const status of ["running", "failed", "cancelled"] as const) {
      expect((await putNode(w, next(root, { status }))).status, status).toBe(409);
    }
  });

  it("refuses a node created already succeeded", async () => {
    const w = await setup();
    const child = makeNode(w.f, w.f.rootNodeId, { kind: "job", status: "succeeded" });
    const response = await putNode(w, child);
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

  it("defers only with a deferred verification, and verifies only through verifying (D-P7-10)", async () => {
    const w = await setup();
    let node = await advance(w, await jobIn(w), { status: "queued" });
    node = await advance(w, node, { status: "running" });
    node = await advance(w, node, { status: "implemented", commitSha: COMMIT });
    node = await advance(w, node, { status: "verifying" });

    const unevidenced = await putNode(w, next(node, { status: "deferred" }));
    expect(code(unevidenced)).toBe("verification_evidence");

    const commands = [
      { stepId: "test", command: "npm test", exitCode: 0, durationMs: 1 },
      {
        stepId: "e2e",
        command: "npm run e2e",
        durationMs: 0,
        deferred: { prerequisiteId: "HP-01" },
      },
    ];
    const deferral = makeVerification(w.f, node, { commands, outcome: "deferred" });
    await w.call("PUT", `${w.runPath}/verifications/${deferral.verificationId}`, deferral);
    node = await advance(w, node, { status: "deferred" });

    // A deferral is not evidence: nothing leads from here but back, or out.
    for (const status of ["verified", "sealed", "integrated", "queued"] as const) {
      const skipped = await putNode(w, next(node, { status }));
      expect(skipped.status, status).toBe(409);
    }
    node = await advance(w, node, { status: "verifying" });
    const still = await putNode(w, next(node, { status: "verified" }));
    expect(code(still)).toBe("verification_evidence");

    const passed = makeVerification(w.f, node);
    await w.call("PUT", `${w.runPath}/verifications/${passed.verificationId}`, passed);
    await advance(w, node, { status: "verified" });
  });

  it("reads a node back", async () => {
    const w = await setup();
    const response = await w.call("GET", `${w.runPath}/nodes/${w.f.rootNodeId}`);
    expect(response.status).toBe(200);
    expect((await w.call("GET", `${w.runPath}/nodes/${w.f.ids.next("node")}`)).status).toBe(404);
  });
});
