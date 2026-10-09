/**
 * Running an agent's process as another operating-system user (P10, D-P10-25).
 *
 * On a machine the engine runs as `engine` and every job's agent as one of the
 * `worker-N` users, so code a worker runs cannot read the engine's token or
 * credentials. The adapter does not know users; it is handed this and wraps
 * the command it would have spawned: `sudo -n -u <user> -H env K=V… sh -c
 * '<RUN_AS_SHELL_LINE>' <command> <args>`. The environment the adapter
 * sanitised is passed whole through `env`, less the variables that name the
 * engine's own account, which `sudo -H` sets for the target user; the umask
 * makes what the worker writes group-writable, so the engine can verify and
 * remove the worktree afterwards (D-P10-25's shared group).
 *
 * `XDG_RUNTIME_DIR` is the engine's and is never passed; the shell line sets
 * the target user's own, `/run/user/<uid>`, so the user's rootless Docker
 * socket resolves there (P16 S-01, D-05). `DOCKER_HOST` defaults to that
 * socket when nothing set it for the user; the engine's own is never passed,
 * since it names the engine's socket, not the user's.
 */

export interface RunAs {
  /** The operating-system user the process runs as. */
  readonly user: string;
  /**
   * Makes a path the adapter wrote readable by `user`: the configuration
   * directory carrying the agent's own token and MCP launch, the git guard.
   */
  grant(path: string): Promise<void>;
  /** Environment the user needs that differs from the engine's: a `CODEX_HOME` of its own. */
  readonly env?: Readonly<Record<string, string>>;
  /** Signals the process tree as the user, since the engine may not signal another user's processes. */
  kill?(pid: number, signal: NodeJS.Signals): void;
}

/** Variables that name the engine's account; `sudo -H` sets the user's own. */
const ACCOUNT_VARIABLES: ReadonlySet<string> = new Set([
  "HOME",
  "USER",
  "LOGNAME",
  "XDG_RUNTIME_DIR",
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
  "TMPDIR",
]);

/**
 * Variables the engine's environment may carry that are never right for
 * another user: only `RunAs.env` may set them (P16 S-01).
 */
const ENGINE_ONLY_VARIABLES: ReadonlySet<string> = new Set(["DOCKER_HOST"]);

export interface Command {
  readonly file: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

/**
 * The exec line that runs `file args` as the target user, `$0` the file and
 * `$@` the args: the user's own `XDG_RUNTIME_DIR`, a `DOCKER_HOST` on its
 * socket unless one was given, then the umask.
 */
export const RUN_AS_SHELL_LINE =
  'XDG_RUNTIME_DIR="/run/user/$(id -u)" && export XDG_RUNTIME_DIR && ' +
  // biome-ignore lint/suspicious/noTemplateCurlyInString: a shell expansion, on purpose
  'export DOCKER_HOST="${DOCKER_HOST:-unix://$XDG_RUNTIME_DIR/docker.sock}" && ' +
  'umask 002 && exec "$0" "$@"';

/**
 * The command to spawn: the adapter's own when there is no user to run as,
 * otherwise the `sudo` line above. The spawned process's own environment is
 * then only `PATH`, for `sudo` to find `env`; everything the agent needs
 * travels in the `env` arguments.
 */
export const commandAs = (
  runAs: RunAs | undefined,
  file: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
): Command => {
  if (runAs === undefined) return { file, args, env };
  const engines = Object.entries(env).filter(([name]) => !ENGINE_ONLY_VARIABLES.has(name));
  const passed = Object.entries({
    ...Object.fromEntries(engines),
    ...(runAs.env ?? {}),
  }).filter(([name]) => !ACCOUNT_VARIABLES.has(name));
  return {
    file: "sudo",
    args: [
      "-n",
      "-u",
      runAs.user,
      "-H",
      "env",
      ...passed.map(([name, value]) => `${name}=${value}`),
      "sh",
      "-c",
      RUN_AS_SHELL_LINE,
      file,
      ...args,
    ],
    env: { PATH: env.PATH ?? "/usr/local/bin:/usr/bin:/bin" },
  };
};

/** The variables a platform's temp lookup reads: `TMPDIR` on POSIX, `TEMP` and `TMP` on Windows. */
const TEMP_VARIABLES = ["TMPDIR", "TEMP", "TMP"] as const;

/**
 * `env` with every temp variable pointing at `tmpDir` (P15), replacing any
 * spelling of them already there: Windows reads names without regard to case,
 * and two spellings of one name in a child's environment is undefined there.
 * `env` itself, unchanged, when there is no `tmpDir`.
 */
export const withTmpDir = (
  env: Readonly<Record<string, string>>,
  tmpDir: string | undefined,
): Readonly<Record<string, string>> => {
  if (tmpDir === undefined) return env;
  const replaced = new Set<string>(TEMP_VARIABLES);
  const kept = Object.entries(env).filter(([name]) => !replaced.has(name.toUpperCase()));
  return Object.freeze({
    ...Object.fromEntries(kept),
    ...Object.fromEntries(TEMP_VARIABLES.map((name) => [name, tmpDir])),
  });
};
