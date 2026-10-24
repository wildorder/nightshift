/**
 * A project's secrets (A-62).
 *
 * `PUT` carries a value, sealed under the envelope before it is stored, in the
 * credentials table and nowhere else, and its body is masked in every
 * diagnostic as a provider key's is. `GET` answers names, dates and last four;
 * no route answers more. The plaintext leaves the plane only in a heartbeat
 * answer, to the machine of one of the project's runs.
 */
import {
  lastFourOf,
  type ProjectSecret,
  type ProjectSecretsResponse,
  projectSecretPurpose,
  SecretNameSchema,
  SetProjectSecretBodySchema,
} from "@nightshift/contracts";
import { nowIso } from "@nightshift/core";
import { HttpError, parseBody } from "../http.js";
import { type PathParams, projectIdFrom } from "../params.js";
import type { Handler } from "../router.js";
import { requireProject } from "./common.js";

const nameFrom = (params: PathParams): string => {
  const result = SecretNameSchema.safeParse(params.name);
  if (!result.success) {
    throw new HttpError(
      400,
      "invalid_path",
      "path parameter name must be an environment variable name: letters, digits and _, not starting with a digit",
    );
  }
  return result.data;
};

/** The credentials table is not there: 501, by name, as for an org's keys. */
const unavailable = (error: unknown): never => {
  if (error instanceof Error && error.name === "CredentialsTableUnavailableError") {
    throw new HttpError(501, "credentials_unavailable", error.message);
  }
  throw error;
};

export const putProjectSecret: Handler = async ({ deps, request, params }) => {
  const project = await requireProject(deps.stores, projectIdFrom(params));
  const name = nameFrom(params);
  const body = parseBody(SetProjectSecretBodySchema, request.body);
  if (deps.envelope === undefined) {
    throw new HttpError(
      501,
      "credentials_unavailable",
      "this control plane has no key to seal a secret under; it stores none in the clear",
    );
  }
  const sealed = await deps.envelope.seal(
    project.orgId,
    projectSecretPurpose(project.projectId, name),
    body.value,
  );
  const secret: ProjectSecret = {
    schemaVersion: 1,
    orgId: project.orgId,
    projectId: project.projectId,
    name,
    ciphertext: sealed.ciphertext,
    wrappedKey: sealed.wrappedKey,
    lastFour: lastFourOf(body.value),
    setAt: nowIso(deps.clock),
  };
  await deps.stores.credentials.putSecret(secret).catch(unavailable);
  return { status: 200, body: { name, lastFour: secret.lastFour, setAt: secret.setAt } };
};

export const listProjectSecrets: Handler = async ({ deps, params }) => {
  const project = await requireProject(deps.stores, projectIdFrom(params));
  const items = await deps.stores.credentials.secrets(project.projectId).catch(unavailable);
  const body: ProjectSecretsResponse = { items: [...items] };
  return { status: 200, body };
};

export const deleteProjectSecret: Handler = async ({ deps, params }) => {
  const project = await requireProject(deps.stores, projectIdFrom(params));
  const name = nameFrom(params);
  const deleted = await deps.stores.credentials
    .deleteSecret(project.projectId, name)
    .catch(unavailable);
  if (!deleted) {
    throw new HttpError(404, "not_found", `project ${project.projectId} has no secret ${name}`);
  }
  return { status: 204, body: undefined };
};

/**
 * The project's secrets, opened for one of its runs' machines (A-62). Under
 * the terms of the org's keys: only while the dispatch may run project steps.
 */
export const openProjectSecrets = async (
  deps: Parameters<Handler>[0]["deps"],
  project: {
    readonly orgId: ProjectSecret["orgId"];
    readonly projectId: ProjectSecret["projectId"];
  },
): Promise<Record<string, string>> => {
  if (deps.envelope === undefined) return {};
  let sealed: readonly ProjectSecret[];
  try {
    sealed = await deps.stores.credentials.sealedSecrets(project.projectId);
  } catch (error) {
    if (error instanceof Error && error.name === "CredentialsTableUnavailableError") return {};
    throw error;
  }
  const opened: Record<string, string> = {};
  for (const secret of sealed) {
    opened[secret.name] = await deps.envelope.open(
      project.orgId,
      projectSecretPurpose(project.projectId, secret.name),
      secret,
    );
  }
  return opened;
};
