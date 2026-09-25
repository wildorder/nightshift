/**
 * Recording run-scoped records: decisions, checkpoints, verifications, routing
 * decisions and artifact references. Create semantics throughout.
 */
import {
  type Agent,
  ArtifactSchema,
  CheckpointSchema,
  type Decision,
  DecisionSchema,
  type Examination,
  ExaminationSchema,
  type Principal,
  RoutingDecisionSchema,
  VerificationSchema,
} from "@nightshift/contracts";
import {
  type AgentRoute,
  examinationRequirementFor,
  explainExaminationUpdate,
  explainRoutingUpdate,
  isSuperseded,
  mayArbitrate,
  mayExamine,
  type NightshiftStores,
  overrideDecision,
  type RunScope,
  recordDecision,
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
import {
  createOrConfirm,
  pageAt,
  pageBody,
  readAll,
  requireProgram,
  requireRun,
  withCursor,
} from "./common.js";

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

export const putDecision: Handler = async ({ deps, request, params, principal }) => {
  const decision = parseBody(DecisionSchema, request.body);
  const scope = runScopeFrom(params);
  assertChainMatches(scope, decision);
  assertIdentifierMatches("decisionId", pathId("dec", params, "decisionId"), decision.decisionId);
  await requireRun(deps.stores, scope);

  if (principal.kind === "execution" && principal.role === "arbiter") {
    await assertArbiterMayRule(deps.stores, scope, principal, decision);
  }
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
  if (existing === undefined || sameRecord(existing, decision)) {
    return createOrConfirm(existing, decision, () => deps.stores.routingDecisions.put(decision));
  }

  // An update. `core` says what may change: usage once from empty, outcome once
  // from pending, and nothing else (D-P5-06).
  const problems = explainRoutingUpdate(existing, decision);
  if (problems.length > 0) throw new HttpError(409, "conflict", problems.join("; "));
  await deps.stores.routingDecisions.put(decision);
  return { status: 200, body: decision };
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
// unavailable until P8 (D-P3-07), and a delegation whose risk requires it is
// refused up front. These routes exist for port completeness, so the http
// adapter implements every project-scoped port rather than most of them, and so
// that P8 adds an examiner rather than an API.

export const putExamination: Handler = async ({ deps, request, params, principal }) => {
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

  if (principal.kind === "execution" && principal.role === "examiner") {
    // An examiner writes its own verdict, once, and nothing after (D-P8-10).
    if (existing !== undefined && !sameRecord(existing, examination)) {
      throw new HttpError(
        403,
        "execution_forbidden_operation",
        "an examiner writes its examination once",
      );
    }
    await assertExaminerIndependent(deps.stores, scope, principal, examination);
    return createOrConfirm(existing, examination, () => deps.stores.examinations.put(examination));
  }
  if (principal.kind === "execution" && principal.role === "orchestrator") {
    // A dispute of a finding on work it delegated, and nothing else (D-P8-13).
    if (existing === undefined) {
      throw new HttpError(
        403,
        "execution_forbidden_operation",
        "an orchestrator may not write an examination",
      );
    }
    assertOnlyDisputes(existing, examination);
  }

  if (existing === undefined || sameRecord(existing, examination)) {
    return createOrConfirm(existing, examination, () => deps.stores.examinations.put(examination));
  }
  // An update. `core` says what may change: a finding's resolution, forward.
  const problems = explainExaminationUpdate(existing, examination);
  if (problems.length > 0) throw new HttpError(409, "conflict", problems.join("; "));
  await deps.stores.examinations.put(examination);
  return { status: 200, body: examination };
};

type ExecutionPrincipal = Extract<Principal, { kind: "execution" }>;

const routeOf = (agent: Agent): AgentRoute => ({
  agentId: agent.agentId,
  provider: agent.provider,
  model: agent.model,
});

const requireAgent = async (
  stores: NightshiftStores,
  scope: RunScope,
  agentId: Agent["agentId"],
  what: string,
): Promise<Agent> => {
  const agent = await stores.agents.get(scope, agentId);
  if (agent === undefined)
    throw new HttpError(409, "conflict", `the ${what} ${agentId} is not an agent of this run`);
  return agent;
};

/**
 * The examiner's verdict, held to the agents the control plane stores (D-P8-10,
 * SC-P8-10). The body cannot name another examiner, examine another node, claim
 * another route, or have been chosen against the policy's requirement: the
 * requirement is read from the run's recorded policy at the job's own risk.
 */
const assertExaminerIndependent = async (
  stores: NightshiftStores,
  scope: RunScope,
  principal: ExecutionPrincipal,
  examination: Examination,
): Promise<void> => {
  if (
    examination.examinerAgentId !== principal.agentId ||
    examination.executionNodeId !== principal.nodeId
  ) {
    throw new HttpError(
      403,
      "execution_out_of_scope",
      "an examiner may only record its own examination of its own node",
    );
  }
  const examiner = await requireAgent(stores, scope, principal.agentId, "examiner");
  const implementer = await requireAgent(
    stores,
    scope,
    examination.implementerAgentId,
    "implementer",
  );
  if (
    implementer.executionNodeId !== examination.executionNodeId ||
    implementer.role !== "worker"
  ) {
    throw new HttpError(
      409,
      "conflict",
      "the implementer named is not a worker on the examined node",
    );
  }
  const route = examination.examinerRoute;
  if (
    route.harness !== examiner.harness ||
    route.provider !== examiner.provider ||
    route.model !== examiner.model
  ) {
    throw new HttpError(
      409,
      "conflict",
      "the examiner's route does not match the agent the control plane holds",
    );
  }

  const node = await stores.executionNodes.get(scope, examination.executionNodeId);
  const job =
    node?.jobContractId === null || node === undefined
      ? undefined
      : await stores.jobContracts.get(scope, node.jobContractId);
  if (job === undefined)
    throw new HttpError(409, "conflict", "the examined node has no Job Contract");
  if (job.risk !== examination.requiredByRisk) {
    throw new HttpError(
      409,
      "conflict",
      `the job's risk is ${job.risk}, not ${examination.requiredByRisk}`,
    );
  }

  const run = await stores.runs.get(scope, scope.runId);
  const policy =
    run?.policy?.examinationPolicy ?? (await requireProgram(stores, scope)).examinationPolicy;
  const requirement = examinationRequirementFor(policy, job.risk);
  if (examination.blocking !== requirement.blockOnMaterialFindings) {
    throw new HttpError(
      409,
      "conflict",
      "the examination's blocking flag disagrees with the run's policy",
    );
  }
  const problems = mayExamine(requirement, routeOf(implementer), routeOf(examiner));
  if (problems.length > 0) {
    throw new HttpError(
      403,
      "examiner_not_independent",
      problems.map((problem) => problem.detail).join("; "),
    );
  }
};

/** An orchestrator's write moves findings from unresolved to disputed, on its own authority, and nothing else. */
const assertOnlyDisputes = (existing: Examination, next: Examination): void => {
  const problems = explainExaminationUpdate(existing, next);
  if (problems.length > 0) throw new HttpError(409, "conflict", problems.join("; "));
  existing.findings.forEach((before, index) => {
    const after = next.findings[index];
    if (after === undefined || after.resolution === before.resolution) return;
    if (after.resolution !== "disputed" || after.resolvedBy?.authority !== "agent") {
      throw new HttpError(
        403,
        "execution_forbidden_operation",
        `an orchestrator may only dispute a finding, not mark ${before.id} ${after.resolution}`,
      );
    }
  });
};

/**
 * The arbiter's ruling, held to the dispute it rules on (D-P8-13): its own
 * decision, on its own node, where a finding stands disputed, by an agent that
 * is neither side and shares a model with neither.
 */
const assertArbiterMayRule = async (
  stores: NightshiftStores,
  scope: RunScope,
  principal: ExecutionPrincipal,
  decision: Decision,
): Promise<void> => {
  if (decision.agentId !== principal.agentId || decision.executionNodeId !== principal.nodeId) {
    throw new HttpError(
      403,
      "execution_out_of_scope",
      "an arbiter may only record its own ruling on its own node",
    );
  }
  if (decision.authority !== "agent" || decision.supersedesDecisionId !== null) {
    throw new HttpError(
      403,
      "decision_authority",
      "an arbiter's ruling is an agent's decision and supersedes nothing",
    );
  }
  const examinations = await stores.examinations.listByNode(scope, principal.nodeId);
  const disputed = [...examinations]
    .reverse()
    .find((examination) =>
      examination.findings.some((finding) => finding.resolution === "disputed"),
    );
  if (disputed === undefined) {
    throw new HttpError(409, "conflict", "there is no disputed finding on this node to rule on");
  }
  const arbiter = await requireAgent(stores, scope, principal.agentId, "arbiter");
  const implementer = await requireAgent(stores, scope, disputed.implementerAgentId, "implementer");
  const examiner = await requireAgent(stores, scope, disputed.examinerAgentId, "examiner");
  const problems = mayArbitrate(routeOf(implementer), routeOf(examiner), routeOf(arbiter));
  if (problems.length > 0) {
    throw new HttpError(
      403,
      "arbiter_not_independent",
      problems.map((problem) => problem.detail).join("; "),
    );
  }
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
