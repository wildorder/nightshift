/**
 * `nightshift org github install | status` and `nightshift org providers set |
 * status` (P10, D-P10-02, D-P10-23).
 *
 * The customer's door for the two things only they can bring to a remote run:
 * the GitHub App installed on the repositories Nightshift may touch, and the
 * provider keys the workers run on. Both go in through the authenticated API
 * and nowhere else; the CLI never touches AWS, a key is read from standard
 * input or a prompt and never from an argument, and nothing it prints is more
 * than presence, date and last four.
 */
import {
  GitHubAppResponseSchema,
  GitHubInstallationSchema,
  OrgCredentialsResponseSchema,
  OrgCredentialViewSchema,
  OrgIdSchema,
  ProjectSchema,
  type Provider,
  ProviderSchema,
} from "@nightshift/contracts";
import { ControlPlaneError, routes, send } from "@nightshift/persistence/http";
import type { CliEnvironment } from "../environment.js";
import { UsageError } from "../failures.js";
import { openSession, type Session } from "../session.js";

/**
 * The org to act on: the one named, else the org that owns the projects this
 * caller can see (the acting org, D-P2-13). An org with no project yet is named.
 */
export const orgOf = async (session: Session, named: string | undefined): Promise<string> => {
  if (named !== undefined) {
    const parsed = OrgIdSchema.safeParse(named);
    if (!parsed.success) throw new UsageError(`\`${named}\` is not an org id`);
    return parsed.data;
  }
  const page = (await send(session.transport, { method: "GET", path: routes.projects() })) as {
    items?: unknown[];
  };
  const first = page.items?.[0];
  if (first === undefined) {
    throw new UsageError("this org has no project yet, so name it: --org <org_…>");
  }
  return ProjectSchema.parse(first).orgId;
};

const notFound = (error: unknown): boolean =>
  error instanceof ControlPlaneError && error.status === 404;

/**
 * `org github install [--installation <id>] [--org <id>]`: with no id, prints
 * where to install the App; with one, records the installation the plane
 * verifies through the App.
 */
export const githubInstall = async (
  environment: CliEnvironment,
  options: { readonly installation?: string; readonly org?: string },
): Promise<number> => {
  const session = await openSession(environment);
  const orgId = await orgOf(session, options.org);
  if (options.installation === undefined) {
    const app = GitHubAppResponseSchema.parse(
      await send(session.transport, { method: "GET", path: routes.githubApp() }),
    );
    environment.out(`Install the ${app.slug} GitHub App on the repositories Nightshift may touch:`);
    environment.out(`  ${app.installUrl}`);
    environment.out('Choose "Only select repositories". Then record the installation here:');
    environment.out("  nightshift org github install --installation <id>");
    environment.out("The id is the number at the end of the installation's settings URL.");
    return 0;
  }
  const installationId = Number.parseInt(options.installation, 10);
  if (!Number.isInteger(installationId) || installationId <= 0) {
    throw new UsageError("--installation takes the installation's numeric id");
  }
  const recorded = GitHubInstallationSchema.parse(
    await send(session.transport, {
      method: "PUT",
      path: routes.orgGithub(orgId as never),
      body: { installationId },
    }),
  );
  environment.out(
    `Recorded installation ${recorded.installationId} on ${recorded.account}: ${recorded.repositories.length} repositor${recorded.repositories.length === 1 ? "y" : "ies"}.`,
  );
  for (const repository of recorded.repositories) environment.out(`  ${repository}`);
  return 0;
};

export const githubStatus = async (environment: CliEnvironment, org?: string): Promise<number> => {
  const session = await openSession(environment);
  const orgId = await orgOf(session, org);
  try {
    const recorded = GitHubInstallationSchema.parse(
      await send(session.transport, { method: "GET", path: routes.orgGithub(orgId as never) }),
    );
    environment.out(
      `Installation ${recorded.installationId} on ${recorded.account}, recorded ${recorded.recordedAt}:`,
    );
    for (const repository of recorded.repositories) environment.out(`  ${repository}`);
    return 0;
  } catch (error) {
    if (!notFound(error)) throw error;
    environment.out("No GitHub installation is recorded for this org.");
    environment.out("Run `nightshift org github install` to see where to install the App.");
    return 1;
  }
};

/** A key, from a prompt or the pipe: never from an argument, never echoed. */
const readKey = async (environment: CliEnvironment, provider: Provider): Promise<string> => {
  environment.err(
    `Paste the ${provider} API key (or, for anthropic, a Claude Code subscription token from "claude setup-token") and press Enter (it is not echoed back):`,
  );
  const paste = environment.readPaste();
  const line = await paste.line;
  paste.cancel();
  const key = line?.trim() ?? "";
  if (key.length < 8) throw new UsageError("no key was read; pipe it in or paste it at the prompt");
  return key;
};

const providerOf = (named: string): Provider => {
  const parsed = ProviderSchema.safeParse(named);
  if (!parsed.success) {
    throw new UsageError(`provider must be one of ${ProviderSchema.options.join(", ")}`);
  }
  return parsed.data;
};

/** `org providers set <provider> [--org <id>]`: the key goes in through the API, sealed there. */
export const providersSet = async (
  environment: CliEnvironment,
  provider: string,
  org?: string,
): Promise<number> => {
  const session = await openSession(environment);
  const orgId = await orgOf(session, org);
  const named = providerOf(provider);
  const key = await readKey(environment, named);
  const view = OrgCredentialViewSchema.parse(
    await send(session.transport, {
      method: "PUT",
      path: routes.orgCredential(orgId as never, named),
      body: { key },
    }),
  );
  environment.out(`The ${view.provider} key ending …${view.lastFour} is set (${view.setAt}).`);
  return 0;
};

export const providersStatus = async (
  environment: CliEnvironment,
  org?: string,
): Promise<number> => {
  const session = await openSession(environment);
  const orgId = await orgOf(session, org);
  const { items } = OrgCredentialsResponseSchema.parse(
    await send(session.transport, { method: "GET", path: routes.orgCredentials(orgId as never) }),
  );
  for (const provider of ProviderSchema.options) {
    const view = items.find((item) => item.provider === provider);
    environment.out(
      view === undefined
        ? `${provider}: not set`
        : `${provider}: set, ending …${view.lastFour}, ${view.setAt}`,
    );
  }
  return items.length === ProviderSchema.options.length ? 0 : 1;
};
