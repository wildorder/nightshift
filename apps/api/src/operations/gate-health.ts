/**
 * A project's gate-health record (P15, D-P15-07).
 *
 * One per project, written whole: `nightshift gates {id} --record` puts it under
 * the operator's session, and a run's engine puts it when a gate-health strand
 * or a repair lands. `plan check` reads it. Who may do which is `authorize`'s;
 * an agent's token may do neither.
 *
 * `auditedBy` is the caller, whatever the body says: the record promises to
 * name who recorded it, and only the token can say that.
 */
import { GateHealthSchema } from "@nightshift/contracts";
import { HttpError, parseBody } from "../http.js";
import { assertChainMatches, projectIdFrom } from "../params.js";
import type { Handler } from "../router.js";
import { requireProject } from "./common.js";

export const getGateHealth: Handler = async ({ deps, params }) => {
  const projectId = projectIdFrom(params);
  const record = await deps.stores.gateHealth.get(projectId);
  if (record === undefined) {
    throw new HttpError(404, "not_found", `project ${projectId} has no gate-health record yet`);
  }
  return { status: 200, body: record };
};

/** Replaces the project's record. 201 when it is the first, 200 when it replaced one. */
export const putGateHealth: Handler = async ({ deps, request, params, principal }) => {
  const record = { ...parseBody(GateHealthSchema, request.body), auditedBy: principal };
  const projectId = projectIdFrom(params);
  assertChainMatches({ projectId }, record);
  await requireProject(deps.stores, projectId);
  const existing = await deps.stores.gateHealth.get(projectId);
  await deps.stores.gateHealth.put(record);
  return { status: existing === undefined ? 201 : 200, body: record };
};
