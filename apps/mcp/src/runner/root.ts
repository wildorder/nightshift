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
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path/posix";
import {
  CODEX_AUTH_FILE,
  CODEX_HOME_ENV,
  credentialPlacement,
  isCodexAuthFile,
  PROVIDERS,
  type Provider,
  refreshedCodexLogin,
} from "@nightshift/contracts";
import { PROJECT_ENV_FILE_ENV } from "../project-env.js";
import type { Heartbeat } from "./heartbeat.js";
import type { Machine } from "./machine.js";
import type { RunnerContext } from "./main.js";

/** How often the agents' Codex login is looked at for a refresh to save back. */
export const CODEX_LOGIN_WATCH_MS = 5 * 60_000;

/** The Codex login files on a machine: the engine's copy, and the project user's (D-P10-30). */
export const codexLoginPaths = (
  runId: string,
): { readonly engine: string; readonly project: string } => ({
  engine: join(tokenDirectory(runId), "codex", CODEX_AUTH_FILE),
  project: join(projectCredentialRoot(runId), CODEX_HOME_ENV, CODEX_AUTH_FILE),
});

/**
 * Watches the run's Codex logins and offers a refreshed one back to the plane
 * (2026-10-13). A ChatGPT login rotates its refresh token on every refresh;
 * the run's copies are on tmpfs and go with the machine, so a refresh here
 * that was not saved left the org's sealed copy dead, and the next run's every
 * Codex agent got a 401. `read` answers the copies as they are now (a missing
 * or unreadable one is left out); the newest that `refreshedCodexLogin` takes
 * over the last one offered is offered. `stop` looks one last time.
 */
export const watchCodexLogin = (options: {
  readonly sealed: string;
  readonly read: () => Promise<readonly string[]>;
  readonly offer: (login: string) => void;
  readonly log: (line: string) => void;
  readonly intervalMs?: number;
}): { readonly check: () => Promise<void>; readonly stop: () => Promise<void> } => {
  let latest = options.sealed;
  const check = async (): Promise<void> => {
    try {
      for (const copy of await options.read()) {
        if (copy === latest || !refreshedCodexLogin(latest, copy).accept) continue;
        latest = copy;
        options.offer(copy);
        options.log("the agents' Codex login was refreshed; offered it back to the org");
      }
    } catch (error) {
      options.log(
        `could not look at the Codex login: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
  const timer = setInterval(() => void check(), options.intervalMs ?? CODEX_LOGIN_WATCH_MS);
  timer.unref?.();
  return {
    check,
    stop: async () => {
      clearInterval(timer);
      await check();
    },
  };
};

/** Whether `credentials` carries a Codex login file to watch. */
export const codexLoginOf = (
  credentials: Partial<Record<Provider, string>>,
): string | undefined => {
  const login = credentials.openai;
  return login !== undefined && isCodexAuthFile(login) ? login : undefined;
};

/**
 * The run's Codex logins watched, when the org's `openai` credential is one:
 * the engine's copy read directly, the project user's through `sudo` as that
 * user, since its copy is the user's alone (D-P10-30).
 */
export const startCodexWatch = (options: {
  readonly context: Pick<RunnerContext, "scope" | "machine" | "heartbeat">;
  readonly credentials: Partial<Record<Provider, string>>;
  /** Empty or absent: no project user, so only the engine's copy is read. */
  readonly projectUser?: string | undefined;
  readonly log: (line: string) => void;
}): { readonly stop: () => Promise<void> } => {
  const sealed = codexLoginOf(options.credentials);
  if (sealed === undefined) return { stop: async () => undefined };
  const { context } = options;
  const projectUser = options.projectUser === "" ? undefined : options.projectUser;
  const paths = codexLoginPaths(context.scope.runId);
  return watchCodexLogin({
    sealed,
    read: async () => {
      const copies: string[] = [];
      const engine = await readFile(paths.engine, "utf8").catch(() => undefined);
      if (engine !== undefined) copies.push(engine);
      if (projectUser !== undefined) {
        const read = await context.machine.exec("sudo", [
          "-n",
          "-u",
          projectUser,
          "cat",
          paths.project,
        ]);
        if (read.exitCode === 0) copies.push(read.stdout);
      }
      return copies;
    },
    offer: (login) => context.heartbeat.offerCredentials({ openai: login }),
    log: options.log,
  });
};

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
  const temporary = `${path}.next`;
  await writeFile(temporary, `${token}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
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
    /**
     * Takes a path the engine granted back into the engine's ownership, as
     * root (2026-10-21). A runner restarted on the same machine — systemd
     * after a crash — finds the project user's copies where it left them,
     * owned by that user and closed to the engine, and must own them again
     * before it can write the fresh ones: the engine owns what it removes.
     * Absent, the copies are written as if the directory were new.
     */
    readonly reclaim?: (path: string) => Promise<void>;
  } = { grant: async () => undefined },
  /** Where the run's credentials live; the run's tmpfs directory unless a test says otherwise. */
  base: string = tokenDirectory(runId),
): Promise<Record<string, string>> => {
  const env: Record<string, string> = {};
  const mine = join(base, "project");
  let reclaimed = false;
  for (const [provider, secret] of Object.entries(credentials) as [Provider, string][]) {
    const placement = credentialPlacement(provider, secret);
    if (placement.kind === "env") {
      env[placement.name] = secret;
      continue;
    }
    const directory = join(base, placement.directory);
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
      if (!reclaimed) {
        await project.reclaim?.(mine);
        reclaimed = true;
      }
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
  /**
   * A-62: the project's secrets, from the heartbeat. They are in the engine's
   * own environment, as a developer's are on a laptop, and the engine gives the
   * ones the program declares to every step and agent it starts.
   */
  readonly secrets?: Readonly<Record<string, string>>;
}

/**
 * The environment the root's runtime and the processes it launches run in:
 * the plane, the token file, the state directory on the volume, the
 * publication base, the machine's toolchain, and the file the project
 * environment is in. Nothing from this process that names a credential; the
 * project's secrets and the org's provider keys come from the plane.
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
  // Before everything Nightshift sets, so none of its own can be shadowed.
  for (const [name, value] of Object.entries(input.secrets ?? {})) env[name] = value;
  // The project environment's file (P16 S-01), not the environment itself: the
  // engine the root launches reads it and gives it to each project step and
  // worker user, and runs in the image's environment itself (D-10).
  if (context.projectEnv !== undefined) env[PROJECT_ENV_FILE_ENV] = context.projectEnvFile;
  for (const [name, value] of Object.entries(input.providerKeys ?? {})) env[name] = value;
  env.NIGHTSHIFT_API_ENDPOINT = input.apiEndpoint;
  env.NIGHTSHIFT_API_TOKEN_FILE = tokenFile(context.scope.runId);
  env.NIGHTSHIFT_STATE_DIR = context.layout.run;
  env.NIGHTSHIFT_REMOTE_WORKSPACE = context.layout.root;
  // What GitHub surely holds, which every strand's pack is made against (A-60).
  // A landing's predecessor is the engine's to read from the record each time,
  // so a resumed machine or a relaunched root carries the chain on from where
  // it stands (2026-10-14, 2026-10-19).
  env.NIGHTSHIFT_PUBLISH_BASE = context.dispatch.input.baseSha;
  if (input.projectUser !== undefined && input.projectUser !== "") {
    env.NIGHTSHIFT_PROJECT_USER = input.projectUser;
    env.NIGHTSHIFT_PROJECT_CREDENTIAL_DIR = projectCredentialRoot(context.scope.runId);
  }
  // The root's server attaches to this run and no other (D-P10-20).
  env.NIGHTSHIFT_PINNED_RUN = `${context.scope.projectId}/${context.scope.programId}/${context.scope.runId}`;
  // Which machine this is, so the engine judges a prerequisite by this
  // machine's own check for its generation, never the laptop's (D-P7-10).
  env.NIGHTSHIFT_DISPATCH_GENERATION = String(context.dispatch.generation);
  env.NIGHTSHIFT_IMAGE_VERSION = context.dispatch.amiVersion;
  env.NIGHTSHIFT_PUBLISH_PACK_DIR = join(context.layout.run, "bundles");
  return env;
};
