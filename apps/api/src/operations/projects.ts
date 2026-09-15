/**
 * Projects, programs and runs.
 */
import {
  type OrgId,
  ProgramContractSchema,
  ProjectBodySchema,
  ProjectSchema,
  RunSchema,
} from "@nightshift/contracts";
import { OwnershipViolationError } from "@nightshift/core";
import { describeRefusal, resolveActingOrg } from "../auth/acting-org.js";
import { HttpError, parseBody } from "../http.js";
import {
  assertChainMatches,
  parsePageQuery,
  programScopeFrom,
  projectIdFrom,
  runScopeFrom,
} from "../params.js";
import type { Handler, RouteContext } from "../router.js";
import { createOrConfirm, pageBody, requireProgram, requireProject, withCursor } from "./common.js";

/** Only the two project operations resolve an org. See `auth/acting-org.ts` for why. */
const actingOrg = async ({ deps, request }: RouteContext): Promise<OrgId> => {
  const resolution = await resolveActingOrg(request.claims, deps.stores.memberships);
  if (!resolution.ok) {
    throw new HttpError(403, resolution.reason, describeRefusal(resolution.reason));
  }
  return resolution.orgId;
};

export const putProject: Handler = async (context) => {
  const body = parseBody(ProjectBodySchema, context.request.body);
  const projectId = projectIdFrom(context.params);
  assertChainMatches({ projectId }, body);

  const orgId = await actingOrg(context);
  const project = ProjectSchema.parse({ ...body, orgId });
  const { stores } = context.deps;
  const existing = await stores.projects.get(projectId);
  // A project's org is immutable (the stores refuse it too). Checked before the
  // retry comparison so the answer is 403, not a generic conflict.
  if (existing !== undefined && existing.orgId !== orgId) {
    throw new OwnershipViolationError("orgId", existing.orgId, orgId);
  }
  return createOrConfirm(existing, project, () => stores.projects.put(project));
};

export const getProject: Handler = async ({ deps, params }) => ({
  status: 200,
  body: await requireProject(deps.stores, projectIdFrom(params)),
});

export const listProjects: Handler = async (context) => {
  const page = parsePageQuery(context.request.query);
  const orgId = await actingOrg(context);
  const result = await withCursor(() => context.deps.stores.projects.listByOrg(orgId, page));
  return { status: 200, body: pageBody(result) };
};

export const putProgram: Handler = async ({ deps, request, params }) => {
  const program = parseBody(ProgramContractSchema, request.body);
  const scope = programScopeFrom(params);
  assertChainMatches(scope, program);

  await requireProject(deps.stores, scope.projectId);
  const existing = await deps.stores.programContracts.get(scope.projectId, scope.programId);
  return createOrConfirm(existing, program, () => deps.stores.programContracts.put(program));
};

export const getProgram: Handler = async ({ deps, params }) => ({
  status: 200,
  body: await requireProgram(deps.stores, programScopeFrom(params)),
});

export const putRun: Handler = async ({ deps, request, params }) => {
  const run = parseBody(RunSchema, request.body);
  const scope = runScopeFrom(params);
  assertChainMatches(scope, run);

  await requireProgram(deps.stores, scope);
  const existing = await deps.stores.runs.get(scope, scope.runId);
  return createOrConfirm(existing, run, () => deps.stores.runs.put(run));
};

export const getRun: Handler = async ({ deps, params }) => {
  const scope = runScopeFrom(params);
  const run = await deps.stores.runs.get(scope, scope.runId);
  if (run === undefined) throw new HttpError(404, "not_found", `run ${scope.runId} does not exist`);
  return { status: 200, body: run };
};
