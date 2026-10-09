/**
 * fast-check arbitraries for the domain (T7).
 *
 * These live in `@nightshift/test` rather than in `@nightshift/core`, which is
 * where the task spec suggested them. The reason is the layering rule: `core`'s
 * runtime surface may depend on nothing but zod and ulid (architecture §1), and
 * `arbitraries.ts` is a built module rather than a test file, so importing
 * fast-check from inside `core` would put a test library in `core`'s published
 * dependencies. The dependency-free fixture builders stay in
 * `@nightshift/core`'s `testing` module; only the generators moved.
 *
 * The tree generators matter most: every non-root node can delegate, so a
 * property about depth or limits is not confounded by a node that cannot.
 */
import type {
  DelegationLimits,
  ExecutionNode,
  ExecutionNodeId,
  ExecutionNodeStatus,
} from "@nightshift/contracts";
import {
  createCountingIdGenerator,
  createFixtures,
  EXECUTION_NODE_STATUSES,
  type Fixtures,
  type IdGenerator,
  makeNode,
  makeRootNode,
  TRANSITION_EVENTS,
  type TransitionEvent,
} from "@nightshift/core";
import fc from "fast-check";

const SEGMENTS = ["src", "lib", "app", "billing", "models", "api", "utils", "web"] as const;

export const segment = (): fc.Arbitrary<string> => fc.constantFrom(...SEGMENTS);

/** A literal, repository-relative path with no wildcards. */
export const literalPath = (): fc.Arbitrary<string> =>
  fc.array(segment(), { minLength: 1, maxLength: 4 }).map((parts) => parts.join("/"));

export const executionNodeStatus = (): fc.Arbitrary<ExecutionNodeStatus> =>
  fc.constantFrom(...EXECUTION_NODE_STATUSES);

export const transitionEvent = (): fc.Arbitrary<TransitionEvent> =>
  fc.constantFrom(...TRANSITION_EVENTS);

export const delegationLimits = (): fc.Arbitrary<DelegationLimits> =>
  fc.record({
    maxDepth: fc.integer({ min: 1, max: 6 }),
    maxConcurrency: fc.integer({ min: 1, max: 6 }),
  });

/** A generated tree, returned as its node list plus useful landmarks. */
export interface GeneratedTree {
  readonly nodes: readonly ExecutionNode[];
  readonly rootId: ExecutionNodeId;
  readonly fixtures: Fixtures;
}

/**
 * A well-formed tree of bounded size.
 *
 * Every non-root node is a `sub-program`, so any node is a legal delegation
 * parent and a depth property is not confounded by a `parent_cannot_delegate`
 * refusal.
 */
export const executionTree = (
  options: { readonly maxNodes?: number } = {},
): fc.Arbitrary<GeneratedTree> => {
  const maxNodes = options.maxNodes ?? 8;
  return fc.array(fc.nat({ max: 1000 }), { minLength: 0, maxLength: maxNodes - 1 }).map((picks) => {
    const ids: IdGenerator = createCountingIdGenerator();
    const fixtures = createFixtures(ids);
    const root = makeRootNode(fixtures, { kind: "program", status: "running" });
    const nodes: ExecutionNode[] = [root];

    for (const pick of picks) {
      // Attach under an existing node, chosen deterministically from the pick.
      const parent = nodes[pick % nodes.length];
      if (parent === undefined) continue;
      nodes.push(
        makeNode(fixtures, parent.executionNodeId, { kind: "sub-program", status: "running" }),
      );
    }

    return { nodes, rootId: root.executionNodeId, fixtures };
  });
};

export interface GeneratedChain extends GeneratedTree {
  readonly deepestId: ExecutionNodeId;
  readonly depth: number;
}

/** A chain of `depth` sub-programs below the root, for depth-limit properties. */
export const executionChain = (maxDepth = 6): fc.Arbitrary<GeneratedChain> =>
  fc.integer({ min: 0, max: maxDepth }).map((depth) => {
    const fixtures = createFixtures(createCountingIdGenerator());
    const root = makeRootNode(fixtures, { kind: "program", status: "running" });
    const nodes: ExecutionNode[] = [root];
    let deepestId = root.executionNodeId;

    for (let level = 1; level <= depth; level += 1) {
      const node = makeNode(fixtures, deepestId, { kind: "sub-program", status: "running" });
      nodes.push(node);
      deepestId = node.executionNodeId;
    }

    return { nodes, rootId: root.executionNodeId, fixtures, deepestId, depth };
  });

/** A sequence of transition events, for reachability properties. */
export const transitionSequence = (maxLength = 20): fc.Arbitrary<readonly TransitionEvent[]> =>
  fc.array(transitionEvent(), { minLength: 0, maxLength });
