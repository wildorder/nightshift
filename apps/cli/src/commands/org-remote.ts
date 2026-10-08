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
import { readFile } from "node:fs/promises";
import {
  GitHubAppResponseSchema,
  GitHubInstallationSchema,
  GitHubInstallationsResponseSchema,
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
import { resolveFrom } from "../program-files.js";
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
 * verifies through the App, beside any the org already holds (D-P10-28).
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
    environment.out(
      "An org may record one installation per GitHub account it installs the App on.",
    );
    return 0;
  }
  const installationId = installationIdOf(options.installation);
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

const installationIdOf = (named: string): number => {
  const installationId = Number.parseInt(named, 10);
  if (!Number.isInteger(installationId) || installationId <= 0) {
    throw new UsageError("--installation takes the installation's numeric id");
  }
  return installationId;
};

/** `org github status [--org <id>]`: every installation the org holds, and what each grants. */
export const githubStatus = async (environment: CliEnvironment, org?: string): Promise<number> => {
  const session = await openSession(environment);
  const orgId = await orgOf(session, org);
  const { items } = GitHubInstallationsResponseSchema.parse(
    await send(session.transport, { method: "GET", path: routes.orgGithub(orgId as never) }),
  );
  if (items.length === 0) {
    environment.out("No GitHub installation is recorded for this org.");
    environment.out("Run `nightshift org github install` to see where to install the App.");
    return 1;
  }
  for (const recorded of items) {
    environment.out(
      `Installation ${recorded.installationId} on ${recorded.account}, recorded ${recorded.recordedAt}:`,
    );
    for (const repository of recorded.repositories) environment.out(`  ${repository}`);
  }
  return 0;
};

/**
 * `org github remove --installation <id> [--org <id>]`: the org stops running
 * against that installation's repositories and gives its claim back. The App
 * stays installed at GitHub until the customer uninstalls it there.
 */
export const githubRemove = async (
  environment: CliEnvironment,
  options: { readonly installation?: string; readonly org?: string },
): Promise<number> => {
  if (options.installation === undefined) {
    throw new UsageError("`org github remove` takes --installation <id>");
  }
  const installationId = installationIdOf(options.installation);
  const session = await openSession(environment);
  const orgId = await orgOf(session, options.org);
  try {
    await send(
      session.transport,
      { method: "DELETE", path: routes.orgGithubInstallation(orgId as never, installationId) },
      [204],
    );
  } catch (error) {
    if (!notFound(error)) throw error;
    environment.err(`This org has recorded no installation ${installationId}.`);
    return 1;
  }
  environment.out(
    `Removed installation ${installationId}. Uninstall the App at GitHub as well if Nightshift should lose access.`,
  );
  return 0;
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

/**
 * `org providers set <provider> [--file <path>] [--org <id>]`: the credential
 * goes in through the API, sealed there. `--file` is for a credential that is a
 * file, Codex's `~/.codex/auth.json` (a ChatGPT subscription login) above all:
 * the file's content is the credential, and the machine puts it back where
 * Codex reads it (D-P10-23).
 */
export const providersSet = async (
  environment: CliEnvironment,
  provider: string,
  org?: string,
  file?: string,
): Promise<number> => {
  const session = await openSession(environment);
  const orgId = await orgOf(session, org);
  const named = providerOf(provider);
  const key =
    file === undefined
      ? await readKey(environment, named)
      : (await readFile(resolveFrom(environment.cwd, file), "utf8")).trim();
  if (key.length < 8) throw new UsageError(`${file} holds no credential`);
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
