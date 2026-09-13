/**
 * SC-P1-16 — depth limits are enforced.
 *
 * Stated as a biconditional against depth alone, so concurrency is held wide
 * open in these properties. A separate property covers concurrency on its own.
 */
import { buildTree, checkDelegation, depthOfChildOf, runningChildCount } from "@nightshift/core";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { executionChain, executionTree } from "../arbitraries.js";

describe("SC-P1-16: depth limits are enforced", () => {
  it("rejects a delegation exactly when the child's depth would exceed maxDepth", () => {
    fc.assert(
      fc.property(
        executionChain(6),
        fc.integer({ min: 1, max: 6 }),
        ({ nodes, deepestId }, maxDepth) => {
          const tree = buildTree(nodes);
          const childDepth = depthOfChildOf(tree, deepestId);
          // Concurrency held open so this property is about depth alone.
          const result = checkDelegation(tree, deepestId, { maxDepth, maxConcurrency: 1000 });

          expect(result.allowed).toBe(childDepth <= maxDepth);
          if (!result.allowed) {
            expect(result.reason.kind).toBe("depth_limit_exceeded");
            if (result.reason.kind === "depth_limit_exceeded") {
              expect(result.reason.depth).toBe(childDepth);
              expect(result.reason.maxDepth).toBe(maxDepth);
            }
          } else {
            expect(result.depth).toBe(childDepth);
          }
        },
      ),
    );
  });

  it("holds at every node of an arbitrary tree, not just the deepest", () => {
    fc.assert(
      fc.property(
        executionTree({ maxNodes: 10 }),
        fc.integer({ min: 1, max: 6 }),
        ({ nodes }, maxDepth) => {
          const tree = buildTree(nodes);
          for (const node of nodes) {
            const childDepth = depthOfChildOf(tree, node.executionNodeId);
            const result = checkDelegation(tree, node.executionNodeId, {
              maxDepth,
              maxConcurrency: 1000,
            });
            expect(result.allowed).toBe(childDepth <= maxDepth);
          }
        },
      ),
    );
  });

  it("always permits a first delegation from the root when maxDepth is at least one", () => {
    fc.assert(
      fc.property(
        executionTree(),
        fc.integer({ min: 1, max: 6 }),
        ({ nodes, rootId }, maxDepth) => {
          const tree = buildTree(nodes);
          expect(depthOfChildOf(tree, rootId)).toBe(1);
          expect(checkDelegation(tree, rootId, { maxDepth, maxConcurrency: 1000 }).allowed).toBe(
            true,
          );
        },
      ),
    );
  });
});

describe("concurrency limits queue excess work", () => {
  it("rejects exactly when running siblings have filled the limit", () => {
    fc.assert(
      fc.property(
        executionTree({ maxNodes: 10 }),
        fc.integer({ min: 1, max: 8 }),
        ({ nodes, rootId }, maxConcurrency) => {
          const tree = buildTree(nodes);
          const running = runningChildCount(tree, rootId);
          // Depth held open so this property is about concurrency alone.
          const result = checkDelegation(tree, rootId, { maxDepth: 1000, maxConcurrency });

          expect(result.allowed).toBe(running < maxConcurrency);
          if (!result.allowed) {
            expect(result.reason.kind).toBe("concurrency_limit_exceeded");
          }
        },
      ),
    );
  });

  it("counts only the children of the parent in question", () => {
    fc.assert(
      fc.property(executionTree({ maxNodes: 12 }), ({ nodes }) => {
        const tree = buildTree(nodes);
        const total = nodes.reduce(
          (sum, node) => sum + runningChildCount(tree, node.executionNodeId),
          0,
        );
        // Every non-root node is running, and each is counted exactly once, by its parent.
        expect(total).toBe(nodes.length - 1);
      }),
    );
  });
});
