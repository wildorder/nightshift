/**
 * The control-plane API (T4): a pure function from request to response.
 *
 * There is no authentication here, by design. API Gateway's Cognito JWT
 * authorizer rejects a missing or bad token before this code runs (A-19), and a
 * second check here would be a second place for isolation to live. Project
 * isolation is enforced here, by taking the ownership chain from the path
 * (A-23).
 *
 * The route table grew in P3 (D-P3-13) to cover every port method the local
 * machinery uses, plus a presigned artifact upload. Anything not listed is
 * surface area the smoke suite would have to cover, so it is not added
 * speculatively — and every route here is exercised by the smoke suite.
 */
import { toErrorResponse } from "./errors.js";
import { type ApiDeps, type ApiRequest, type ApiResponse, errorBody } from "./http.js";
import { getAgent, listAgentsByNode, mintAgentToken, putAgent } from "./operations/agents.js";
import { appendEvent, getRunState, listEvents } from "./operations/events.js";
import { getJobContract, listJobContracts, putJobContract } from "./operations/jobs.js";
import { getNode, listChildren, listNodes, putNode } from "./operations/nodes.js";
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
  { method: "GET", path: "/projects", handler: listProjects },
  { method: "PUT", path: PROJECT, handler: putProject },
  { method: "GET", path: PROJECT, handler: getProject },
  { method: "GET", path: `${PROJECT}/programs`, handler: listPrograms },
  { method: "PUT", path: PROGRAM, handler: putProgram },
  { method: "GET", path: PROGRAM, handler: getProgram },

  // Runs. `PUT` on an existing run applies the run table in `core` (T2).
  { method: "GET", path: `${PROGRAM}/runs`, handler: listRuns },
  { method: "PUT", path: RUN, handler: putRun },
  { method: "GET", path: RUN, handler: getRun },
  { method: "GET", path: `${RUN}/state`, handler: getRunState },

  // Execution nodes.
  { method: "GET", path: `${RUN}/nodes`, handler: listNodes },
  { method: "PUT", path: NODE, handler: putNode },
  { method: "GET", path: NODE, handler: getNode },
  { method: "GET", path: `${NODE}/children`, handler: listChildren },

  // Job Contracts, persisted before execution (A-03).
  { method: "GET", path: `${RUN}/jobs`, handler: listJobContracts },
  { method: "PUT", path: `${RUN}/jobs/{jobContractId}`, handler: putJobContract },
  { method: "GET", path: `${RUN}/jobs/{jobContractId}`, handler: getJobContract },

  // Agents: the execution identity (A-04).
  { method: "PUT", path: `${RUN}/agents/{agentId}`, handler: putAgent },
  { method: "GET", path: `${RUN}/agents/{agentId}`, handler: getAgent },
  { method: "GET", path: `${NODE}/agents`, handler: listAgentsByNode },
  // The execution identity's own credential (D-P4-03). User principals only,
  // and never stored: the response is the one place a token appears.
  { method: "POST", path: `${RUN}/agents/{agentId}/token`, handler: mintAgentToken },

  // Events.
  { method: "POST", path: `${RUN}/events`, handler: appendEvent },
  { method: "GET", path: `${RUN}/events`, handler: listEvents },

  // Decisions and checkpoints.
  { method: "GET", path: `${RUN}/decisions`, handler: listDecisions },
  { method: "PUT", path: `${RUN}/decisions/{decisionId}`, handler: putDecision },
  { method: "GET", path: `${RUN}/decisions/{decisionId}`, handler: getDecision },
  { method: "GET", path: `${RUN}/checkpoints`, handler: listCheckpoints },
  { method: "PUT", path: `${RUN}/checkpoints/{checkpointId}`, handler: putCheckpoint },
  { method: "GET", path: `${RUN}/checkpoints/{checkpointId}`, handler: getCheckpoint },

  // Verification: written by the execution layer and by nothing else (D-P3-06).
  { method: "PUT", path: `${RUN}/verifications/{verificationId}`, handler: putVerification },
  { method: "GET", path: `${RUN}/verifications/{verificationId}`, handler: getVerification },
  { method: "GET", path: `${NODE}/verifications`, handler: listVerificationsByNode },

  // Examination: port completeness only; nothing in P3 writes one (D-P3-07).
  { method: "PUT", path: `${RUN}/examinations/{examinationId}`, handler: putExamination },
  { method: "GET", path: `${RUN}/examinations/{examinationId}`, handler: getExamination },
  { method: "GET", path: `${NODE}/examinations`, handler: listExaminationsByNode },

  // Routing.
  {
    method: "PUT",
    path: `${RUN}/routing-decisions/{routingDecisionId}`,
    handler: putRoutingDecision,
  },
  { method: "GET", path: `${NODE}/routing-decisions`, handler: listRoutingDecisionsByNode },

  // Artifacts. The upload route signs; the client uploads; the record follows (A-08).
  { method: "GET", path: `${RUN}/artifacts`, handler: listArtifacts },
  { method: "PUT", path: `${RUN}/artifacts/{artifactId}`, handler: putArtifact },
  { method: "GET", path: `${RUN}/artifacts/{artifactId}`, handler: getArtifact },
  {
    method: "POST",
    path: `${RUN}/artifacts/{artifactId}/upload-url`,
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
    return await match.route.handler({ deps, request, params: match.params });
  } catch (error) {
    return toErrorResponse(error);
  }
};
