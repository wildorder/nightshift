/**
 * The headless root on the machine (P10, T4, D-P10-20, D-P10-22).
 *
 * After `ready`, the runner starts the root orchestrator exactly as
 * `nightshift run` does on a laptop: `runHeadless` over a runtime whose
 * control-plane transport holds the engine's token. The token is renewed by
 * the heartbeat, so it is kept in a file on tmpfs readable by `engine` alone,
 * and every process the root launches reads it from there on each request
 * (`NIGHTSHIFT_API_TOKEN_FILE`): nothing is ever written to the volume, and a
 * renewal needs no restart. The program checkout is the one the workspace made
 * at the authorised SHA; worktrees, the spool and transcripts live under the
 * run's directory on the volume; and the orchestrator-role server the root
 * launches is told the branch's head at GitHub, so every landing raises a
 * publication intent (D-P10-22).
 */
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path/posix";
import { credentialPlacement, PROVIDERS, type Provider } from "@nightshift/contracts";
import { PROJECT_ENV_FILE_ENV } from "../project-env.js";
import type { Heartbeat } from "./heartbeat.js";
import type { Machine } from "./machine.js";
import type { RunnerContext } from "./main.js";

/** Where the project user's own credential copies live: `<root>/<VAR>/…`, the user's alone (D-P10-30). */
export const projectCredentialRoot = (runId: string): string =>
  join(tokenDirectory(runId), "project");

/**
 * Where the engine's token lives: RAM, this run's directory. The directory is
 * 0711, traversable but not listable, because the workers' own token
 * directories hang under it (T4) and a worker must reach its own; the engine's
 * file inside stays 0600 and the engine's.
 */
export const tokenDirectory = (runId: string): string => `/dev/shm/nightshift/${runId}`;
export const tokenFile = (runId: string): string => join(tokenDirectory(runId), "engine-token");

/** Writes the token where the root's processes read it. Called at start and on every renewal. */
export const installTokenFile = async (runId: string, token: string): Promise<void> => {
  const dir = tokenDirectory(runId);
  await mkdir(dir, { recursive: true, mode: 0o711 });
  await chmod(dir, 0o711);
  const path = tokenFile(runId);
  await writeFile(path, `${token}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
};

/**
 * The org's provider credentials, from the heartbeat (D-P10-23): the plane
 * hands them to `engine` only while the dispatch is `running`, so the runner
 * reports `running` and waits one beat. A run whose org set none gets none,
 * and the root's harness says so when it cannot start.
 */
export const awaitProviderCredentials = async (
  heartbeat: Heartbeat,
  machine: Machine,
  timeoutMs: number,
): Promise<Partial<Record<Provider, string>>> => {
  const deadline = machine.now() + timeoutMs;
  for (;;) {
    const credentials = heartbeat.last?.credentials ?? {};
    const found: Partial<Record<Provider, string>> = {};
    for (const provider of PROVIDERS as readonly Provider[]) {
      const value = credentials[provider];
      if (value !== undefined) found[provider] = value;
    }
    if (Object.keys(found).length > 0 || heartbeat.last?.status === "running") return found;
    if (heartbeat.last?.stop === true || machine.now() >= deadline) return found;
    await machine.sleep(1000);
  }
};

/**
 * Places each credential where its harness reads it: a variable, or a file on
 * tmpfs under the run's directory (0600, `engine` only) with a variable naming
 * the directory, as Codex's `auth.json` under `CODEX_HOME`. Answers the
 * environment the root is given.
 */
export const placeProviderCredentials = async (
  runId: string,
  credentials: Partial<Record<Provider, string>>,
  project: {
    /** The project user (D-P10-30); absent, nobody but the engine needs a copy. */
    readonly user?: string;
    /** `chown -R user:group path` as root; the image's sudoers rule allows exactly this. */
    readonly grant: (user: string, path: string) => Promise<void>;
  } = { grant: async () => undefined },
): Promise<Record<string, string>> => {
  const env: Record<string, string> = {};
  for (const [provider, secret] of Object.entries(credentials) as [Provider, string][]) {
    const placement = credentialPlacement(provider, secret);
    if (placement.kind === "env") {
      env[placement.name] = secret;
      continue;
    }
    const directory = join(tokenDirectory(runId), placement.directory);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, placement.file);
    await writeFile(path, secret, { mode: 0o600 });
    await chmod(path, 0o600);
    env[placement.env] = directory;
    // The project user gets a copy of its own (D-P10-30): the engine's stays
    // the engine's. The copies' directory is the user's, whole, and traversable
    // by anyone and listable by nobody (0711): the engine, no longer its owner
    // once it is handed over, must still see that `CODEX_HOME` exists to name
    // it in the user's environment (`run-as.ts`), while the copy inside stays
    // 0700 and the user's. A recursive mkdir made parents the engine's and
    // 0700, and every Codex examiner on FoodFly's first runs died at start
    // with "Permission denied" (2026-10-05), hence the explicit modes.
    if (project.user !== undefined) {
      const mine = projectCredentialRoot(runId);
      const own = join(mine, placement.env);
      await mkdir(own, { recursive: true, mode: 0o700 });
      await writeFile(join(own, placement.file), secret, { mode: 0o600 });
      await chmod(mine, 0o711);
      await project.grant(project.user, mine);
    }
  }
  return env;
};

export interface RootEnvironmentInput {
  readonly context: RunnerContext;
  readonly apiEndpoint: string;
  /** The user project code runs as (D-P10-30); absent runs every agent as the engine. */
  readonly projectUser?: string;
  /** The provider keys, by their environment variable names. */
  readonly providerKeys?: Readonly<Record<string, string>>;
  /** This process's environment, for PATH, HOME and the toolchain. */
  readonly parentEnv: Readonly<Record<string, string | undefined>>;
}

/**
 * The environment the root's runtime and the processes it launches run in:
 * the plane, the token file, the state directory on the volume, the
 * publication base, the machine's toolchain, and the file the project
 * environment is in. Nothing from this process that names a credential.
 */
export const rootEnvironment = (input: RootEnvironmentInput): Record<string, string> => {
  const { context } = input;
  const env: Record<string, string> = {};
  for (const name of ["PATH", "HOME", "LANG", "TERM", "USER", "LOGNAME"]) {
    const value = input.parentEnv[name];
    if (value !== undefined && value !== "") env[name] = value;
  }
  // The stores on the volume, for every process (D-P10-15).
  for (const [key, value] of Object.entries(input.parentEnv)) {
    if (
      value !== undefined &&
      (key.startsWith("npm_config_") ||
        [
          "PNPM_HOME",
          "CARGO_HOME",
          "RUSTUP_HOME",
          "PIP_CACHE_DIR",
          "UV_CACHE_DIR",
          "PLAYWRIGHT_BROWSERS_PATH",
        ].includes(key))
    ) {
      env[key] = value;
    }
  }
  // The project environment's file (P16 S-01), not the environment itself: the
  // engine the root launches reads it and gives it to each project step and
  // worker user, and runs in the image's environment itself (D-10).
  if (context.projectEnv !== undefined) env[PROJECT_ENV_FILE_ENV] = context.projectEnvFile;
  for (const [name, value] of Object.entries(input.providerKeys ?? {})) env[name] = value;
  env.NIGHTSHIFT_API_ENDPOINT = input.apiEndpoint;
  env.NIGHTSHIFT_API_TOKEN_FILE = tokenFile(context.scope.runId);
  env.NIGHTSHIFT_STATE_DIR = context.layout.run;
  env.NIGHTSHIFT_PUBLISH_BASE = context.dispatch.input.baseSha;
  if (input.projectUser !== undefined && input.projectUser !== "") {
    env.NIGHTSHIFT_PROJECT_USER = input.projectUser;
    env.NIGHTSHIFT_PROJECT_CREDENTIAL_DIR = projectCredentialRoot(context.scope.runId);
  }
  // The root's server attaches to this run and no other (D-P10-20).
  env.NIGHTSHIFT_PINNED_RUN = `${context.scope.projectId}/${context.scope.programId}/${context.scope.runId}`;
  env.NIGHTSHIFT_PUBLISH_PACK_DIR = join(context.layout.run, "bundles");
  return env;
};
