/**
 * The control-plane API (T4): a pure function from request to response.
 *
 * There is no authentication here, by design. API Gateway's Cognito JWT
 * authorizer rejects a missing or bad token before this code runs (A-19), and a
 * second check here would be a second place for isolation to live. Project
 * isolation is enforced here, by taking the ownership chain from the path
 * (A-23).
 *
 * The route table is exactly the operation list in the P2 contract §5, plus
 * listing an org's projects (T2). Anything not listed is surface area the smoke
 * suite would have to cover, so it is not added speculatively.
 */
import { toErrorResponse } from "./errors.js";
import { type ApiDeps, type ApiRequest, type ApiResponse, errorBody } from "./http.js";
import { appendEvent, getRunState, listEvents } from "./operations/events.js";
import { getNode, putNode } from "./operations/nodes.js";
import {
  getProgram,
  getProject,
  getRun,
  listProjects,
  putProgram,
  putProject,
  putRun,
} from "./operations/projects.js";
import {
  putArtifact,
  putCheckpoint,
  putDecision,
  putRoutingDecision,
  putVerification,
} from "./operations/records.js";
import { matchRoute, type Route } from "./router.js";

const PROJECT = "/projects/{projectId}";
const PROGRAM = `${PROJECT}/programs/{programId}`;
const RUN = `${PROGRAM}/runs/{runId}`;

export const ROUTES: readonly Route[] = [
  { method: "GET", path: "/projects", handler: listProjects },
  { method: "PUT", path: PROJECT, handler: putProject },
  { method: "GET", path: PROJECT, handler: getProject },
  { method: "PUT", path: PROGRAM, handler: putProgram },
  { method: "GET", path: PROGRAM, handler: getProgram },
  { method: "PUT", path: RUN, handler: putRun },
  { method: "GET", path: RUN, handler: getRun },
  { method: "GET", path: `${RUN}/state`, handler: getRunState },
  { method: "PUT", path: `${RUN}/nodes/{nodeId}`, handler: putNode },
  { method: "GET", path: `${RUN}/nodes/{nodeId}`, handler: getNode },
  { method: "POST", path: `${RUN}/events`, handler: appendEvent },
  { method: "GET", path: `${RUN}/events`, handler: listEvents },
  { method: "PUT", path: `${RUN}/decisions/{decisionId}`, handler: putDecision },
  { method: "PUT", path: `${RUN}/checkpoints/{checkpointId}`, handler: putCheckpoint },
  { method: "PUT", path: `${RUN}/verifications/{verificationId}`, handler: putVerification },
  {
    method: "PUT",
    path: `${RUN}/routing-decisions/{routingDecisionId}`,
    handler: putRoutingDecision,
  },
  { method: "PUT", path: `${RUN}/artifacts/{artifactId}`, handler: putArtifact },
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
