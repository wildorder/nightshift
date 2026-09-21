import type { ExecutionNode, ExecutionNodeStatus } from "@nightshift/contracts";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createFixtures, makeNode, makeRootNode } from "../testing/factories.js";
import { checkAuthority, checkDelegation, maySlotStart } from "./delegation.js";
import { buildTree } from "./execution-tree.js";
import { isSettled, mayEndProgramNode, nextToIntegrate, SETTLED_STATUSES } from "./integration.js";
import { EXECUTION_NODE_STATUSES, OCCUPIES_CONCURRENCY_SLOT } from "./transitions.js";

const world = (children: readonly ExecutionNodeStatus[], kind: "job" | "sub-program" = "job") => {
  const f = createFixtures();
  const root = makeRootNode(f);
  const nodes = children.map((status) =>
    makeNode(f, root.executionNodeId, { kind, status, jobContractId: f.ids.next("job") }),
  );
  return { f, root, nodes, tree: buildTree([root, ...nodes]) };
};

describe("the concurrency limit applies at start, per parent (D-P6-02)", () => {
  it("says yes exactly when the parent has a free slot, by P1's own count", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...EXECUTION_NODE_STATUSES), { minLength: 1, maxLength: 8 }),
        fc.integer({ min: 1, max: 6 }),
        (statuses, maxConcurrency) => {
          const { tree, nodes } = world(["queued", ...statuses]);
          const holding = statuses.filter((s) => OCCUPIES_CONCURRENCY_SLOT.includes(s)).length;
          const queued = nodes[0] as ExecutionNode;
          const check = maySlotStart(tree, queued.executionNodeId, { maxDepth: 9, maxConcurrency });
          expect(check.free).toBe(holding < maxConcurrency);
          if (!check.free) expect(check).toMatchObject({ running: holding, maxConcurrency });
        },
      ),
    );
  });

  it("never limits the root, and never counts another parent's children", () => {
    const f = createFixtures();
    const root = makeRootNode(f);
    const c = makeNode(f, root.executionNodeId, { kind: "sub-program", status: "running" });
    const c1 = makeNode(f, c.executionNodeId, { status: "queued", depth: 2 });
    const a = makeNode(f, root.executionNodeId, { status: "running" });
    const tree = buildTree([root, c, c1, a]);
    const limits = { maxDepth: 3, maxConcurrency: 1 };
    expect(maySlotStart(tree, root.executionNodeId, limits).free).toBe(true);
    // C holds one of the root's slots, not one of its own children's: no deadlock.
    expect(maySlotStart(tree, c1.executionNodeId, limits).free).toBe(true);
  });

  it("accepts a delegation the limit would have refused, and still refuses everything else", () => {
    const { tree, root } = world(["running", "running"]);
    const limits = { maxDepth: 1, maxConcurrency: 2 };
    expect(checkDelegation(tree, root.executionNodeId, limits).allowed).toBe(false);
    expect(checkAuthority(tree, root.executionNodeId, limits).allowed).toBe(true);

    const deep = checkAuthority(tree, root.executionNodeId, { maxDepth: 0, maxConcurrency: 2 });
    expect(deep).toMatchObject({ allowed: false, reason: { kind: "depth_limit_exceeded" } });
  });

  it("takes no children under any finished parent, succeeded included", () => {
    for (const status of ["integrated", "succeeded", "cancelled"] as const) {
      const f = createFixtures();
      const root = makeRootNode(f, { status });
      const result = checkAuthority(buildTree([root]), root.executionNodeId, {
        maxDepth: 3,
        maxConcurrency: 3,
      });
      expect(result, status).toMatchObject({
        allowed: false,
        reason: { kind: "parent_is_terminal" },
      });
    }
  });
});

describe("integration order is deterministic (D-P6-05)", () => {
  it("is the first-delegated implemented job, whatever order the nodes arrive in", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...EXECUTION_NODE_STATUSES), { minLength: 0, maxLength: 9 }),
        fc.integer(),
        (statuses, seed) => {
          const { nodes } = world(statuses);
          const ready = nodes.filter((node) => node.status === "implemented");
          const shuffled = [...nodes].sort(
            (a, b) =>
              ((a.executionNodeId.length + seed) % 3) - ((b.executionNodeId.length + seed) % 2),
          );
          const expected = [...ready].sort((a, b) =>
            a.executionNodeId < b.executionNodeId ? -1 : 1,
          )[0];
          expect(nextToIntegrate(nodes)).toEqual(expected);
          expect(nextToIntegrate(shuffled)).toEqual(expected);
          expect(nextToIntegrate([...nodes].reverse())).toEqual(expected);
        },
      ),
    );
  });

  it("never waits for unfinished work, and never takes a node that is not a job", () => {
    const { nodes } = world(["running", "implemented"]);
    expect(nextToIntegrate(nodes)?.executionNodeId).toBe(nodes[1]?.executionNodeId);
    expect(nextToIntegrate(world(["implemented"], "sub-program").nodes)).toBeUndefined();
    expect(nextToIntegrate([])).toBeUndefined();
  });
});

describe("ending a program or sub-program node (D-P6-03)", () => {
  const subProgram = (
    children: readonly ExecutionNodeStatus[],
    status: ExecutionNodeStatus = "running",
  ) => {
    const f = createFixtures();
    const root = makeRootNode(f);
    const c = makeNode(f, root.executionNodeId, { kind: "sub-program", status });
    const kids = children.map((child) =>
      makeNode(f, c.executionNodeId, { status: child, depth: 2 }),
    );
    return { c, kids, tree: buildTree([root, c, ...kids]) };
  };

  it("is allowed exactly when no descendant is still in flight", () => {
    for (const status of EXECUTION_NODE_STATUSES) {
      const { c, tree, kids } = subProgram(["integrated", status]);
      const check = mayEndProgramNode(tree, c.executionNodeId);
      expect(check.allowed, status).toBe(isSettled(status));
      if (!check.allowed) expect(check.unsettled).toEqual([kids[1]?.executionNodeId]);
    }
  });

  it("counts a failure nobody retried as settled, and an empty sub-program as endable", () => {
    expect(SETTLED_STATUSES).toContain("failed");
    expect(SETTLED_STATUSES).toContain("verification_failed");
    const { c, tree } = subProgram([]);
    expect(mayEndProgramNode(tree, c.executionNodeId).allowed).toBe(true);
  });

  it("is refused for a node that is not a running sub-program", () => {
    const ended = subProgram([], "cancelled");
    expect(mayEndProgramNode(ended.tree, ended.c.executionNodeId)).toMatchObject({
      allowed: false,
      reason: "not_running",
    });
    const { kids, tree } = subProgram(["running"]);
    expect(mayEndProgramNode(tree, kids[0]?.executionNodeId as never)).toMatchObject({
      allowed: false,
      reason: "is_a_job",
    });
  });
});
