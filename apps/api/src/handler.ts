/**
 * The control-plane API (T4): a pure function from request to response.
 *
 * There is no authentication here, by design. Nightshift's Lambda authorizer
 * validates the token and decides its kind before this code runs (A-19 as
 * amended, A-36), and a second check here would be a second place for
 * authentication to live.
 *
 * **Authorisation** is here, in exactly one place: `enforce` runs before every
 * operation, comparing the caller's organisation against the target project's
 * and an execution principal's reach against the table in `core` (D-P4-02,
 * D-P4-05). The ownership chain still comes from the path (A-23); what P4 adds
 * is that the chain now has to belong to the caller.
 *
 * The route table grew in P3 (D-P3-13) to cover every port method the local
 * machinery uses, plus a presigned artifact upload. Anything not listed is
 * surface area the smoke suite would have to cover, so it is not added
 * speculatively — and every route here is exercised by the smoke suite.
 */
import { createProjectOrgCache, enforce } from "./auth/enforce.js";
import { toErrorResponse } from "./errors.js";
import { type ApiDeps, type ApiRequest, type ApiResponse, errorBody } from "./http.js";
import { getAgent, listAgentsByNode, mintAgentToken, putAgent } from "./operations/agents.js";
import { appendEvent, getRunState, listEvents } from "./operations/events.js";
import { getJobContract, listJobContracts, putJobContract } from "./operations/jobs.js";
import { getNode, listChildren, listNodes, putNode } from "./operations/nodes.js";
import {
  createPlanUploadUrl,
  getPlanDocument,
  listPrerequisites,
  putPrerequisite,
  ratifyProgram,
} from "./operations/plans.js";
import {
  getProgram,
  getProject,
  getRun,
  listPrograms,
  listProjects,
  listRuns,
  putProgram,
  putProject,
  putRun,
} from "./operations/projects.js";
import {
  getArtifact,
  getCheckpoint,
  getDecision,
  getExamination,
  getVerification,
  listArtifacts,
  listCheckpoints,
  listDecisions,
  listExaminationsByNode,
  listRoutingDecisionsByNode,
  listVerificationsByNode,
  putArtifact,
  putCheckpoint,
  putDecision,
  putExamination,
  putRoutingDecision,
  putVerification,
} from "./operations/records.js";
import { createArtifactUploadUrl } from "./operations/uploads.js";
import { matchRoute, type Route } from "./router.js";

const PROJECT = "/projects/{projectId}";
const PROGRAM = `${PROJECT}/programs/{programId}`;
const RUN = `${PROGRAM}/runs/{runId}`;
const NODE = `${RUN}/nodes/{nodeId}`;

/**
 * The API surface, grouped by aggregate. P10 will read this table, so it is kept
 * readable and nothing is added that the slice does not use (T2).
 */
export const ROUTES: readonly Route[] = [
  // Projects and programs.
  { method: "GET", path: "/projects", operation: "project.list", handler: listProjects },
  { method: "PUT", path: PROJECT, operation: "project.put", handler: putProject },
  { method: "GET", path: PROJECT, operation: "project.get", handler: getProject },
  {
    method: "GET",
    path: `${PROJECT}/programs`,
    operation: "program.list",
    handler: listPrograms,
  },
  { method: "PUT", path: PROGRAM, operation: "program.put", handler: putProgram },
  { method: "GET", path: PROGRAM, operation: "program.get", handler: getProgram },

  // Planning (P7): ratification, the plan document, human prerequisites.
  {
    method: "POST",
    path: `${PROGRAM}/ratifications`,
    operation: "program.ratify",
    handler: ratifyProgram,
  },
  {
    method: "POST",
    path: `${PROGRAM}/plan-documents/{sha256}/upload-url`,
    operation: "program.createPlanUploadUrl",
    handler: createPlanUploadUrl,
  },
  {
    method: "GET",
    path: `${PROGRAM}/plan-documents/{sha256}`,
    operation: "program.getPlanDocument",
    handler: getPlanDocument,
  },
  {
    method: "GET",
    path: `${PROGRAM}/prerequisites`,
    operation: "prerequisite.list",
    handler: listPrerequisites,
  },
  {
    method: "PUT",
    path: `${PROGRAM}/prerequisites/{prerequisiteId}`,
    operation: "prerequisite.put",
    handler: putPrerequisite,
  },

  // Runs. `PUT` on an existing run applies the run table in `core` (T2).
  { method: "GET", path: `${PROGRAM}/runs`, operation: "run.list", handler: listRuns },
  { method: "PUT", path: RUN, operation: "run.put", handler: putRun },
  { method: "GET", path: RUN, operation: "run.get", handler: getRun },
  { method: "GET", path: `${RUN}/state`, operation: "run.getState", handler: getRunState },

  // Execution nodes.
  { method: "GET", path: `${RUN}/nodes`, operation: "node.list", handler: listNodes },
  { method: "PUT", path: NODE, operation: "node.put", handler: putNode },
  { method: "GET", path: NODE, operation: "node.get", handler: getNode },
  {
    method: "GET",
    path: `${NODE}/children`,
    operation: "node.listChildren",
    handler: listChildren,
  },

  // Job Contracts, persisted before execution (A-03).
  { method: "GET", path: `${RUN}/jobs`, operation: "job.list", handler: listJobContracts },
  {
    method: "PUT",
    path: `${RUN}/jobs/{jobContractId}`,
    operation: "job.put",
    handler: putJobContract,
  },
  {
    method: "GET",
    path: `${RUN}/jobs/{jobContractId}`,
    operation: "job.get",
    handler: getJobContract,
  },

  // Agents: the execution identity (A-04). `agent.mintToken` is the one route
  // an execution principal may never call, whatever it targets (D-P4-05).
  { method: "PUT", path: `${RUN}/agents/{agentId}`, operation: "agent.put", handler: putAgent },
  { method: "GET", path: `${RUN}/agents/{agentId}`, operation: "agent.get", handler: getAgent },
  {
    method: "GET",
    path: `${NODE}/agents`,
    operation: "agent.listByNode",
    handler: listAgentsByNode,
  },
  {
    method: "POST",
    path: `${RUN}/agents/{agentId}/token`,
    operation: "agent.mintToken",
    handler: mintAgentToken,
  },

  // Events.
  { method: "POST", path: `${RUN}/events`, operation: "event.append", handler: appendEvent },
  { method: "GET", path: `${RUN}/events`, operation: "event.list", handler: listEvents },

  // Decisions and checkpoints.
  { method: "GET", path: `${RUN}/decisions`, operation: "decision.list", handler: listDecisions },
  {
    method: "PUT",
    path: `${RUN}/decisions/{decisionId}`,
    operation: "decision.put",
    handler: putDecision,
  },
  {
    method: "GET",
    path: `${RUN}/decisions/{decisionId}`,
    operation: "decision.get",
    handler: getDecision,
  },
  {
    method: "GET",
    path: `${RUN}/checkpoints`,
    operation: "checkpoint.list",
    handler: listCheckpoints,
  },
  {
    method: "PUT",
    path: `${RUN}/checkpoints/{checkpointId}`,
    operation: "checkpoint.put",
    handler: putCheckpoint,
  },
  {
    method: "GET",
    path: `${RUN}/checkpoints/{checkpointId}`,
    operation: "checkpoint.get",
    handler: getCheckpoint,
  },

  // Verification: written by the execution layer and by nothing else (D-P3-06).
  {
    method: "PUT",
    path: `${RUN}/verifications/{verificationId}`,
    operation: "verification.put",
    handler: putVerification,
  },
  {
    method: "GET",
    path: `${RUN}/verifications/{verificationId}`,
    operation: "verification.get",
    handler: getVerification,
  },
  {
    method: "GET",
    path: `${NODE}/verifications`,
    operation: "verification.listByNode",
    handler: listVerificationsByNode,
  },

  // Examination: port completeness only; nothing in P3 writes one (D-P3-07).
  {
    method: "PUT",
    path: `${RUN}/examinations/{examinationId}`,
    operation: "examination.put",
    handler: putExamination,
  },
  {
    method: "GET",
    path: `${RUN}/examinations/{examinationId}`,
    operation: "examination.get",
    handler: getExamination,
  },
  {
    method: "GET",
    path: `${NODE}/examinations`,
    operation: "examination.listByNode",
    handler: listExaminationsByNode,
  },

  // Routing.
  {
    method: "PUT",
    path: `${RUN}/routing-decisions/{routingDecisionId}`,
    operation: "routingDecision.put",
    handler: putRoutingDecision,
  },
  {
    method: "GET",
    path: `${NODE}/routing-decisions`,
    operation: "routingDecision.listByNode",
    handler: listRoutingDecisionsByNode,
  },

  // Artifacts. The upload route signs; the client uploads; the record follows (A-08).
  { method: "GET", path: `${RUN}/artifacts`, operation: "artifact.list", handler: listArtifacts },
  {
    method: "PUT",
    path: `${RUN}/artifacts/{artifactId}`,
    operation: "artifact.put",
    handler: putArtifact,
  },
  {
    method: "GET",
    path: `${RUN}/artifacts/{artifactId}`,
    operation: "artifact.get",
    handler: getArtifact,
  },
  {
    method: "POST",
    path: `${RUN}/artifacts/{artifactId}/upload-url`,
    operation: "artifact.createUploadUrl",
    handler: createArtifactUploadUrl,
  },
];

export const handleRequest = async (deps: ApiDeps, request: ApiRequest): Promise<ApiResponse> => {
  const match = matchRoute(ROUTES, request.method.toUpperCase(), request.path);
  if (match.kind === "not_found") {
    return { status: 404, body: errorBody("route_not_found", `no route for ${request.path}`) };
  }
  if (match.kind === "method_not_allowed") {
    return {
      status: 405,
      body: errorBody(
        "method_not_allowed",
        `${request.method} is not allowed here; allowed: ${match.allowed.join(", ")}`,
      ),
    };
  }
  try {
    // The one authorisation gate (SC-P4-08). Every route passes through it, and
    // it runs *before* the operation, so a caller in the wrong organisation is
    // refused without any record being read.
    const principal = await enforce({
      principal: request.principal,
      operation: match.route.operation,
      params: match.params,
      body: request.body,
      memberships: deps.stores.memberships,
      nodes: deps.stores.executionNodes,
      projectOrgs:
        deps.projectOrgs ??
        createProjectOrgCache({ projects: deps.stores.projects, clock: deps.clock }),
    });
    return await match.route.handler({ deps, request, params: match.params, principal });
  } catch (error) {
    return toErrorResponse(error);
  }
};
