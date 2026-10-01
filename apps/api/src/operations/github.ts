/**
 * An org's GitHub App installation (P10, D-P10-02).
 *
 * A customer installs the Nightshift App on the repositories Nightshift may
 * touch, then tells Nightshift the installation id. The plane does not take
 * that as proof of anything: it asks GitHub, as the App, what the installation
 * is, and records what GitHub said. Dispatch (T3) refuses a repository that is
 * not in the record.
 */
import {
  defaultOrgConfig,
  type GitHubInstallation,
  type OrgConfig,
  RecordInstallationBodySchema,
} from "@nightshift/contracts";
import type { GitHubAppClient } from "@nightshift/core";
import { nowIso } from "@nightshift/core";
import { type ApiDeps, HttpError, parseBody } from "../http.js";
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
  const installation: GitHubInstallation = {
    installationId: body.installationId,
    account: facts.account,
    repositories: [...facts.repositories],
    recordedAt: at,
  };
  const stored = (await deps.stores.orgConfigs.get(orgId)) ?? defaultOrgConfig(orgId, at);
  const config: OrgConfig = {
    ...stored,
    github: installation,
    version: stored.version + 1,
    updatedAt: at,
  };
  await deps.stores.orgConfigs.put(config);
  return { status: 200, body: installation };
};

export const getOrgGithub: Handler = async ({ deps, params }) => {
  const orgId = orgIdFrom(params);
  const stored = await deps.stores.orgConfigs.get(orgId);
  if (stored?.github === undefined) {
    throw new HttpError(404, "not_found", `org ${orgId} has recorded no GitHub installation`);
  }
  return { status: 200, body: stored.github };
};
