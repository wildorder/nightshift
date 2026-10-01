/**
 * What a run's machine was asked to do, what a project should run on, and
 * what its warm snapshot is (P10, D-P10-14, D-P10-15).
 */
import { chooseTier, recommendFromUse } from "@nightshift/core";
import { HttpError } from "../http.js";
import { programScopeFrom, projectIdFrom, runScopeFrom } from "../params.js";
import type { Handler } from "../router.js";
import { requireProgram } from "./common.js";

export const getComputeUtilization: Handler = async ({ deps, params }) => {
  const scope = runScopeFrom(params);
  const utilization = await deps.stores.computeUtilizations.get(scope);
  if (utilization === undefined) {
    throw new HttpError(404, "not_found", `run ${scope.runId} has no utilization record`);
  }
  return { status: 200, body: utilization };
};

/** How many of a project's newest records the rule is offered. It reads the three on the tier. */
const RECORDS_CONSIDERED = 50;

/**
 * `GET …/programs/{programId}/compute/recommendation` (D-P10-14b): the tier the
 * project's last three runs say, against the tier the program would run on.
 * Nothing here changes a tier.
 */
export const getComputeRecommendation: Handler = async ({ deps, params }) => {
  const scope = programScopeFrom(params);
  const program = await requireProgram(deps.stores, scope);
  const current = chooseTier(undefined, program.compute, undefined);
  const page = await deps.stores.computeUtilizations.listByProject(scope.projectId, {
    limit: RECORDS_CONSIDERED,
  });
  const result = recommendFromUse(page.items, current.tier);
  return { status: 200, body: { current: current.tier, source: current.source, ...result } };
};

export const getWarmCache: Handler = async ({ deps, params }) => {
  const projectId = projectIdFrom(params);
  const cache = await deps.stores.warmCaches.get(projectId, "arm64");
  if (cache === undefined) {
    throw new HttpError(404, "not_found", `project ${projectId} has no warm snapshot yet`);
  }
  return { status: 200, body: cache };
};
