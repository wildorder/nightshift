/**
 * Delegation limits: recursion depth and concurrency (SC-P1-16).
 *
 * Returns a typed reason rather than a boolean, because an orchestrator that is
 * refused needs to know whether to wait (concurrency) or restructure its plan
 * (depth). Two different answers, two different behaviours.
 */
import type { DelegationLimits, ExecutionNodeId, ExecutionNodeKind } from "@nightshift/contracts";
import {
  ConcurrencyLimitExceededError,
  DelegationRefusedError,
  DepthLimitExceededError,
} from "../errors.js";
import { childrenOf, depthOfChildOf, type ExecutionTree, getNode } from "./execution-tree.js";
import { isTerminal, OCCUPIES_CONCURRENCY_SLOT } from "./transitions.js";

export type DelegationRejection =
  | { readonly kind: "depth_limit_exceeded"; readonly depth: number; readonly maxDepth: number }
  | {
      readonly kind: "concurrency_limit_exceeded";
      readonly running: number;
      readonly maxConcurrency: number;
    }
  | { readonly kind: "parent_is_terminal"; readonly parentStatus: string }
  | { readonly kind: "parent_cannot_delegate"; readonly parentKind: ExecutionNodeKind };

export type DelegationCheck =
  | { readonly allowed: true; readonly depth: number }
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
 * Checks are ordered depth, then concurrency, so the answer is stable for a
 * given input rather than depending on which failure is noticed first. No path
 * scope is asked about: a job carries none (the owner's ruling, 2026-10-09).
 */
export const checkDelegation = (
  tree: ExecutionTree,
  parentId: ExecutionNodeId,
  limits: DelegationLimits,
): DelegationCheck => {
  const parent = getNode(tree, parentId);

  if (!CAN_DELEGATE.includes(parent.kind)) {
    return { allowed: false, reason: { kind: "parent_cannot_delegate", parentKind: parent.kind } };
  }

  // Every terminal status, from the table's own list: P5 added `succeeded` after
  // this rule was written, and a finished program takes no further children.
  if (isTerminal(parent.status)) {
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

  return { allowed: true, depth };
};

/**
 * Throwing counterpart to {@link checkDelegation}, for call sites that treat a
 * refused delegation as exceptional rather than as a value to branch on.
 */
export const assertDelegationAllowed = (
  tree: ExecutionTree,
  parentId: ExecutionNodeId,
  limits: DelegationLimits,
): { readonly depth: number } => {
  const result = checkDelegation(tree, parentId, limits);
  if (result.allowed) return { depth: result.depth };

  const { reason } = result;
  switch (reason.kind) {
    case "depth_limit_exceeded":
      throw new DepthLimitExceededError(reason.depth, reason.maxDepth);
    case "concurrency_limit_exceeded":
      throw new ConcurrencyLimitExceededError(reason.running, reason.maxConcurrency);

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

/** A concurrency limit wide enough never to be the reason. See {@link checkAuthority}. */
const OPEN_CONCURRENCY = Number.MAX_SAFE_INTEGER;

/**
 * Whether a child may **exist** under `parentId`: delegation authority and
 * depth, with concurrency left out (P6, D-P6-02).
 *
 * P6 applies the concurrency limit when a node *starts*, not when it is
 * delegated, so that excess work queues instead of being refused. This is
 * `checkDelegation` asked with the limit held open, not a second rule: the P1
 * rule and its properties are exactly what they were.
 */
export const checkAuthority = (
  tree: ExecutionTree,
  parentId: ExecutionNodeId,
  limits: DelegationLimits,
): DelegationCheck =>
  checkDelegation(tree, parentId, { ...limits, maxConcurrency: OPEN_CONCURRENCY });

/** {@link checkAuthority}, throwing the typed domain error on refusal. */
export const assertAuthority = (
  tree: ExecutionTree,
  parentId: ExecutionNodeId,
  limits: DelegationLimits,
): { readonly depth: number } =>
  assertDelegationAllowed(tree, parentId, { ...limits, maxConcurrency: OPEN_CONCURRENCY });

export type SlotCheck =
  | { readonly free: true }
  | { readonly free: false; readonly running: number; readonly maxConcurrency: number };

/**
 * Whether `nodeId` may take a concurrency slot **now** (P6, D-P6-02).
 *
 * Counted per parent, by P1's own `runningChildCount`: a node may start when
 * fewer than `maxConcurrency` of its siblings hold a slot. "No" here means "not
 * yet", and the node stays `queued`. The root has no parent and no limit.
 *
 * Per parent cannot deadlock: a running sub-program holds one of its *parent's*
 * slots, never one of its own children's.
 */
export const maySlotStart = (
  tree: ExecutionTree,
  nodeId: ExecutionNodeId,
  limits: DelegationLimits,
): SlotCheck => {
  const node = getNode(tree, nodeId);
  if (node.parentNodeId === null) return { free: true };
  const running = runningChildCount(tree, node.parentNodeId);
  return running < limits.maxConcurrency
    ? { free: true }
    : { free: false, running, maxConcurrency: limits.maxConcurrency };
};
