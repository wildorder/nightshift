/**
 * An organisation's routing and examination policy (P8, D-P8-02).
 *
 * `GET` answers the stored configuration, or the seeded default at version 0
 * when nobody has written one, so a caller always sees what a run would get.
 * `PUT` takes the policy and the version the writer read; the store refuses the
 * write unless the stored config is still at that version, so two people editing
 * at once cannot silently overwrite each other.
 *
 * `enforce` has already held the path's org to the caller's acting org, and no
 * execution token may reach either route.
 */
import {
  defaultOrgConfig,
  type OrgConfig,
  OrgConfigBodySchema,
  type OrgId,
  OrgIdSchema,
} from "@nightshift/contracts";
import { nowIso } from "@nightshift/core";
import { HttpError, parseBody } from "../http.js";
import type { PathParams } from "../params.js";
import type { Handler } from "../router.js";

const orgIdFrom = (params: PathParams): OrgId => {
  const result = OrgIdSchema.safeParse(params.orgId);
  if (!result.success) {
    throw new HttpError(
      400,
      "invalid_path",
      "path parameter orgId is not a valid org_ identifier",
      result.error.issues,
    );
  }
  return result.data;
};

export const getOrgConfig: Handler = async ({ deps, params }) => {
  const orgId = orgIdFrom(params);
  const stored = await deps.stores.orgConfigs.get(orgId);
  return { status: 200, body: stored ?? defaultOrgConfig(orgId, nowIso(deps.clock)) };
};

export const putOrgConfig: Handler = async ({ deps, request, params }) => {
  const orgId = orgIdFrom(params);
  const body = parseBody(OrgConfigBodySchema, request.body);
  // P10: the GitHub installations are recorded by their own route (D-P10-02,
  // D-P10-28) and survive a policy write; the compute ceilings are the writer's to set.
  const stored = await deps.stores.orgConfigs.get(orgId);
  const config: OrgConfig = {
    schemaVersion: 1,
    orgId,
    routingPolicy: body.routingPolicy,
    examinationPolicy: body.examinationPolicy,
    ...(body.compute === undefined ? {} : { compute: body.compute }),
    installations: stored?.installations ?? [],
    version: body.replacesVersion + 1,
    updatedAt: nowIso(deps.clock),
  };
  // A `StaleWriteError` from the store is a 409 naming both versions.
  await deps.stores.orgConfigs.put(config);
  return { status: 200, body: config };
};
