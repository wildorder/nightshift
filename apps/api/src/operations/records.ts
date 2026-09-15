/**
 * Recording run-scoped records: decisions, checkpoints, verifications, routing
 * decisions and artifact references. Create semantics throughout.
 */
import {
  ArtifactSchema,
  CheckpointSchema,
  type Decision,
  DecisionSchema,
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
import { assertChainMatches, assertIdentifierMatches, pathId, runScopeFrom } from "../params.js";
import type { Handler } from "../router.js";
import { createOrConfirm, pageAt, readAll, requireRun } from "./common.js";

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
