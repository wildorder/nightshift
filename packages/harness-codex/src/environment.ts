/**
 * The environment the Codex child process is given — and nothing else.
 *
 * An **allowlist, never a denylist**, for the reason `harness-claude` and
 * `verification` give: a new secret in the parent process must be invisible to a
 * worker by default. The orchestrator's process holds the operator's Nightshift
 * session; none of `NIGHTSHIFT_*`, `AWS_*`, `ANTHROPIC_*` or anything else of the
 * operator's reaches a Codex worker. The worker's identity and execution token
 * reach the **worker's MCP server** through `-c mcp_servers.nightshift.env=…`,
 * which is a different process with a different environment.
 *
 * ## The deliberate exceptions
 *
 * - `CODEX_HOME` — where Codex keeps the operator's login (`auth.json`). Passed
 *   through and never read here: the login is the operator's, on the operator's
 *   machine, and nothing in Nightshift moves it (D-P5-02, D-P5-07).
 * - `HOME` (`USERPROFILE` on Windows) — `CODEX_HOME` defaults to `~/.codex`, so
 *   without it an operator who never set `CODEX_HOME` starts unauthenticated and
 *   every run fails identically.
 * - The certificate and proxy variables — behind a TLS-intercepting proxy the
 *   CLI cannot reach its API without them, and the failure looks like an outage.
 * - `PATH`, `SHELL`, `TMPDIR`, locale and timezone — a worker runs real commands.
 *
 * **`OPENAI_API_KEY` is deliberately absent.** D-P5-02 pins Codex to the
 * operator's login; passing a key through would silently change who pays and
 * under which terms. It is one line to add, and a decision to make, not a
 * default to inherit.
 */

const UNIVERSAL_ALLOWLIST: readonly string[] = ["PATH", "HOME"];

export const CODEX_ENV_ALLOWLIST: readonly string[] = [
  // Where the agent's shell finds Docker (P16 S-01, D-05): a developer's
  // colima or remote daemon on a laptop. On a machine the worker's own socket
  // arrives through \`RunAs.env\` or the run-as wrapper's default; the engine's
  // is never passed to another user (\`commandAs\`). Not a credential.
  "DOCKER_HOST",
  "CODEX_HOME",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
];

export const POSIX_ENV_ALLOWLIST: readonly string[] = [
  ...UNIVERSAL_ALLOWLIST,
  ...CODEX_ENV_ALLOWLIST,
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TMPDIR",
  "SHELL",
  "USER",
  "LOGNAME",
];

export const WINDOWS_ENV_ALLOWLIST: readonly string[] = [
  ...UNIVERSAL_ALLOWLIST,
  ...CODEX_ENV_ALLOWLIST,
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

export interface SanitizeCodexEnvironmentInput {
  readonly platform: NodeJS.Platform;
  /** The parent process environment, injected so this function stays pure. */
  readonly parentEnv: Readonly<Record<string, string | undefined>>;
  /** Added to the allowlisted base; an entry here wins on a name collision. */
  readonly extra?: Readonly<Record<string, string>>;
}

/**
 * The environment for the worker's Codex process: the platform allowlist
 * filtered out of the parent, plus whatever the caller added. Windows names are
 * matched case-insensitively and keep their spelling.
 */
export const sanitizeCodexEnvironment = (
  input: SanitizeCodexEnvironmentInput,
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
