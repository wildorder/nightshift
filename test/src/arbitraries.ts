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
 * Two generators matter more than the rest:
 *
 * - {@link narrowingRequest} produces children contained in their parent *by
 *   construction*, under the same conservative glob semantics `scope.ts` implements.
 * - {@link wideningRequest} produces children that violate exactly one of the
 *   four authority dimensions.
 *
 * Generating both directions explicitly is what makes SC-P1-10's "succeeds iff
 * contained" a real biconditional, rather than a one-sided check that an
 * always-throwing implementation would also satisfy.
 */
import type {
  DelegationLimits,
  ExecutionNode,
  ExecutionNodeId,
  ExecutionNodeStatus,
  Scope,
  ScopeRequest,
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
const PERMISSIONS = ["fs.read", "fs.write", "shell.exec", "net.fetch", "git.commit"] as const;
const FORBIDDEN = ["deploy to production", "rewrite history", "rotate credentials"] as const;

export const segment = (): fc.Arbitrary<string> => fc.constantFrom(...SEGMENTS);

/** A literal, repository-relative path with no wildcards. */
export const literalPath = (): fc.Arbitrary<string> =>
  fc.array(segment(), { minLength: 1, maxLength: 4 }).map((parts) => parts.join("/"));

export const executionNodeStatus = (): fc.Arbitrary<ExecutionNodeStatus> =>
  fc.constantFrom(...EXECUTION_NODE_STATUSES);

export const transitionEvent = (): fc.Arbitrary<TransitionEvent> =>
  fc.constantFrom(...TRANSITION_EVENTS);

/**
 * A parent scope. Every include is a trailing-`**` glob, which is the shape a
 * real Program Contract uses and the shape containment can reason about.
 */
export const parentScope = (): fc.Arbitrary<Scope> =>
  fc
    .record({
      roots: fc.uniqueArray(segment(), { minLength: 1, maxLength: 3 }),
      excludes: fc.uniqueArray(literalPath(), { minLength: 0, maxLength: 2 }),
      permissions: fc.uniqueArray(fc.constantFrom(...PERMISSIONS), {
        minLength: 1,
        maxLength: PERMISSIONS.length,
      }),
      forbiddenActions: fc.uniqueArray(fc.constantFrom(...FORBIDDEN), {
        minLength: 0,
        maxLength: FORBIDDEN.length,
      }),
    })
    .map(({ roots, excludes, permissions, forbiddenActions }) => ({
      includes: roots.map((root) => `${root}/**`),
      excludes: excludes.map((path) => `${path}/**`),
      permissions,
      forbiddenActions,
    }));

/**
 * A request that narrows `parent` and never widens it: includes sit under one of
 * the parent's include roots, permissions are a subset, and both the exclude set
 * and the forbidden-action set are supersets. Any of the three optional fields
 * may be omitted, which exercises the inherit-unchanged path.
 */
export const narrowingRequest = (parent: Scope): fc.Arbitrary<ScopeRequest> =>
  fc
    .record({
      include: fc.constantFrom(...parent.includes),
      suffix: fc.array(segment(), { minLength: 0, maxLength: 2 }),
      extraExcludes: fc.uniqueArray(literalPath(), { minLength: 0, maxLength: 2 }),
      keptPermissions: fc.uniqueArray(fc.constantFrom(...parent.permissions), {
        minLength: 0,
        maxLength: parent.permissions.length,
      }),
      extraForbidden: fc.uniqueArray(fc.constantFrom(...FORBIDDEN), {
        minLength: 0,
        maxLength: FORBIDDEN.length,
      }),
      omitExcludes: fc.boolean(),
      omitPermissions: fc.boolean(),
      omitForbidden: fc.boolean(),
    })
    .map((choice) => {
      // `src/**` narrows to `src/billing/**`; an empty suffix re-states the parent.
      const root = choice.include.replace(/\/\*\*$/, "");
      const narrowed =
        choice.suffix.length === 0 ? choice.include : `${root}/${choice.suffix.join("/")}/**`;

      const request: {
        includes: string[];
        excludes?: string[];
        permissions?: string[];
        forbiddenActions?: string[];
      } = { includes: [narrowed] };

      if (!choice.omitExcludes) {
        request.excludes = [
          ...new Set([...parent.excludes, ...choice.extraExcludes.map((p) => `${p}/**`)]),
        ];
      }
      if (!choice.omitPermissions) {
        request.permissions = choice.keptPermissions;
      }
      if (!choice.omitForbidden) {
        request.forbiddenActions = [
          ...new Set([...parent.forbiddenActions, ...choice.extraForbidden]),
        ];
      }
      return request as ScopeRequest;
    });

/** Which authority dimension a generated widening violates. */
export type WideningKind = "include" | "exclude" | "permission" | "forbidden";

export interface Widening {
  readonly kind: WideningKind;
  readonly request: ScopeRequest;
}

/**
 * A request that widens `parent` in exactly one dimension.
 *
 * Yields `undefined` when the parent cannot be widened in the chosen dimension —
 * a parent with no excludes has none for a child to drop — so callers filter
 * those out rather than asserting on a vacuous case.
 */
export const wideningRequest = (parent: Scope): fc.Arbitrary<Widening | undefined> =>
  fc
    .record({
      kind: fc.constantFrom<WideningKind>("include", "exclude", "permission", "forbidden"),
      foreignRoot: fc.constantFrom(...SEGMENTS),
    })
    .map(({ kind, foreignRoot }): Widening | undefined => {
      const request = WIDENINGS[kind](parent, foreignRoot);
      return request === undefined ? undefined : { kind, request };
    });

/** A permission from the pool that `parent` does not hold, if there is one. */
const unheldPermission = (parent: Scope): string | undefined =>
  PERMISSIONS.find((permission) => !parent.permissions.includes(permission));

/**
 * One builder per dimension. Each returns `undefined` when this parent offers no
 * way to widen that dimension: a parent with no excludes has none to drop, and a
 * parent holding every permission has none left to over-claim.
 */
const WIDENINGS: Readonly<
  Record<WideningKind, (parent: Scope, foreignRoot: string) => ScopeRequest | undefined>
> = {
  include: (parent, foreignRoot) => {
    const parentRoots = new Set(parent.includes.map((glob) => glob.split("/")[0]));
    if (parentRoots.has(foreignRoot)) return undefined;
    return { includes: [`${foreignRoot}/**`] };
  },
  exclude: (parent) =>
    parent.excludes.length === 0
      ? undefined
      : { includes: [...parent.includes], excludes: parent.excludes.slice(1) },
  permission: (parent) => {
    const claimed = unheldPermission(parent);
    if (claimed === undefined) return undefined;
    return { includes: [...parent.includes], permissions: [...parent.permissions, claimed] };
  },
  forbidden: (parent) =>
    parent.forbiddenActions.length === 0
      ? undefined
      : { includes: [...parent.includes], forbiddenActions: parent.forbiddenActions.slice(1) },
};

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
