/**
 * SC-P1-11 — execution trees cannot cycle.
 * SC-P1-12 — jobs cannot move between projects.
 */
import {
  addChild,
  allNodes,
  ancestorsOf,
  assertOwnershipChain,
  assertSameProgram,
  assertSameProject,
  assertSameRun,
  buildTree,
  CycleError,
  createCountingIdGenerator,
  createFixtures,
  depthOf,
  descendantsOf,
  getNode,
  makeNode,
  OwnershipViolationError,
  reparent,
  sameRun,
} from "@nightshift/core";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { executionTree } from "../arbitraries.js";

describe("SC-P1-11: execution trees cannot cycle", () => {
  it("builds every generated tree and agrees on depth", () => {
    fc.assert(
      fc.property(executionTree(), ({ nodes, rootId }) => {
        const tree = buildTree(nodes);
        expect(tree.rootId).toBe(rootId);
        expect(allNodes(tree)).toHaveLength(nodes.length);

        // Depth equals the ancestor count, for every node, always.
        for (const node of allNodes(tree)) {
          expect(depthOf(tree, node.executionNodeId)).toBe(
            ancestorsOf(tree, node.executionNodeId).length,
          );
        }
        expect(depthOf(tree, rootId)).toBe(0);
      }),
    );
  });

  it("addChild either throws or leaves the tree acyclic", () => {
    fc.assert(
      fc.property(
        executionTree(),
        fc.nat({ max: 1000 }),
        fc.nat({ max: 1000 }),
        ({ nodes, fixtures }, parentPick, nodePick) => {
          const tree = buildTree(nodes);
          const existing = allNodes(tree);
          const parent = existing[parentPick % existing.length];
          if (parent === undefined) return;

          // Half the time attach a fresh node, half the time re-attach an existing
          // one — which is where a cycle would come from.
          const useExisting = nodePick % 2 === 0;
          const candidateSource = existing[nodePick % existing.length];
          if (candidateSource === undefined) return;

          const candidate = useExisting
            ? { ...candidateSource, parentNodeId: parent.executionNodeId }
            : makeNode(fixtures, parent.executionNodeId, { kind: "sub-program" });

          let next: ReturnType<typeof addChild> | undefined;
          try {
            next = addChild(tree, parent.executionNodeId, candidate);
          } catch (error) {
            // Any refusal is acceptable; the invariant is that nothing cyclic survives.
            expect(error).toBeInstanceOf(Error);
            return;
          }

          // buildTree re-validates from scratch, including acyclicity, so a cycle
          // that slipped past addChild would surface here.
          expect(() => buildTree(allNodes(next))).not.toThrow();
        },
      ),
    );
  });

  it("refuses to attach any node that is already an ancestor of the target parent", () => {
    fc.assert(
      fc.property(executionTree({ maxNodes: 10 }), fc.nat({ max: 1000 }), ({ nodes }, pick) => {
        const tree = buildTree(nodes);
        const all = allNodes(tree);
        const target = all[pick % all.length];
        if (target === undefined) return;

        for (const ancestorId of ancestorsOf(tree, target.executionNodeId)) {
          const ancestor = getNode(tree, ancestorId);
          expect(() => addChild(tree, target.executionNodeId, ancestor)).toThrow(CycleError);
        }
      }),
    );
  });

  it("refuses to reparent a node beneath its own descendant", () => {
    fc.assert(
      fc.property(executionTree({ maxNodes: 10 }), fc.nat({ max: 1000 }), ({ nodes }, pick) => {
        const tree = buildTree(nodes);
        // The root has its own refusal (it may never be reparented at all), which
        // fires before the cycle check, so the cycle rule is asserted on the rest.
        const movable = allNodes(tree).filter((node) => node.executionNodeId !== tree.rootId);
        fc.pre(movable.length >= 1);
        const node = movable[pick % movable.length];
        if (node === undefined) return;

        for (const descendantId of descendantsOf(tree, node.executionNodeId)) {
          expect(() => reparent(tree, node.executionNodeId, descendantId)).toThrow(CycleError);
        }
        // Self-attachment is the degenerate case of the same rule.
        expect(() => reparent(tree, node.executionNodeId, node.executionNodeId)).toThrow(
          CycleError,
        );
      }),
    );
  });

  it("never reparents the root, whatever the target", () => {
    fc.assert(
      fc.property(executionTree(), ({ nodes }) => {
        const tree = buildTree(nodes);
        for (const node of allNodes(tree)) {
          expect(() => reparent(tree, tree.rootId, node.executionNodeId)).toThrow();
        }
      }),
    );
  });

  it("rejects a node list containing a cycle", () => {
    fc.assert(
      fc.property(executionTree({ maxNodes: 6 }), fc.nat({ max: 1000 }), ({ nodes }, pick) => {
        const nonRoot = nodes.filter((node) => node.parentNodeId !== null);
        fc.pre(nonRoot.length >= 1);
        const victim = nonRoot[pick % nonRoot.length];
        if (victim === undefined) return;

        // Point a node at one of its own descendants, or at itself.
        const tree = buildTree(nodes);
        const below = descendantsOf(tree, victim.executionNodeId);
        const newParentId = below[0] ?? victim.executionNodeId;
        const corrupted = nodes.map((node) =>
          node.executionNodeId === victim.executionNodeId
            ? { ...node, parentNodeId: newParentId }
            : node,
        );
        expect(() => buildTree(corrupted)).toThrow();
      }),
    );
  });
});

describe("SC-P1-12: jobs cannot move between projects", () => {
  it("refuses every ownership assertion across two different chains", () => {
    fc.assert(
      fc.property(fc.constant(null), () => {
        const ids = createCountingIdGenerator();
        const a = createFixtures(ids);
        const b = createFixtures(ids);

        expect(sameRun(a.scope, b.scope)).toBe(false);
        for (const assertion of [
          assertSameProject,
          assertSameProgram,
          assertSameRun,
          assertOwnershipChain,
        ]) {
          expect(() => assertion(a.scope, b.scope)).toThrow(OwnershipViolationError);
        }
      }),
      { numRuns: 1 },
    );
  });

  it("accepts every ownership assertion inside one chain", () => {
    fc.assert(
      fc.property(executionTree(), ({ nodes }) => {
        const tree = buildTree(nodes);
        const root = getNode(tree, tree.rootId);
        for (const node of allNodes(tree)) {
          expect(() => assertOwnershipChain(root, node)).not.toThrow();
          expect(sameRun(root, node)).toBe(true);
        }
      }),
    );
  });

  it("refuses a foreign node in any tree operation", () => {
    fc.assert(
      fc.property(executionTree(), ({ nodes, rootId, fixtures }) => {
        const tree = buildTree(nodes);
        // A node aimed at this tree's root but owned by a different project.
        // The projectId is overridden explicitly: a second counting generator
        // would restart at 1 and mint the *same* identifiers, which would make
        // this assertion vacuous.
        const foreign = makeNode(fixtures, rootId, {
          parentNodeId: rootId,
          projectId: `proj_${"Z".repeat(26)}`,
        });
        expect(foreign.projectId).not.toBe(tree.nodes.get(rootId)?.projectId);

        expect(() => addChild(tree, rootId, foreign)).toThrow(OwnershipViolationError);
        expect(() => buildTree([...nodes, foreign])).toThrow(OwnershipViolationError);
      }),
    );
  });
});
