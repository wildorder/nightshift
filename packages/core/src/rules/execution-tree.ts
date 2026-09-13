/**
 * Execution-tree parentage (SC-P1-11).
 *
 * The tree is an immutable value: every mutation returns a new tree, and every
 * construction path validates the whole structure. `depth` is always recomputed
 * from parentage rather than read from the record, so a stored node claiming
 * `depth: 0` cannot smuggle itself past a depth limit.
 */
import type { ExecutionNode, ExecutionNodeId } from "@nightshift/contracts";
import { CycleError, TreeStructureError } from "../errors.js";
import { assertOwnershipChain } from "./ownership.js";

export interface ExecutionTree {
  readonly nodes: ReadonlyMap<ExecutionNodeId, ExecutionNode>;
  readonly rootId: ExecutionNodeId;
}

const childIndex = (
  nodes: Iterable<ExecutionNode>,
): Map<ExecutionNodeId | null, ExecutionNode[]> => {
  const index = new Map<ExecutionNodeId | null, ExecutionNode[]>();
  for (const node of nodes) {
    const siblings = index.get(node.parentNodeId) ?? [];
    siblings.push(node);
    index.set(node.parentNodeId, siblings);
  }
  return index;
};

/** Indexes by identifier, rejecting a duplicate. */
const indexById = (nodes: readonly ExecutionNode[]): Map<ExecutionNodeId, ExecutionNode> => {
  const byId = new Map<ExecutionNodeId, ExecutionNode>();
  for (const node of nodes) {
    if (byId.has(node.executionNodeId)) {
      throw new TreeStructureError(`duplicate node ${node.executionNodeId}`, node.executionNodeId);
    }
    byId.set(node.executionNodeId, node);
  }
  return byId;
};

/** The one node with no parent. Zero or several is a malformed tree. */
const findSoleRoot = (nodes: readonly ExecutionNode[]): ExecutionNode => {
  const roots = nodes.filter((node) => node.parentNodeId === null);
  const root = roots[0];
  if (roots.length === 0 || root === undefined) {
    throw new TreeStructureError("tree has no root node");
  }
  if (roots.length > 1) {
    throw new TreeStructureError(
      `tree has ${roots.length} root nodes: ${roots.map((r) => r.executionNodeId).join(", ")}`,
    );
  }
  return root;
};

/** Every parent reference resolves, no node parents itself, all share one chain. */
const assertEdgesResolve = (
  nodes: readonly ExecutionNode[],
  byId: ReadonlyMap<ExecutionNodeId, ExecutionNode>,
  root: ExecutionNode,
): void => {
  for (const node of nodes) {
    if (node.parentNodeId === node.executionNodeId) {
      throw new CycleError(node.executionNodeId, node.executionNodeId);
    }
    if (node.parentNodeId !== null && !byId.has(node.parentNodeId)) {
      throw new TreeStructureError(
        `node ${node.executionNodeId} references unknown parent ${node.parentNodeId}`,
        node.executionNodeId,
      );
    }
    // Every node shares the root's ownership chain (A-07).
    assertOwnershipChain(root, node);
  }
};

/**
 * Every node reaches the root by following parent links. A node that does not is
 * either inside a cycle or in a component detached from the root, and this is
 * where SC-P1-11 is actually enforced for an arbitrary node list.
 */
const assertConnectedAndAcyclic = (
  nodes: readonly ExecutionNode[],
  byId: ReadonlyMap<ExecutionNodeId, ExecutionNode>,
  root: ExecutionNode,
): void => {
  for (const node of nodes) {
    const seen = new Set<ExecutionNodeId>([node.executionNodeId]);
    let current: ExecutionNode | undefined = node;
    while (current !== undefined && current.parentNodeId !== null) {
      const parentId: ExecutionNodeId = current.parentNodeId;
      if (seen.has(parentId)) throw new CycleError(node.executionNodeId, parentId);
      seen.add(parentId);
      current = byId.get(parentId);
    }
    if (current === undefined || current.executionNodeId !== root.executionNodeId) {
      throw new TreeStructureError(
        `node ${node.executionNodeId} is not connected to the root`,
        node.executionNodeId,
      );
    }
  }
};

/**
 * Builds a validated tree from an unordered node list.
 *
 * Rejects: duplicate identifiers, a missing or multiple root, an unknown parent,
 * a node parented to itself, any cycle, any component detached from the root, and
 * any node whose ownership chain differs from the root's.
 */
export const buildTree = (nodes: readonly ExecutionNode[]): ExecutionTree => {
  const byId = indexById(nodes);
  const root = findSoleRoot(nodes);
  assertEdgesResolve(nodes, byId, root);
  assertConnectedAndAcyclic(nodes, byId, root);
  return { nodes: byId, rootId: root.executionNodeId };
};

/** A tree containing only a run's root node. */
export const singletonTree = (root: ExecutionNode): ExecutionTree => {
  if (root.parentNodeId !== null) {
    throw new TreeStructureError(
      `root node ${root.executionNodeId} must have a null parent`,
      root.executionNodeId,
    );
  }
  return buildTree([root]);
};

export const getNode = (tree: ExecutionTree, id: ExecutionNodeId): ExecutionNode => {
  const node = tree.nodes.get(id);
  if (node === undefined) throw new TreeStructureError(`unknown node ${id}`, id);
  return node;
};

export const hasNode = (tree: ExecutionTree, id: ExecutionNodeId): boolean => tree.nodes.has(id);

/** Ancestors from the immediate parent up to the root. */
export const ancestorsOf = (
  tree: ExecutionTree,
  id: ExecutionNodeId,
): readonly ExecutionNodeId[] => {
  const chain: ExecutionNodeId[] = [];
  let current = getNode(tree, id).parentNodeId;
  while (current !== null) {
    chain.push(current);
    current = getNode(tree, current).parentNodeId;
  }
  return chain;
};

export const childrenOf = (tree: ExecutionTree, id: ExecutionNodeId): readonly ExecutionNode[] => {
  const index = childIndex(tree.nodes.values());
  return index.get(id) ?? [];
};

/** Every node beneath `id`, excluding `id` itself. */
export const descendantsOf = (
  tree: ExecutionTree,
  id: ExecutionNodeId,
): readonly ExecutionNodeId[] => {
  const index = childIndex(tree.nodes.values());
  const collected: ExecutionNodeId[] = [];
  const queue: ExecutionNodeId[] = [id];
  while (queue.length > 0) {
    const current = queue.pop();
    if (current === undefined) break;
    for (const child of index.get(current) ?? []) {
      collected.push(child.executionNodeId);
      queue.push(child.executionNodeId);
    }
  }
  return collected;
};

/** Distance from the root. The root itself is 0. */
export const depthOf = (tree: ExecutionTree, id: ExecutionNodeId): number =>
  ancestorsOf(tree, id).length;

/** The depth a new child of `parentId` would occupy. */
export const depthOfChildOf = (tree: ExecutionTree, parentId: ExecutionNodeId): number =>
  depthOf(tree, parentId) + 1;

/**
 * Attaches `node` beneath `parentId`.
 *
 * Rejects an unknown parent, a duplicate identifier, a self-parent, an
 * ownership-chain mismatch, and any edge that would create a cycle — which here
 * means attaching a node that is already an ancestor of its intended parent.
 */
export const addChild = (
  tree: ExecutionTree,
  parentId: ExecutionNodeId,
  node: ExecutionNode,
): ExecutionTree => {
  const parent = getNode(tree, parentId);

  // Cycle checks come first. A node that is already an ancestor of `parentId` is
  // necessarily present in the tree, so checking for a duplicate first would
  // report every cycle as a duplicate and leave the cycle branch unreachable.
  if (node.executionNodeId === parentId) {
    throw new CycleError(node.executionNodeId, parentId);
  }
  if (ancestorsOf(tree, parentId).includes(node.executionNodeId)) {
    throw new CycleError(node.executionNodeId, parentId);
  }
  if (tree.nodes.has(node.executionNodeId)) {
    throw new TreeStructureError(`duplicate node ${node.executionNodeId}`, node.executionNodeId);
  }
  if (node.parentNodeId !== parentId) {
    throw new TreeStructureError(
      `node ${node.executionNodeId} declares parent ${String(node.parentNodeId)} but is being attached under ${parentId}`,
      node.executionNodeId,
    );
  }
  assertOwnershipChain(parent, node);

  const nodes = new Map(tree.nodes);
  // Depth is recomputed rather than trusted, so a tampered record cannot
  // understate how deep it sits.
  nodes.set(node.executionNodeId, { ...node, depth: depthOf(tree, parentId) + 1 });
  return { nodes, rootId: tree.rootId };
};

/**
 * Moves `nodeId` beneath `newParentId`.
 *
 * Rejects moving the root, moving a node under itself or under one of its own
 * descendants (both cycles), and moving across an ownership chain (SC-P1-12).
 */
export const reparent = (
  tree: ExecutionTree,
  nodeId: ExecutionNodeId,
  newParentId: ExecutionNodeId,
): ExecutionTree => {
  const node = getNode(tree, nodeId);
  const newParent = getNode(tree, newParentId);

  if (nodeId === tree.rootId) {
    throw new TreeStructureError(`the root node ${nodeId} cannot be reparented`, nodeId);
  }
  if (nodeId === newParentId) throw new CycleError(nodeId, newParentId);
  if (descendantsOf(tree, nodeId).includes(newParentId)) {
    throw new CycleError(nodeId, newParentId);
  }
  assertOwnershipChain(node, newParent);

  const nodes = new Map(tree.nodes);
  nodes.set(nodeId, { ...node, parentNodeId: newParentId });
  const moved: ExecutionTree = { nodes, rootId: tree.rootId };

  // Depths below the moved node all shift; recompute the whole tree so no stored
  // depth is left stale.
  return recomputeDepths(moved);
};

/** Rewrites every node's `depth` from its actual parentage. */
export const recomputeDepths = (tree: ExecutionTree): ExecutionTree => {
  const nodes = new Map(tree.nodes);
  for (const [id, node] of tree.nodes) {
    const depth = depthOf(tree, id);
    if (node.depth !== depth) nodes.set(id, { ...node, depth });
  }
  return { nodes, rootId: tree.rootId };
};

/** Every node in the tree, in no guaranteed order. */
export const allNodes = (tree: ExecutionTree): readonly ExecutionNode[] => [...tree.nodes.values()];

/** The greatest depth present in the tree. */
export const treeDepth = (tree: ExecutionTree): number =>
  Math.max(...[...tree.nodes.keys()].map((id) => depthOf(tree, id)));
