/**
 * Recording run-scoped records: decisions, checkpoints, verifications, routing
 * decisions and artifact references. Create semantics throughout.
 */
import {
  ArtifactSchema,
  CheckpointSchema,
  type Decision,
  DecisionSchema,
  ExaminationSchema,
  RoutingDecisionSchema,
  VerificationSchema,
} from "@nightshift/contracts";
import {
  isSuperseded,
  type NightshiftStores,
  overrideDecision,
  type RunScope,
  recordDecision,
} from "@nightshift/core";
import { HttpError, parseBody } from "../http.js";
import {
  assertChainMatches,
  assertIdentifierMatches,
  parsePageQuery,
  pathId,
  runScopeFrom,
} from "../params.js";
import type { Handler } from "../router.js";
import { createOrConfirm, pageAt, pageBody, readAll, requireRun, withCursor } from "./common.js";

/**
 * A bare decision goes through `recordDecision`. One that supersedes another goes
 * through `overrideDecision`, which refuses an agent overriding a human and any
 * softening of reversibility. A decision may be superseded once: two competing
 * overrides would make the effective decision ambiguous.
 */
const validateDecision = async (
  stores: NightshiftStores,
  scope: RunScope,
  decision: Decision,
): Promise<void> => {
  if (decision.supersedesDecisionId === null) {
    recordDecision(decision);
    return;
  }
  const original = await stores.decisions.get(scope, decision.supersedesDecisionId);
  if (original === undefined) {
    throw new HttpError(
      404,
      "not_found",
      `superseded decision ${decision.supersedesDecisionId} does not exist in this run`,
    );
  }
  overrideDecision(original, decision, decision.createdAt);

  const others = (
    await readAll((cursor) => stores.decisions.listByRun(scope, pageAt(cursor)))
  ).filter((other) => other.decisionId !== decision.decisionId);
  if (isSuperseded(original, others)) {
    throw new HttpError(409, "conflict", `decision ${original.decisionId} is already superseded`);
  }
};

export const putDecision: Handler = async ({ deps, request, params }) => {
  const decision = parseBody(DecisionSchema, request.body);
  const scope = runScopeFrom(params);
  assertChainMatches(scope, decision);
  assertIdentifierMatches("decisionId", pathId("dec", params, "decisionId"), decision.decisionId);
  await requireRun(deps.stores, scope);

  await validateDecision(deps.stores, scope, decision);
  const existing = await deps.stores.decisions.get(scope, decision.decisionId);
  return createOrConfirm(existing, decision, () => deps.stores.decisions.put(decision));
};

export const putCheckpoint: Handler = async ({ deps, request, params }) => {
  const checkpoint = parseBody(CheckpointSchema, request.body);
  const scope = runScopeFrom(params);
  assertChainMatches(scope, checkpoint);
  assertIdentifierMatches(
    "checkpointId",
    pathId("ckpt", params, "checkpointId"),
    checkpoint.checkpointId,
  );
  await requireRun(deps.stores, scope);

  const existing = await deps.stores.checkpoints.get(scope, checkpoint.checkpointId);
  return createOrConfirm(existing, checkpoint, () => deps.stores.checkpoints.put(checkpoint));
};

export const putVerification: Handler = async ({ deps, request, params }) => {
  const verification = parseBody(VerificationSchema, request.body);
  const scope = runScopeFrom(params);
  assertChainMatches(scope, verification);
  assertIdentifierMatches(
    "verificationId",
    pathId("ver", params, "verificationId"),
    verification.verificationId,
  );
  await requireRun(deps.stores, scope);

  const existing = await deps.stores.verifications.get(scope, verification.verificationId);
  return createOrConfirm(existing, verification, () => deps.stores.verifications.put(verification));
};

export const putRoutingDecision: Handler = async ({ deps, request, params }) => {
  const decision = parseBody(RoutingDecisionSchema, request.body);
  const scope = runScopeFrom(params);
  assertChainMatches(scope, decision);
  assertIdentifierMatches(
    "routingDecisionId",
    pathId("route", params, "routingDecisionId"),
    decision.routingDecisionId,
  );
  await requireRun(deps.stores, scope);

  // The port has no `get` for routing decisions, so a duplicate is found among
  // the node's records. A retry that changed `executionNodeId` would not be seen
  // as a duplicate; the port would need a `get` to close that.
  const existing = (
    await deps.stores.routingDecisions.listByNode(scope, decision.executionNodeId)
  ).find((candidate) => candidate.routingDecisionId === decision.routingDecisionId);
  return createOrConfirm(existing, decision, () => deps.stores.routingDecisions.put(decision));
};

export const putArtifact: Handler = async ({ deps, request, params }) => {
  // The schema has no content field, so inline output is refused here (A-08).
  const artifact = parseBody(ArtifactSchema, request.body);
  const scope = runScopeFrom(params);
  assertChainMatches(scope, artifact);
  assertIdentifierMatches("artifactId", pathId("art", params, "artifactId"), artifact.artifactId);
  await requireRun(deps.stores, scope);

  const existing = await deps.stores.artifacts.get(scope, artifact.artifactId);
  return createOrConfirm(existing, artifact, () => deps.stores.artifacts.put(artifact));
};

// ---------------------------------------------------------------------------
// Reads (T2)
// ---------------------------------------------------------------------------
//
// P2 stopped at the writes its smoke suite covered and told P3 to ask for what
// it needs. This is the ask: the reads the http adapter needs to implement every
// project-scoped port, so `execution` depends on one port interface whichever
// adapter is wired (D-P3-02).

export const getDecision: Handler = async ({ deps, params }) => {
  const scope = runScopeFrom(params);
  const decisionId = pathId("dec", params, "decisionId");
  const decision = await deps.stores.decisions.get(scope, decisionId);
  if (decision === undefined) {
    throw new HttpError(404, "not_found", `decision ${decisionId} does not exist in this run`);
  }
  return { status: 200, body: decision };
};

export const listDecisions: Handler = async ({ deps, request, params }) => {
  const scope = runScopeFrom(params);
  const page = parsePageQuery(request.query);
  await requireRun(deps.stores, scope);
  const result = await withCursor(() => deps.stores.decisions.listByRun(scope, page));
  return { status: 200, body: pageBody(result) };
};

export const getCheckpoint: Handler = async ({ deps, params }) => {
  const scope = runScopeFrom(params);
  const checkpointId = pathId("ckpt", params, "checkpointId");
  const checkpoint = await deps.stores.checkpoints.get(scope, checkpointId);
  if (checkpoint === undefined) {
    throw new HttpError(404, "not_found", `checkpoint ${checkpointId} does not exist in this run`);
  }
  return { status: 200, body: checkpoint };
};

export const listCheckpoints: Handler = async ({ deps, request, params }) => {
  const scope = runScopeFrom(params);
  const page = parsePageQuery(request.query);
  await requireRun(deps.stores, scope);
  const result = await withCursor(() => deps.stores.checkpoints.listByRun(scope, page));
  return { status: 200, body: pageBody(result) };
};

export const getVerification: Handler = async ({ deps, params }) => {
  const scope = runScopeFrom(params);
  const verificationId = pathId("ver", params, "verificationId");
  const verification = await deps.stores.verifications.get(scope, verificationId);
  if (verification === undefined) {
    throw new HttpError(
      404,
      "not_found",
      `verification ${verificationId} does not exist in this run`,
    );
  }
  return { status: 200, body: verification };
};

export const listVerificationsByNode: Handler = async ({ deps, params }) => {
  const scope = runScopeFrom(params);
  const nodeId = pathId("node", params, "nodeId");
  await requireRun(deps.stores, scope);
  const items = await deps.stores.verifications.listByNode(scope, nodeId);
  return { status: 200, body: pageBody({ items }) };
};

export const listRoutingDecisionsByNode: Handler = async ({ deps, params }) => {
  const scope = runScopeFrom(params);
  const nodeId = pathId("node", params, "nodeId");
  await requireRun(deps.stores, scope);
  const items = await deps.stores.routingDecisions.listByNode(scope, nodeId);
  return { status: 200, body: pageBody({ items }) };
};

export const getArtifact: Handler = async ({ deps, params }) => {
  const scope = runScopeFrom(params);
  const artifactId = pathId("art", params, "artifactId");
  const artifact = await deps.stores.artifacts.get(scope, artifactId);
  if (artifact === undefined) {
    throw new HttpError(404, "not_found", `artifact ${artifactId} does not exist in this run`);
  }
  return { status: 200, body: artifact };
};

export const listArtifacts: Handler = async ({ deps, request, params }) => {
  const scope = runScopeFrom(params);
  const page = parsePageQuery(request.query);
  await requireRun(deps.stores, scope);
  const result = await withCursor(() => deps.stores.artifacts.listByRun(scope, page));
  return { status: 200, body: pageBody(result) };
};

// ---------------------------------------------------------------------------
// Examinations (T2)
// ---------------------------------------------------------------------------
//
// Create and read only, and **nothing in P3 writes one**: examination is
// unavailable until P7 (D-P3-07), and a delegation whose risk requires it is
// refused up front. These routes exist for port completeness, so the http
// adapter implements every project-scoped port rather than most of them, and so
// that P7 adds an examiner rather than an API.

export const putExamination: Handler = async ({ deps, request, params }) => {
  const examination = parseBody(ExaminationSchema, request.body);
  const scope = runScopeFrom(params);
  assertChainMatches(scope, examination);
  assertIdentifierMatches(
    "examinationId",
    pathId("exam", params, "examinationId"),
    examination.examinationId,
  );
  await requireRun(deps.stores, scope);

  const existing = await deps.stores.examinations.get(scope, examination.examinationId);
  return createOrConfirm(existing, examination, () => deps.stores.examinations.put(examination));
};

export const getExamination: Handler = async ({ deps, params }) => {
  const scope = runScopeFrom(params);
  const examinationId = pathId("exam", params, "examinationId");
  const examination = await deps.stores.examinations.get(scope, examinationId);
  if (examination === undefined) {
    throw new HttpError(
      404,
      "not_found",
      `examination ${examinationId} does not exist in this run`,
    );
  }
  return { status: 200, body: examination };
};

export const listExaminationsByNode: Handler = async ({ deps, params }) => {
  const scope = runScopeFrom(params);
  const nodeId = pathId("node", params, "nodeId");
  await requireRun(deps.stores, scope);
  const items = await deps.stores.examinations.listByNode(scope, nodeId);
  return { status: 200, body: pageBody({ items }) };
};
