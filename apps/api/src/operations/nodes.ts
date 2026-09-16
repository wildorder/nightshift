/**
 * Execution nodes: create, update, read.
 *
 * Every rule here is a `@nightshift/core` rule. This module only gathers the
 * stored records those rules need and decides which rule a request invokes; it
 * does not restate any of them.
 */
import {
  type ExecutionNode,
  ExecutionNodeSchema,
  type ProgramContract,
  type Run,
} from "@nightshift/contracts";
import {
  addChild,
  assertDelegationAllowed,
  buildTree,
  explainEvidenceMismatch,
  explainWidening,
  IllegalTransitionError,
  isPostVerification,
  isValidEvidence,
  legalEventsFrom,
  markImplemented,
  markVerificationFailed,
  markVerified,
  type NightshiftStores,
  nextStatus,
  type RunScope,
  ScopeWideningError,
  type TransitionEvent,
  TreeStructureError,
  transition,
  VerificationEvidenceError,
} from "@nightshift/core";
import { HttpError, parseBody, sameRecord } from "../http.js";
import {
  assertChainMatches,
  assertIdentifierMatches,
  parsePageQuery,
  pathId,
  runScopeFrom,
} from "../params.js";
import type { Handler } from "../router.js";
import { pageAt, pageBody, readAll, requireProgram, requireRun, withCursor } from "./common.js";

const depthMismatch = (node: ExecutionNode, depth: number): TreeStructureError =>
  new TreeStructureError(
    `node ${node.executionNodeId} declares depth ${node.depth} but sits at depth ${depth}`,
    node.executionNodeId,
  );

const createNode = async (
  stores: NightshiftStores,
  scope: RunScope,
  run: Run,
  program: ProgramContract,
  node: ExecutionNode,
): Promise<void> => {
  // A node reaches `verified` or beyond only through a transition backed by
  // evidence (A-05). Creating one already there would skip that.
  if (isPostVerification(node.status)) {
    throw new VerificationEvidenceError(
      `a node cannot be created as "${node.status}"; it reaches that status only through verification`,
    );
  }

  const stored = await readAll((cursor) => stores.executionNodes.listByRun(scope, pageAt(cursor)));

  if (node.parentNodeId === null) {
    if (node.executionNodeId !== run.rootNodeId) {
      throw new TreeStructureError(
        `run ${run.runId} declares ${run.rootNodeId} as its root, so ${node.executionNodeId} cannot be a root`,
        node.executionNodeId,
      );
    }
    // The root's authority is the program contract's scope, narrowed or inherited.
    const widenings = explainWidening(program.scope, node.scope);
    if (widenings.length > 0) throw new ScopeWideningError(widenings);
    buildTree([...stored, node]);
    if (node.depth !== 0) throw depthMismatch(node, 0);
    return;
  }

  const parentId = node.parentNodeId;
  if (!stored.some((candidate) => candidate.executionNodeId === parentId)) {
    throw new HttpError(404, "not_found", `parent node ${parentId} does not exist in this run`);
  }
  const tree = buildTree(stored);
  // Delegation authority, depth and concurrency limits, and scope narrowing (A-11).
  const { depth } = assertDelegationAllowed(tree, parentId, program.delegationLimits, node.scope);
  if (node.depth !== depth) throw depthMismatch(node, depth);
  // Cycles, duplicates and the ownership chain.
  addChild(tree, parentId, node);
};

/** Fixed at creation. Reparenting is not an API operation. */
const IMMUTABLE_FIELDS = ["kind", "parentNodeId", "depth", "scope", "createdAt"] as const;

/**
 * Refuses changes to fields fixed at creation, and to the commit or job once the
 * node has been verified. Returns whether the commit or job changed.
 */
const assertMutableChangesOnly = (existing: ExecutionNode, node: ExecutionNode): boolean => {
  for (const field of IMMUTABLE_FIELDS) {
    if (!sameRecord(existing[field], node[field])) {
      throw new HttpError(409, "conflict", `${field} cannot change once a node exists`);
    }
  }
  if (existing.jobContractId !== null && node.jobContractId !== existing.jobContractId) {
    throw new HttpError(409, "conflict", "jobContractId cannot change once it is set");
  }
  // A durable failure reason is written once. Rewriting it would let a later
  // caller edit the record of why work failed, which is the opposite of durable.
  if (existing.outcomeReason !== undefined && node.outcomeReason !== existing.outcomeReason) {
    throw new HttpError(409, "conflict", "outcomeReason cannot change once it is set");
  }

  const workChanged =
    existing.commitSha !== node.commitSha || existing.jobContractId !== node.jobContractId;
  if (workChanged && isPostVerification(existing.status)) {
    throw new VerificationEvidenceError(
      `node ${existing.executionNodeId} is ${existing.status}; changing its commit or job would detach it from its verification`,
    );
  }
  return workChanged;
};

const updateNode = async (
  stores: NightshiftStores,
  scope: RunScope,
  existing: ExecutionNode,
  node: ExecutionNode,
): Promise<void> => {
  const workChanged = assertMutableChangesOnly(existing, node);
  if (existing.status === node.status) return;

  // Each target status is reached by at most one event from a given status.
  const event = legalEventsFrom(existing.status).find(
    (candidate) => nextStatus(existing.status, candidate) === node.status,
  );
  if (event === undefined) {
    throw new IllegalTransitionError(existing.status, `transition to ${node.status}`);
  }
  await assertTransitionAllowed(stores, scope, existing, node, event, workChanged);
};

/** Applies the core rule for `event`; the rules throw when the transition is not allowed. */
const assertTransitionAllowed = async (
  stores: NightshiftStores,
  scope: RunScope,
  existing: ExecutionNode,
  node: ExecutionNode,
  event: TransitionEvent,
  workChanged: boolean,
): Promise<void> => {
  const id = existing.executionNodeId;
  const at = node.updatedAt;
  switch (event) {
    case "report_implemented": {
      if (node.commitSha === null) {
        throw new HttpError(
          422,
          "commit_required",
          "a node reported implemented must carry commitSha",
        );
      }
      markImplemented(existing, node.commitSha, at);
      return;
    }
    case "verification_passed": {
      if (workChanged) {
        throw new VerificationEvidenceError(
          "verification must cover the commit and job the node was already on",
        );
      }
      const verifications = await stores.verifications.listByNode(scope, id);
      const evidence = verifications.find((candidate) => isValidEvidence(existing, candidate));
      if (evidence === undefined) {
        const latest = verifications.at(-1);
        throw new VerificationEvidenceError(
          latest === undefined
            ? `no verification is recorded for node ${id}`
            : explainEvidenceMismatch(existing, latest).join("; "),
        );
      }
      markVerified(existing, evidence, at);
      return;
    }
    case "verification_failed": {
      const verifications = await stores.verifications.listByNode(scope, id);
      const failure = verifications.find(
        (candidate) => candidate.outcome === "failed" && candidate.commitSha === existing.commitSha,
      );
      if (failure === undefined) {
        throw new VerificationEvidenceError(
          `no failed verification is recorded for node ${id} at its current commit`,
        );
      }
      markVerificationFailed(existing, failure, at);
      return;
    }
    default:
      transition(existing, event, at);
  }
};

export const putNode: Handler = async ({ deps, request, params }) => {
  const node = parseBody(ExecutionNodeSchema, request.body);
  const scope = runScopeFrom(params);
  const nodeId = pathId("node", params, "nodeId");
  assertChainMatches(scope, node);
  assertIdentifierMatches("executionNodeId", nodeId, node.executionNodeId);

  const { stores } = deps;
  const run = await requireRun(stores, scope);
  const existing = await stores.executionNodes.get(scope, nodeId);

  if (existing === undefined) {
    const program = await requireProgram(stores, scope);
    await createNode(stores, scope, run, program, node);
    await stores.executionNodes.put(node);
    return { status: 201, body: node };
  }

  if (sameRecord(existing, node)) return { status: 200, body: existing };
  await updateNode(stores, scope, existing, node);
  await stores.executionNodes.put(node);
  return { status: 200, body: node };
};

export const getNode: Handler = async ({ deps, params }) => {
  const scope = runScopeFrom(params);
  const nodeId = pathId("node", params, "nodeId");
  const node = await deps.stores.executionNodes.get(scope, nodeId);
  if (node === undefined) {
    throw new HttpError(404, "not_found", `node ${nodeId} does not exist in this run`);
  }
  return { status: 200, body: node };
};

/** Every node of a run, for `execution.status` and the http adapter's `listByRun`. */
export const listNodes: Handler = async ({ deps, request, params }) => {
  const scope = runScopeFrom(params);
  const page = parsePageQuery(request.query);
  await requireRun(deps.stores, scope);
  const result = await withCursor(() => deps.stores.executionNodes.listByRun(scope, page));
  return { status: 200, body: pageBody(result) };
};

/**
 * One node's children. The port returns all of them rather than a page: a
 * parent's children are bounded by `delegationLimits`, not by data volume.
 */
export const listChildren: Handler = async ({ deps, params }) => {
  const scope = runScopeFrom(params);
  const nodeId = pathId("node", params, "nodeId");
  await requireRun(deps.stores, scope);
  const items = await deps.stores.executionNodes.listChildren(scope, nodeId);
  return { status: 200, body: pageBody({ items }) };
};
