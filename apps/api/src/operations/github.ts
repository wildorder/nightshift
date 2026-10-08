/**
 * An org's GitHub App installation (P10, D-P10-02).
 *
 * A customer installs the Nightshift App on the repositories Nightshift may
 * touch, then tells Nightshift the installation id. The plane does not take
 * that as proof of anything: it asks GitHub, as the App, what the installation
 * is, and records what GitHub said. Dispatch (T3) refuses a repository that is
 * not in the record.
 *
 * An org holds a set of installations (D-P10-28), one per GitHub account it
 * installed the App on: recording one adds it, or refreshes the one already
 * recorded under that id; removing one hands its claim back.
 */
import {
  defaultOrgConfig,
  type GitHubInstallation,
  type GitHubInstallationsResponse,
  type OrgConfig,
  RecordInstallationBodySchema,
} from "@nightshift/contracts";
import type { GitHubAppClient } from "@nightshift/core";
import { nowIso } from "@nightshift/core";
import { type ApiDeps, HttpError, parseBody } from "../http.js";
import type { PathParams } from "../params.js";
import type { Handler } from "../router.js";
import { orgIdFrom } from "./credentials.js";

const githubOf = (deps: ApiDeps): GitHubAppClient => {
  if (deps.github === undefined) {
    throw new HttpError(
      501,
      "github_unavailable",
      "this control plane was wired without the Nightshift GitHub App",
    );
  }
  return deps.github;
};

export const getGithubApp: Handler = async ({ deps }) => ({
  status: 200,
  body: await githubOf(deps).app(),
});

export const putOrgGithub: Handler = async ({ deps, request, params }) => {
  const orgId = orgIdFrom(params);
  const body = parseBody(RecordInstallationBodySchema, request.body);
  const facts = await githubOf(deps).installation(body.installationId);
  if (facts === undefined) {
    throw new HttpError(
      404,
      "installation_unknown",
      `GitHub knows no installation ${body.installationId} of the Nightshift App`,
    );
  }
  const at = nowIso(deps.clock);
  // One installation is one customer's (D-P10-02): the first org to record it
  // holds it, and may record it again; a second org is refused.
  const claimed = await deps.stores.installationClaims.claim(body.installationId, orgId, at);
  if (!claimed.ok) {
    throw new HttpError(
      409,
      "installation_claimed",
      `installation ${body.installationId} is recorded by another org; an installation belongs to one customer`,
    );
  }
  const installation: GitHubInstallation = {
    installationId: body.installationId,
    account: facts.account,
    repositories: [...facts.repositories],
    recordedAt: at,
  };
  const stored = (await deps.stores.orgConfigs.get(orgId)) ?? defaultOrgConfig(orgId, at);
  const config: OrgConfig = {
    ...stored,
    installations: [
      ...stored.installations.filter((held) => held.installationId !== body.installationId),
      installation,
    ],
    version: stored.version + 1,
    updatedAt: at,
  };
  await deps.stores.orgConfigs.put(config);
  return { status: 200, body: installation };
};

const installationIdFrom = (params: PathParams): number => {
  const parsed = Number.parseInt(params.installationId ?? "", 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || String(parsed) !== params.installationId) {
    throw new HttpError(
      400,
      "invalid_path",
      "path parameter installationId is not a positive integer",
    );
  }
  return parsed;
};

/**
 * `DELETE /orgs/{orgId}/github/{installationId}`: the org no longer runs
 * against that account's repositories. The claim goes back, so another org
 * may record the installation. Uninstalling at GitHub is the customer's own
 * act, which this does not perform.
 */
export const deleteOrgGithub: Handler = async ({ deps, params }) => {
  const orgId = orgIdFrom(params);
  const installationId = installationIdFrom(params);
  const stored = await deps.stores.orgConfigs.get(orgId);
  const held = stored?.installations.find((entry) => entry.installationId === installationId);
  if (stored === undefined || held === undefined) {
    throw new HttpError(
      404,
      "not_found",
      `org ${orgId} has recorded no GitHub installation ${installationId}`,
    );
  }
  const config: OrgConfig = {
    ...stored,
    installations: stored.installations.filter((entry) => entry !== held),
    version: stored.version + 1,
    updatedAt: nowIso(deps.clock),
  };
  await deps.stores.orgConfigs.put(config);
  await deps.stores.installationClaims.release(installationId, orgId);
  return { status: 204, body: undefined };
};

export const getOrgGithub: Handler = async ({ deps, params }) => {
  const orgId = orgIdFrom(params);
  const stored = await deps.stores.orgConfigs.get(orgId);
  const body: GitHubInstallationsResponse = { items: stored?.installations ?? [] };
  return { status: 200, body };
};
