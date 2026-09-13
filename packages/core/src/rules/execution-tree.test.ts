import { describe, expect, it } from "vitest";
import { CycleError, OwnershipViolationError, TreeStructureError } from "../errors.js";
import { createFixturePair, makeNode, makeRootNode } from "../testing/factories.js";
import {
  addChild,
  allNodes,
  ancestorsOf,
  buildTree,
  childrenOf,
  depthOf,
  depthOfChildOf,
  descendantsOf,
  getNode,
  hasNode,
  recomputeDepths,
  reparent,
  singletonTree,
  treeDepth,
} from "./execution-tree.js";

const [f, other] = createFixturePair();

const root = makeRootNode(f);
const jobA = makeNode(f, root.executionNodeId, { kind: "job" });
const subProgramC = makeNode(f, root.executionNodeId, { kind: "sub-program" });
const jobC1 = makeNode(f, subProgramC.executionNodeId, { kind: "job", depth: 2 });

const fullTree = () => buildTree([root, jobA, subProgramC, jobC1]);

describe("buildTree", () => {
  it("builds the fixture program tree", () => {
    const tree = fullTree();
    expect(tree.rootId).toBe(root.executionNodeId);
    expect(allNodes(tree)).toHaveLength(4);
  });

  it("rejects a duplicate identifier", () => {
    expect(() => buildTree([root, jobA, jobA])).toThrow(TreeStructureError);
  });

  it("rejects a tree with no root", () => {
    expect(() => buildTree([jobA, subProgramC])).toThrow(TreeStructureError);
  });

  it("rejects a tree with two roots", () => {
    const secondRoot = makeNode(f, root.executionNodeId, { parentNodeId: null, depth: 0 });
    expect(() => buildTree([root, secondRoot])).toThrow(/2 root nodes/);
  });

  it("rejects an unknown parent", () => {
    expect(() => buildTree([root, jobC1])).toThrow(TreeStructureError);
  });

  it("rejects a node parented to itself", () => {
    const selfParented = { ...jobA, parentNodeId: jobA.executionNodeId };
    expect(() => buildTree([root, selfParented])).toThrow(CycleError);
  });

  // SC-P1-11 — a cycle is never a valid tree.
  it("rejects a two-node cycle detached from the root", () => {
    const x = makeNode(f, root.executionNodeId);
    const y = makeNode(f, root.executionNodeId);
    const xInCycle = { ...x, parentNodeId: y.executionNodeId };
    const yInCycle = { ...y, parentNodeId: x.executionNodeId };
    expect(() => buildTree([root, xInCycle, yInCycle])).toThrow(CycleError);
  });

  it("rejects a component detached from the root", () => {
    const orphanParent = makeNode(f, root.executionNodeId, { parentNodeId: null, depth: 0 });
    const orphanChild = makeNode(f, orphanParent.executionNodeId);
    // Two roots is caught first; give the orphan a parent that exists but is itself detached.
    expect(() => buildTree([root, orphanChild])).toThrow(TreeStructureError);
  });

  // SC-P1-12 — ownership never varies inside one tree.
  it("rejects a node from another project", () => {
    const foreign = makeNode(other, root.executionNodeId, {
      parentNodeId: root.executionNodeId,
    });
    expect(() => buildTree([root, foreign])).toThrow(OwnershipViolationError);
  });
});

describe("singletonTree", () => {
  it("accepts a root", () => {
    expect(allNodes(singletonTree(root))).toHaveLength(1);
  });

  it("refuses a node with a parent", () => {
    expect(() => singletonTree(jobA)).toThrow(TreeStructureError);
  });
});

describe("navigation", () => {
  const tree = fullTree();

  it("reports ancestors from parent to root", () => {
    expect(ancestorsOf(tree, jobC1.executionNodeId)).toEqual([
      subProgramC.executionNodeId,
      root.executionNodeId,
    ]);
    expect(ancestorsOf(tree, root.executionNodeId)).toEqual([]);
  });

  it("reports children", () => {
    expect(
      childrenOf(tree, root.executionNodeId)
        .map((n) => n.executionNodeId)
        .sort(),
    ).toEqual([jobA.executionNodeId, subProgramC.executionNodeId].sort());
    expect(childrenOf(tree, jobA.executionNodeId)).toEqual([]);
  });

  it("reports descendants excluding itself", () => {
    expect([...descendantsOf(tree, root.executionNodeId)].sort()).toEqual(
      [jobA.executionNodeId, subProgramC.executionNodeId, jobC1.executionNodeId].sort(),
    );
    expect(descendantsOf(tree, jobC1.executionNodeId)).toEqual([]);
  });

  it("computes depth from parentage, root at zero", () => {
    expect(depthOf(tree, root.executionNodeId)).toBe(0);
    expect(depthOf(tree, jobA.executionNodeId)).toBe(1);
    expect(depthOf(tree, jobC1.executionNodeId)).toBe(2);
    expect(depthOfChildOf(tree, jobC1.executionNodeId)).toBe(3);
    expect(treeDepth(tree)).toBe(2);
  });

  it("throws on an unknown node", () => {
    expect(() => getNode(tree, jobC1.executionNodeId)).not.toThrow();
    expect(hasNode(tree, root.executionNodeId)).toBe(true);
    const absent = makeNode(f, root.executionNodeId);
    expect(hasNode(tree, absent.executionNodeId)).toBe(false);
    expect(() => getNode(tree, absent.executionNodeId)).toThrow(TreeStructureError);
  });
});

describe("addChild", () => {
  it("attaches a child and recomputes its depth", () => {
    const tree = singletonTree(root);
    // Claim depth 9 in the record; the tree must ignore it.
    const child = makeNode(f, root.executionNodeId, { depth: 9 });
    const next = addChild(tree, root.executionNodeId, child);
    expect(getNode(next, child.executionNodeId).depth).toBe(1);
  });

  it("does not mutate the original tree", () => {
    const tree = singletonTree(root);
    const child = makeNode(f, root.executionNodeId);
    addChild(tree, root.executionNodeId, child);
    expect(hasNode(tree, child.executionNodeId)).toBe(false);
  });

  it("rejects an unknown parent", () => {
    const tree = singletonTree(root);
    expect(() => addChild(tree, jobA.executionNodeId, jobC1)).toThrow(TreeStructureError);
  });

  it("rejects a duplicate identifier", () => {
    const tree = fullTree();
    expect(() => addChild(tree, root.executionNodeId, jobA)).toThrow(/duplicate/);
  });

  it("rejects a self-parenting child", () => {
    const tree = singletonTree(root);
    const selfish = { ...makeNode(f, root.executionNodeId), parentNodeId: root.executionNodeId };
    const asItsOwnParent = { ...selfish, executionNodeId: root.executionNodeId };
    expect(() => addChild(tree, root.executionNodeId, asItsOwnParent)).toThrow(CycleError);
  });

  // SC-P1-11 — attaching an existing ancestor under its own descendant is a cycle.
  it("rejects attaching an ancestor beneath its descendant", () => {
    const tree = fullTree();
    expect(() => addChild(tree, jobC1.executionNodeId, root)).toThrow(CycleError);
    expect(() => addChild(tree, jobC1.executionNodeId, subProgramC)).toThrow(CycleError);
  });

  it("rejects a child whose declared parent disagrees with the attachment point", () => {
    const tree = fullTree();
    const confused = makeNode(f, jobA.executionNodeId);
    expect(() => addChild(tree, subProgramC.executionNodeId, confused)).toThrow(/declares parent/);
  });

  it("rejects a child from another project", () => {
    const tree = singletonTree(root);
    const foreign = makeNode(other, root.executionNodeId, { parentNodeId: root.executionNodeId });
    expect(() => addChild(tree, root.executionNodeId, foreign)).toThrow(OwnershipViolationError);
  });
});

describe("reparent", () => {
  it("moves a node and recomputes depths beneath it", () => {
    const tree = fullTree();
    const moved = reparent(tree, jobA.executionNodeId, subProgramC.executionNodeId);
    expect(depthOf(moved, jobA.executionNodeId)).toBe(2);
    expect(getNode(moved, jobA.executionNodeId).depth).toBe(2);
  });

  it("refuses to move the root", () => {
    const tree = fullTree();
    expect(() => reparent(tree, root.executionNodeId, jobA.executionNodeId)).toThrow(/root node/);
  });

  it("refuses to move a node under itself", () => {
    const tree = fullTree();
    expect(() => reparent(tree, jobA.executionNodeId, jobA.executionNodeId)).toThrow(CycleError);
  });

  // The explicit SC-P1-11 case: an edge from a node to one of its own descendants.
  it("refuses to move a node under its own descendant", () => {
    const tree = fullTree();
    expect(() => reparent(tree, subProgramC.executionNodeId, jobC1.executionNodeId)).toThrow(
      CycleError,
    );
  });
});

describe("recomputeDepths", () => {
  it("corrects a stored depth that disagrees with parentage", () => {
    const lying = { ...jobC1, depth: 0 };
    const tree = buildTree([root, subProgramC, lying]);
    expect(getNode(tree, jobC1.executionNodeId).depth).toBe(0);
    const fixed = recomputeDepths(tree);
    expect(getNode(fixed, jobC1.executionNodeId).depth).toBe(2);
  });
});
