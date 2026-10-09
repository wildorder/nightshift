/**
 * The environment a verification step is given — and nothing else.
 *
 * This is a security boundary, not hygiene. A verification step is whatever the
 * human-authored Program Contract says it is, and it runs inside a target
 * repository; the Nightshift process that launches it holds the operator's
 * Cognito refresh token, AWS credentials and the `NIGHTSHIFT_*` execution
 * identity. Handing a step `process.env` would hand every one of those to a
 * command written by whoever can edit the contract.
 *
 * So the base environment is an allowlist, never a denylist: a variable reaches
 * a step because it is named here or because the caller added it deliberately.
 * A new secret in the parent process is then invisible to steps by default,
 * which is the failure mode we want — a denylist would leak it until someone
 * remembered to extend the list.
 */

/**
 * Passed through on every platform. Without `PATH` a shell finds no tool, and
 * without `HOME` git, npm and most toolchains cannot locate their own config.
 */
const UNIVERSAL_ALLOWLIST: readonly string[] = ["PATH", "HOME"];

/**
 * The variables of the project environment (P16 S-01): Docker, the caches on
 * the volume, and the pinned runtimes. On a machine the engine never carries
 * them (D-10): its caller hands the project environment to a step whole,
 * through `env`, which is applied over this base and so is never filtered by
 * it. They are passed through from the parent so a developer's own, on a
 * laptop, reach a step as they did. None is a secret: each names a socket, a
 * directory or a version.
 */
export const PROJECT_ENV_ALLOWLIST: readonly string[] = [
  "DOCKER_HOST",
  "npm_config_cache",
  "PNPM_HOME",
  "npm_config_store_dir",
  "CARGO_HOME",
  "RUSTUP_HOME",
  // The exact Rust the dispatch pinned, over a `rust-toolchain.toml` channel.
  "RUSTUP_TOOLCHAIN",
  "PIP_CACHE_DIR",
  "UV_CACHE_DIR",
  "PLAYWRIGHT_BROWSERS_PATH",
  "JAVA_HOME",
];

/**
 * POSIX essentials. Locale and timezone are here because leaving them unset
 * changes a tool's output (sort order, date formatting) rather than sandboxing
 * anything, and `TMPDIR` because a build tool that cannot find a temp directory
 * writes into the checkout instead.
 *
 * `TERM` is deliberately absent: with it, tools emit ANSI colour into the
 * captured log for no reader's benefit.
 */
export const POSIX_ENV_ALLOWLIST: readonly string[] = [
  ...UNIVERSAL_ALLOWLIST,
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TMPDIR",
  "SHELL",
  "USER",
  "LOGNAME",
  ...PROJECT_ENV_ALLOWLIST,
];

/**
 * Windows essentials. The first four are what `cmd.exe` itself needs to start
 * and to resolve a command name; the temp and profile directories are what the
 * Node and npm toolchain needs to find its cache and config. Omitting
 * `APPDATA`/`LOCALAPPDATA` makes `npm test` behave differently on Windows than
 * a developer's shell does, which defeats the point of deterministic
 * verification.
 */
export const WINDOWS_ENV_ALLOWLIST: readonly string[] = [
  ...UNIVERSAL_ALLOWLIST,
  "SystemRoot",
  "windir",
  "SystemDrive",
  "COMSPEC",
  "PATHEXT",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "ProgramData",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
];

/** The allowlist for a platform. Exported so a test can enumerate it. */
export const envAllowlistFor = (platform: NodeJS.Platform): readonly string[] =>
  platform === "win32" ? WINDOWS_ENV_ALLOWLIST : POSIX_ENV_ALLOWLIST;

export interface SanitizeEnvironmentInput {
  readonly platform: NodeJS.Platform;
  /** The parent process environment, injected so this function stays pure. */
  readonly parentEnv: Readonly<Record<string, string | undefined>>;
  /** Added to the allowlisted base; an entry here wins on a name collision. */
  readonly extra: Readonly<Record<string, string>> | undefined;
}

/**
 * The environment for a step: the platform allowlist filtered out of the
 * parent, plus whatever the caller added.
 *
 * Caller entries are applied over the base rather than beside it, so a caller
 * that means to extend `PATH` can, but the base is never discarded — a caller
 * cannot accidentally strip `PATH` and turn every step into a spawn failure.
 *
 * Windows environment names are case-insensitive, so the match there is too:
 * a parent whose variable is spelled `Path` must still reach the child, and it
 * keeps its original spelling when it does.
 */
export const sanitizeEnvironment = (
  input: SanitizeEnvironmentInput,
): Readonly<Record<string, string>> => {
  const caseInsensitive = input.platform === "win32";
  const allowed = new Set(
    envAllowlistFor(input.platform).map((name) => (caseInsensitive ? name.toUpperCase() : name)),
  );
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.parentEnv)) {
    if (value === undefined) continue;
    if (!allowed.has(caseInsensitive ? name.toUpperCase() : name)) continue;
    env[name] = value;
  }
  for (const [name, value] of Object.entries(input.extra ?? {})) env[name] = value;
  return Object.freeze(env);
};
