/**
 * `nightshift secret set|list|rm` (A-62): a project's secrets.
 *
 * A value goes in through the API, sealed there, and is read from a prompt or
 * a pipe, never an argument, so it is in no shell history and no process list.
 * Nothing reads a value back: `list` answers names, dates and last four.
 *
 * The project is the one `--project` names, or the one `nightshift.config.json`
 * in the repository names. Setting a secret is half of it: the config's
 * `secrets` lists the names a run gives every step and agent.
 */
import {
  type NightshiftConfig,
  type ProjectId,
  ProjectIdSchema,
  ProjectSecretsResponseSchema,
  ProjectSecretViewSchema,
  SecretNameSchema,
} from "@nightshift/contracts";
import { routes, send } from "@nightshift/persistence/http";
import type { CliEnvironment } from "../environment.js";
import { UsageError } from "../failures.js";
import { readConfig, resolveFrom } from "../program-files.js";
import { openSession, type Session } from "../session.js";

export interface SecretOptions {
  readonly project?: string;
  readonly repo?: string;
}

const projectOf = async (
  environment: CliEnvironment,
  options: SecretOptions,
): Promise<{ projectId: ProjectId; config: NightshiftConfig | undefined }> => {
  const config = await readConfig(
    resolveFrom(environment.cwd, options.repo ?? environment.cwd),
  ).catch(() => undefined);
  const named = options.project ?? config?.projectId;
  if (named === undefined) {
    throw new UsageError(
      "no project: pass --project <id>, or run this in a repository with a nightshift.config.json",
    );
  }
  const parsed = ProjectIdSchema.safeParse(named);
  if (!parsed.success) throw new UsageError(`\`${named}\` is not a project id`);
  return { projectId: parsed.data, config };
};

const nameOf = (named: string): string => {
  const parsed = SecretNameSchema.safeParse(named);
  if (!parsed.success) {
    throw new UsageError(
      `\`${named}\` cannot be a secret's name: ${parsed.error.issues[0]?.message ?? "invalid"}`,
    );
  }
  return parsed.data;
};

/** A value, from a prompt or the pipe: never from an argument, never echoed. */
const readValue = async (environment: CliEnvironment, name: string): Promise<string> => {
  environment.err(`Paste the value of ${name} and press Enter (it is not echoed back):`);
  const paste = environment.readPaste();
  const line = await paste.line;
  paste.cancel();
  const value = line?.trim() ?? "";
  if (value === "") throw new UsageError("no value was read; pipe it in or paste it at the prompt");
  return value;
};

export const secretSet = async (
  environment: CliEnvironment,
  named: string,
  options: SecretOptions,
): Promise<number> => {
  const name = nameOf(named);
  const { projectId, config } = await projectOf(environment, options);
  const value = await readValue(environment, name);
  const session = await openSession(environment);
  const view = ProjectSecretViewSchema.parse(
    await send(session.transport, {
      method: "PUT",
      path: routes.projectSecret(projectId, name),
      body: { value },
    }),
  );
  environment.out(
    `${view.name} is set for ${projectId}, ending …${view.lastFour} (${view.setAt}).`,
  );
  if (config !== undefined && !(config.secrets ?? []).includes(name)) {
    environment.out(
      `note: nightshift.config.json does not list ${name} in "secrets", so no run is given it yet.`,
    );
  }
  return 0;
};

export const listedSecrets = async (session: Session, projectId: ProjectId) =>
  ProjectSecretsResponseSchema.parse(
    await send(session.transport, { method: "GET", path: routes.projectSecrets(projectId) }),
  ).items;

export const secretList = async (
  environment: CliEnvironment,
  options: SecretOptions,
): Promise<number> => {
  const { projectId, config } = await projectOf(environment, options);
  const session = await openSession(environment);
  const items = await listedSecrets(session, projectId);
  const declared = config?.secrets ?? [];
  const names = [...new Set([...declared, ...items.map((item) => item.name)])].sort();
  if (names.length === 0) {
    environment.out(`${projectId} has no secrets, and nightshift.config.json declares none.`);
    return 0;
  }
  for (const name of names) {
    const view = items.find((item) => item.name === name);
    const listed = declared.includes(name) ? "declared" : "not declared in nightshift.config.json";
    environment.out(
      view === undefined
        ? `${name}: NOT SET (${listed}); \`nightshift secret set ${name}\``
        : `${name}: set, ending …${view.lastFour}, ${view.setAt} (${listed})`,
    );
  }
  return declared.every((name) => items.some((item) => item.name === name)) ? 0 : 1;
};

export const secretRemove = async (
  environment: CliEnvironment,
  named: string,
  options: SecretOptions,
): Promise<number> => {
  const name = nameOf(named);
  const { projectId } = await projectOf(environment, options);
  const session = await openSession(environment);
  await send(
    session.transport,
    { method: "DELETE", path: routes.projectSecret(projectId, name) },
    [204],
  );
  environment.out(`${name} is removed from ${projectId}.`);
  return 0;
};
