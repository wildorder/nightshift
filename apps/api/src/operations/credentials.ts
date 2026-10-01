/**
 * An org's provider keys (P10, D-P10-23).
 *
 * `PUT` is the one request in the whole API that carries a key. It is sealed
 * under the envelope before it is stored, in the credentials table and nowhere
 * else, and the handler masks this route's body in every diagnostic. `GET`
 * answers presence, date and last four, and no route answers more: the
 * plaintext leaves the plane only inside a heartbeat response, to the run's own
 * engine.
 */
import {
  lastFourOf,
  type OrgCredential,
  type OrgCredentialsResponse,
  type OrgId,
  OrgIdSchema,
  type Provider,
  ProviderSchema,
  SetOrgCredentialBodySchema,
} from "@nightshift/contracts";
import { nowIso } from "@nightshift/core";
import { HttpError, parseBody } from "../http.js";
import type { PathParams } from "../params.js";
import type { Handler } from "../router.js";

export const orgIdFrom = (params: PathParams): OrgId => {
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

const providerFrom = (params: PathParams): Provider => {
  const result = ProviderSchema.safeParse(params.provider);
  if (!result.success) {
    throw new HttpError(
      400,
      "invalid_path",
      `path parameter provider must be one of ${ProviderSchema.options.join(", ")}`,
    );
  }
  return result.data;
};

/** The credentials table is not there (T2 deploys it): 501, by name. */
const unavailable = (error: unknown): never => {
  if (error instanceof Error && error.name === "CredentialsTableUnavailableError") {
    throw new HttpError(501, "credentials_unavailable", error.message);
  }
  throw error;
};

export const putOrgCredential: Handler = async ({ deps, request, params }) => {
  const orgId = orgIdFrom(params);
  const provider = providerFrom(params);
  const body = parseBody(SetOrgCredentialBodySchema, request.body);
  if (deps.envelope === undefined) {
    throw new HttpError(
      501,
      "credentials_unavailable",
      "this control plane has no key to seal a credential under; it stores none in the clear",
    );
  }
  const sealed = await deps.envelope.seal(orgId, provider, body.key);
  const credential: OrgCredential = {
    schemaVersion: 1,
    orgId,
    provider,
    ciphertext: sealed.ciphertext,
    wrappedKey: sealed.wrappedKey,
    lastFour: lastFourOf(body.key),
    setAt: nowIso(deps.clock),
  };
  await deps.stores.credentials.put(credential).catch(unavailable);
  return {
    status: 200,
    body: { provider, lastFour: credential.lastFour, setAt: credential.setAt },
  };
};

export const listOrgCredentials: Handler = async ({ deps, params }) => {
  const orgId = orgIdFrom(params);
  const items = await deps.stores.credentials.view(orgId).catch(unavailable);
  const body: OrgCredentialsResponse = { items: [...items] };
  return { status: 200, body };
};
