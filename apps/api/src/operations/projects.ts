/**
 * Projects, programs and runs.
 */
import {
  type OrgId,
  ProgramContractSchema,
  ProjectBodySchema,
  ProjectSchema,
  type Run,
  RunSchema,
} from "@nightshift/contracts";
import {
  explainRunEnding,
  explainRunUpdate,
  IllegalTransitionError,
  OwnershipViolationError,
  runEventFor,
  transitionRun,
} from "@nightshift/core";
import { HttpError, parseBody, sameRecord } from "../http.js";
import {
  assertChainMatches,
  parsePageQuery,
  programScopeFrom,
  projectIdFrom,
  runScopeFrom,
} from "../params.js";
import type { Handler, RouteContext } from "../router.js";
import { createOrConfirm, pageBody, requireProgram, requireProject, withCursor } from "./common.js";

/**
 * The organisation the caller acts for, already resolved by `enforce`.
 *
 * Two operations need the org itself rather than just the check: creation
 * assigns it and listing filters by it. Every other route only needed `enforce`
 * to have allowed the request, which it has by the time any handler runs.
 *
 * An execution principal cannot reach either route — `project.put` and
 * `project.list` are `forbidden` in the §4.4 table — so this is unreachable
 * rather than merely unlikely. It refuses in words anyway, because "unreachable"
 * is a property of a table that someone will edit one day.
 */
const actingOrg = ({ principal }: RouteContext): OrgId => {
  if (principal.kind !== "user") {
    throw new HttpError(
      403,
      "execution_forbidden_operation",
      "an execution token has no organisation to act for",
    );
  }
  return principal.orgId;
};

export const putProject: Handler = async (context) => {
  const body = parseBody(ProjectBodySchema, context.request.body);
  const projectId = projectIdFrom(context.params);
  assertChainMatches({ projectId }, body);

  const orgId = actingOrg(context);
  const project = ProjectSchema.parse({ ...body, orgId });
  const { stores } = context.deps;
  const existing = await stores.projects.get(projectId);
  // A project's org is immutable (the stores refuse it too). `enforce` has
  // already refused a caller from another organisation, before this read; this
  // stays as the store-level guard it always was, and as the answer if the
  // cache above ever disagreed with the record.
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
  const orgId = actingOrg(context);
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

export const listPrograms: Handler = async ({ deps, request, params }) => {
  const projectId = projectIdFrom(params);
  const page = parsePageQuery(request.query);
  await requireProject(deps.stores, projectId);
  const result = await withCursor(() =>
    deps.stores.programContracts.listByProject(projectId, page),
  );
  return { status: 200, body: pageBody(result) };
};

/** An incomplete record is 422: well formed, but not something that can be stored. */
const assertRunComplete = (run: Run): void => {
  const reasons = explainRunEnding(run);
  if (reasons.length > 0) throw new HttpError(422, "incomplete_record", reasons.join("; "));
};

/**
 * `PUT` on an existing run applies the run table in `core` (T2, D-P3-13).
 *
 * P2 left this as create-or-confirm, which was enough for a suite that never
 * moved a run. P3 does: `run.start` moves it to `running`, `run.finish` and
 * shutdown move it to a terminal status.
 */
const applyRunUpdate = (existing: Run, next: Run): void => {
  // The transition first, for the reason `operations/agents.ts` documents: a
  // status regression is an illegal transition, not a dropped timestamp.
  const statusMoved = existing.status !== next.status;
  const event = statusMoved ? runEventFor(existing.status, next.status) : undefined;
  if (statusMoved && event === undefined) {
    throw new IllegalTransitionError(existing.status, `transition to ${next.status}`);
  }

  const immutable = explainRunUpdate(existing, next);
  if (immutable.length > 0) throw new HttpError(409, "conflict", immutable.join("; "));
  assertRunComplete(next);

  if (event === undefined) {
    throw new HttpError(
      409,
      "conflict",
      "a run's status is the only field that changes; this request changes something else",
    );
  }
  // Applied for its refusals: the table, and the rule that no run ends in
  // silence. The submitted record is what gets stored, as with execution nodes.
  transitionRun(existing, event, {
    endedAt: next.endedAt ?? existing.startedAt,
    ...(next.outcomeReason === undefined ? {} : { outcomeReason: next.outcomeReason }),
  });
};

export const putRun: Handler = async ({ deps, request, params }) => {
  const run = parseBody(RunSchema, request.body);
  const scope = runScopeFrom(params);
  assertChainMatches(scope, run);

  await requireProgram(deps.stores, scope);
  const existing = await deps.stores.runs.get(scope, scope.runId);
  if (existing === undefined) {
    assertRunComplete(run);
    await deps.stores.runs.put(run);
    return { status: 201, body: run };
  }
  if (sameRecord(existing, run)) return { status: 200, body: existing };
  applyRunUpdate(existing, run);
  await deps.stores.runs.put(run);
  return { status: 200, body: run };
};

export const getRun: Handler = async ({ deps, params }) => {
  const scope = runScopeFrom(params);
  const run = await deps.stores.runs.get(scope, scope.runId);
  if (run === undefined) throw new HttpError(404, "not_found", `run ${scope.runId} does not exist`);
  return { status: 200, body: run };
};

export const listRuns: Handler = async ({ deps, request, params }) => {
  const scope = programScopeFrom(params);
  const page = parsePageQuery(request.query);
  await requireProgram(deps.stores, scope);
  const result = await withCursor(() => deps.stores.runs.listByProgram(scope, page));
  return { status: 200, body: pageBody(result) };
};
