import type { DelegationLimits } from "@nightshift/contracts";
import { describe, expect, it } from "vitest";
import {
  ConcurrencyLimitExceededError,
  DelegationRefusedError,
  DepthLimitExceededError,
} from "../errors.js";
import { createFixtures, makeNode, makeRootNode } from "../testing/factories.js";
import {
  assertDelegationAllowed,
  CAN_DELEGATE,
  checkDelegation,
  runningChildCount,
} from "./delegation.js";
import { addChild, buildTree, singletonTree } from "./execution-tree.js";

const limits: DelegationLimits = { maxDepth: 2, maxConcurrency: 2 };
const generous: DelegationLimits = { maxDepth: 99, maxConcurrency: 99 };

const f = createFixtures();
const root = makeRootNode(f, { kind: "program", status: "running" });

/** A chain of sub-programs `depth` levels below the root. */
const chainTo = (depth: number) => {
  let tree = singletonTree(root);
  let parentId = root.executionNodeId;
  for (let level = 1; level <= depth; level += 1) {
    const node = makeNode(f, parentId, { kind: "sub-program", status: "running" });
    tree = addChild(tree, parentId, node);
    parentId = node.executionNodeId;
  }
  return { tree, deepestId: parentId };
};

describe("checkDelegation depth", () => {
  // SC-P1-16 — rejection depends on the child's computed depth against maxDepth.
  it("allows a child at the limit", () => {
    const { tree, deepestId } = chainTo(1);
    const result = checkDelegation(tree, deepestId, limits);
    expect(result.allowed).toBe(true);
    if (result.allowed) expect(result.depth).toBe(2);
  });

  it("rejects a child one level past the limit", () => {
    const { tree, deepestId } = chainTo(2);
    const result = checkDelegation(tree, deepestId, limits);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason.kind).toBe("depth_limit_exceeded");
      if (result.reason.kind === "depth_limit_exceeded") {
        expect(result.reason.depth).toBe(3);
        expect(result.reason.maxDepth).toBe(2);
      }
    }
  });

  it("counts the root as depth zero, so maxDepth is a count of delegation levels", () => {
    const tree = singletonTree(root);
    const result = checkDelegation(tree, root.executionNodeId, { ...generous, maxDepth: 1 });
    expect(result.allowed).toBe(true);
    if (result.allowed) expect(result.depth).toBe(1);
  });

  it("refuses any delegation when maxDepth is one and the parent is already at depth one", () => {
    const { tree, deepestId } = chainTo(1);
    const result = checkDelegation(tree, deepestId, { ...generous, maxDepth: 1 });
    expect(result.allowed).toBe(false);
  });
});

describe("checkDelegation concurrency", () => {
  const withRunningChildren = (count: number) => {
    let tree = singletonTree(root);
    for (let i = 0; i < count; i += 1) {
      const child = makeNode(f, root.executionNodeId, { status: "running" });
      tree = addChild(tree, root.executionNodeId, child);
    }
    return tree;
  };

  it("allows a child below the limit", () => {
    const tree = withRunningChildren(1);
    expect(checkDelegation(tree, root.executionNodeId, limits).allowed).toBe(true);
  });

  it("queues excess work once the limit is reached", () => {
    const tree = withRunningChildren(2);
    const result = checkDelegation(tree, root.executionNodeId, limits);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason.kind).toBe("concurrency_limit_exceeded");
      if (result.reason.kind === "concurrency_limit_exceeded") {
        expect(result.reason.running).toBe(2);
        expect(result.reason.maxConcurrency).toBe(2);
      }
    }
  });

  it("does not count queued siblings against the limit", () => {
    let tree = singletonTree(root);
    for (let i = 0; i < 5; i += 1) {
      tree = addChild(
        tree,
        root.executionNodeId,
        makeNode(f, root.executionNodeId, { status: "queued" }),
      );
    }
    expect(runningChildCount(tree, root.executionNodeId)).toBe(0);
    expect(checkDelegation(tree, root.executionNodeId, limits).allowed).toBe(true);
  });

  it("counts verifying and examining siblings as occupying a slot", () => {
    let tree = singletonTree(root);
    tree = addChild(
      tree,
      root.executionNodeId,
      makeNode(f, root.executionNodeId, { status: "verifying" }),
    );
    tree = addChild(
      tree,
      root.executionNodeId,
      makeNode(f, root.executionNodeId, { status: "examining" }),
    );
    expect(runningChildCount(tree, root.executionNodeId)).toBe(2);
    expect(checkDelegation(tree, root.executionNodeId, limits).allowed).toBe(false);
  });

  it("ignores integrated and failed siblings", () => {
    let tree = singletonTree(root);
    for (const status of ["integrated", "failed", "cancelled"] as const) {
      tree = addChild(tree, root.executionNodeId, makeNode(f, root.executionNodeId, { status }));
    }
    expect(runningChildCount(tree, root.executionNodeId)).toBe(0);
  });

  it("counts only siblings under the same parent", () => {
    const subProgram = makeNode(f, root.executionNodeId, {
      kind: "sub-program",
      status: "running",
    });
    let tree = addChild(singletonTree(root), root.executionNodeId, subProgram);
    tree = addChild(
      tree,
      subProgram.executionNodeId,
      makeNode(f, subProgram.executionNodeId, { status: "running" }),
    );
    expect(runningChildCount(tree, root.executionNodeId)).toBe(1);
    expect(runningChildCount(tree, subProgram.executionNodeId)).toBe(1);
  });
});

describe("checkDelegation authority", () => {
  // The owner's ruling, 2026-10-09: a delegation is decided by depth and limits
  // alone. There is no path scope to resolve, inherit or refuse.
  it("allows a child from a program with nothing but its depth", () => {
    const tree = singletonTree(root);
    const result = checkDelegation(tree, root.executionNodeId, generous);
    expect(result).toEqual({ allowed: true, depth: 1 });
  });

  it("refuses delegation from a leaf job", () => {
    const job = makeNode(f, root.executionNodeId, { kind: "job", status: "running" });
    const tree = addChild(singletonTree(root), root.executionNodeId, job);
    const result = checkDelegation(tree, job.executionNodeId, generous);
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason.kind).toBe("parent_cannot_delegate");
    expect(CAN_DELEGATE).toEqual(["program", "sub-program"]);
  });

  it("refuses delegation from a terminal parent", () => {
    const finished = makeRootNode(f, { status: "integrated" });
    const tree = buildTree([finished]);
    const result = checkDelegation(tree, finished.executionNodeId, generous);
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason.kind).toBe("parent_is_terminal");
  });

  it("checks depth before concurrency, so the answer is stable", () => {
    const { tree, deepestId } = chainTo(2);
    const result = checkDelegation(tree, deepestId, { maxDepth: 1, maxConcurrency: 0 });
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason.kind).toBe("depth_limit_exceeded");
  });
});

describe("assertDelegationAllowed", () => {
  it("returns the depth when allowed", () => {
    const tree = singletonTree(root);
    expect(assertDelegationAllowed(tree, root.executionNodeId, generous).depth).toBe(1);
  });

  it("throws a distinct error per refusal", () => {
    const depthCase = chainTo(2);
    expect(() =>
      assertDelegationAllowed(depthCase.tree, depthCase.deepestId, {
        maxDepth: 1,
        maxConcurrency: 9,
      }),
    ).toThrow(DepthLimitExceededError);

    const busy = addChild(
      singletonTree(root),
      root.executionNodeId,
      makeNode(f, root.executionNodeId, { status: "running" }),
    );
    expect(() =>
      assertDelegationAllowed(busy, root.executionNodeId, { maxDepth: 9, maxConcurrency: 1 }),
    ).toThrow(ConcurrencyLimitExceededError);

    const job = makeNode(f, root.executionNodeId, { kind: "job", status: "running" });
    const withJob = addChild(singletonTree(root), root.executionNodeId, job);
    expect(() => assertDelegationAllowed(withJob, job.executionNodeId, generous)).toThrow(
      DelegationRefusedError,
    );
  });
});
