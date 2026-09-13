/**
 * Delegation limits: recursion depth and concurrency (SC-P1-16).
 *
 * Returns a typed reason rather than a boolean, because an orchestrator that is
 * refused needs to know whether to wait (concurrency) or restructure its plan
 * (depth). Two different answers, two different behaviours.
 */
import type {
  DelegationLimits,
  ExecutionNodeId,
  ExecutionNodeKind,
  Scope,
  ScopeRequest,
} from "@nightshift/contracts";
import {
  ConcurrencyLimitExceededError,
  DelegationRefusedError,
  DepthLimitExceededError,
  ScopeWideningError,
} from "../errors.js";
import { childrenOf, depthOfChildOf, type ExecutionTree, getNode } from "./execution-tree.js";
import { explainWidening, narrow } from "./scope.js";
import { OCCUPIES_CONCURRENCY_SLOT } from "./transitions.js";

export type DelegationRejection =
  | { readonly kind: "depth_limit_exceeded"; readonly depth: number; readonly maxDepth: number }
  | {
      readonly kind: "concurrency_limit_exceeded";
      readonly running: number;
      readonly maxConcurrency: number;
    }
  | { readonly kind: "scope_widening"; readonly reasons: readonly string[] }
  | { readonly kind: "parent_is_terminal"; readonly parentStatus: string }
  | { readonly kind: "parent_cannot_delegate"; readonly parentKind: ExecutionNodeKind };

export type DelegationCheck =
  | { readonly allowed: true; readonly depth: number; readonly scope: Scope }
  | { readonly allowed: false; readonly reason: DelegationRejection };

/**
 * Only a program or sub-program may delegate. A leaf job has no delegation
 * authority of its own; work it wants to hand off goes back to its parent.
 */
export const CAN_DELEGATE: readonly ExecutionNodeKind[] = ["program", "sub-program"];

/**
 * How many of `parentId`'s children currently hold a concurrency slot.
 *
 * Scoped to siblings under one parent, which is what the domain rule governs. A
 * run-wide cap is scheduler policy and belongs to the execution layer, not here.
 */
export const runningChildCount = (tree: ExecutionTree, parentId: ExecutionNodeId): number =>
  childrenOf(tree, parentId).filter((child) => OCCUPIES_CONCURRENCY_SLOT.includes(child.status))
    .length;

/**
 * Whether a new child may be attached under `parentId`.
 *
 * `maxDepth` counts levels below the root: the root is depth 0, so `maxDepth: 3`
 * permits children at depths 1, 2 and 3 and refuses depth 4.
 *
 * Checks are ordered depth, then concurrency, then scope, so the answer is
 * stable for a given input rather than depending on which failure is noticed
 * first.
 */
export const checkDelegation = (
  tree: ExecutionTree,
  parentId: ExecutionNodeId,
  limits: DelegationLimits,
  request?: ScopeRequest,
): DelegationCheck => {
  const parent = getNode(tree, parentId);

  if (!CAN_DELEGATE.includes(parent.kind)) {
    return { allowed: false, reason: { kind: "parent_cannot_delegate", parentKind: parent.kind } };
  }

  if (parent.status === "integrated" || parent.status === "cancelled") {
    return { allowed: false, reason: { kind: "parent_is_terminal", parentStatus: parent.status } };
  }

  const depth = depthOfChildOf(tree, parentId);
  if (depth > limits.maxDepth) {
    return {
      allowed: false,
      reason: { kind: "depth_limit_exceeded", depth, maxDepth: limits.maxDepth },
    };
  }

  const running = runningChildCount(tree, parentId);
  if (running >= limits.maxConcurrency) {
    return {
      allowed: false,
      reason: {
        kind: "concurrency_limit_exceeded",
        running,
        maxConcurrency: limits.maxConcurrency,
      },
    };
  }

  if (request === undefined) {
    return { allowed: true, depth, scope: parent.scope };
  }

  const reasons = explainWidening(parent.scope, request);
  if (reasons.length > 0) {
    return { allowed: false, reason: { kind: "scope_widening", reasons } };
  }

  return { allowed: true, depth, scope: narrow(parent.scope, request) };
};

/**
 * Throwing counterpart to {@link checkDelegation}, for call sites that treat a
 * refused delegation as exceptional rather than as a value to branch on.
 */
export const assertDelegationAllowed = (
  tree: ExecutionTree,
  parentId: ExecutionNodeId,
  limits: DelegationLimits,
  request?: ScopeRequest,
): { readonly depth: number; readonly scope: Scope } => {
  const result = checkDelegation(tree, parentId, limits, request);
  if (result.allowed) return { depth: result.depth, scope: result.scope };

  const { reason } = result;
  switch (reason.kind) {
    case "depth_limit_exceeded":
      throw new DepthLimitExceededError(reason.depth, reason.maxDepth);
    case "concurrency_limit_exceeded":
      throw new ConcurrencyLimitExceededError(reason.running, reason.maxConcurrency);
    case "scope_widening":
      throw new ScopeWideningError(reason.reasons);
    case "parent_is_terminal":
      throw new DelegationRefusedError(
        `parent ${parentId} is ${reason.parentStatus} and can take no further children`,
      );
    case "parent_cannot_delegate":
      throw new DelegationRefusedError(
        `parent ${parentId} is a ${reason.parentKind} and holds no delegation authority`,
      );
  }
};
