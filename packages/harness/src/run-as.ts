/**
 * Running an agent's process as another operating-system user (P10, D-P10-25).
 *
 * On a machine the engine runs as `engine` and every job's agent as one of the
 * `worker-N` users, so code a worker runs cannot read the engine's token or
 * credentials. The adapter does not know users; it is handed this and wraps
 * the command it would have spawned: `sudo -n -u <user> -H env K=V… sh -c
 * 'umask 002 && exec "$0" "$@"' <command> <args>`. The environment the
 * adapter sanitised is passed whole through `env`, less the variables that
 * name the engine's own account, which `sudo -H` sets for the target user; the
 * umask makes what the worker writes group-writable, so the engine can verify
 * and remove the worktree afterwards (D-P10-25's shared group).
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

export interface Command {
  readonly file: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

/** The exec line that runs `file args` after setting the umask; `$0` is the file, `$@` the args. */
export const RUN_AS_SHELL_LINE = 'umask 002 && exec "$0" "$@"';

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
  const passed = Object.entries({ ...env, ...(runAs.env ?? {}) }).filter(
    ([name]) => !ACCOUNT_VARIABLES.has(name),
  );
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
