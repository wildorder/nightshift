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
import { join } from "node:path";
import { PROVIDER_KEY_ENV, type Provider } from "@nightshift/contracts";
import type { Heartbeat } from "./heartbeat.js";
import type { Machine } from "./machine.js";
import type { RunnerContext } from "./main.js";

/** Where the engine's token lives: RAM, this run's directory, 0700. */
export const tokenDirectory = (runId: string): string => `/dev/shm/nightshift/${runId}`;
export const tokenFile = (runId: string): string => join(tokenDirectory(runId), "engine-token");

/** Writes the token where the root's processes read it. Called at start and on every renewal. */
export const installTokenFile = async (runId: string, token: string): Promise<void> => {
  const dir = tokenDirectory(runId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = tokenFile(runId);
  await writeFile(path, `${token}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
};

/**
 * The org's provider keys, from the heartbeat (D-P10-23): the plane hands them
 * to `engine` only while the dispatch is `running`, so the runner reports
 * `running` and waits one beat. A run whose org set no key gets no key, and
 * the root's harness says so when it cannot start.
 */
export const awaitProviderKeys = async (
  heartbeat: Heartbeat,
  machine: Machine,
  timeoutMs: number,
): Promise<Record<string, string>> => {
  const deadline = machine.now() + timeoutMs;
  for (;;) {
    const credentials = heartbeat.last?.credentials ?? {};
    const keys: Record<string, string> = {};
    for (const [provider, env] of Object.entries(PROVIDER_KEY_ENV) as [Provider, string][]) {
      const value = credentials[provider];
      if (value !== undefined) keys[env] = value;
    }
    if (Object.keys(keys).length > 0 || heartbeat.last?.status === "running") return keys;
    if (heartbeat.last?.stop === true || machine.now() >= deadline) return keys;
    await machine.sleep(1000);
  }
};

export interface RootEnvironmentInput {
  readonly context: RunnerContext;
  readonly apiEndpoint: string;
  /** The provider keys, by their environment variable names. */
  readonly providerKeys?: Readonly<Record<string, string>>;
  /** This process's environment, for PATH, HOME and the toolchain. */
  readonly parentEnv: Readonly<Record<string, string | undefined>>;
}

/**
 * The environment the root's runtime and the processes it launches run in:
 * the plane, the token file, the state directory on the volume, the
 * publication base, and the machine's toolchain. Nothing from this process
 * that names a credential.
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
  for (const [name, value] of Object.entries(input.providerKeys ?? {})) env[name] = value;
  env.NIGHTSHIFT_API_ENDPOINT = input.apiEndpoint;
  env.NIGHTSHIFT_API_TOKEN_FILE = tokenFile(context.scope.runId);
  env.NIGHTSHIFT_STATE_DIR = context.layout.run;
  env.NIGHTSHIFT_PUBLISH_BASE = context.dispatch.input.baseSha;
  env.NIGHTSHIFT_PUBLISH_PACK_DIR = join(context.layout.run, "bundles");
  return env;
};
