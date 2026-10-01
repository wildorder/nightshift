/**
 * The environment the Claude Code child process is given — and nothing else.
 *
 * Same shape and the same reasoning as `packages/verification/src/environment.ts`
 * (T4): an **allowlist, never a denylist**, so a new secret in the parent process
 * is invisible to the child by default rather than leaking until someone
 * remembers to extend a ban list. It is duplicated here rather than imported
 * because `harness-claude` may depend only on `contracts`, `core` and `harness`
 * (AR-1); the two lists are deliberately not the same list anyway, and the
 * differences are the interesting part of this module.
 *
 * ## What this process is holding that the child must not see
 *
 * The execution layer runs inside the orchestrator's MCP server process, which
 * holds the operator's Cognito refresh token and, on a deployed machine, the
 * `NIGHTSHIFT_*` execution identity of *its own* role. A worker that read
 * `NIGHTSHIFT_AGENT_ID` out of its environment could speak to the control plane
 * as somebody else. It is given none of them: the seven identity variables reach
 * the **worker's MCP server** through the `--mcp-config` file's `env` block
 * (`McpLaunch.env`, passed through unchanged, D-P3-01), which is a different
 * process with a different environment. `AWS_*` is absent for the same reason —
 * nothing local holds AWS credentials for the Nightshift account (D-P3-02), and
 * an operator's *personal* profile has no business inside a worker.
 *
 * ## The deliberate exceptions, and why each one is here
 *
 * Claude Code authenticates itself on the operator's machine; Nightshift never
 * hands it a credential. For that to work it has to be able to find its own
 * configuration, so these are allowed through on purpose:
 *
 * - `HOME` (and `USERPROFILE` on Windows) — `~/.claude` holds the OAuth session
 *   and settings, and on macOS the keychain lookup needs the user's home too.
 *   Without it the CLI starts unauthenticated and every run fails identically,
 *   which is indistinguishable from a model failure in the logs.
 * - `CLAUDE_CONFIG_DIR` — the documented override for that directory. An
 *   operator who has moved it must not have their worker silently look in the
 *   wrong place.
 * - `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL` — the
 *   non-subscription authentication path, plus gateway users. Passing an
 *   Anthropic credential to the Anthropic CLI is not the leak this allowlist
 *   guards against: it is the one process in the system that owns it. It is
 *   named explicitly rather than matched by prefix so that adding a second
 *   `ANTHROPIC_*` variable is a decision somebody makes here.
 * - `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `SSL_CERT_DIR` and the proxy
 *   variables — on a machine behind a TLS-intercepting proxy the CLI cannot
 *   reach the API without them, and the resulting failure looks like an outage
 *   rather than a configuration problem.
 * - `PATH`, `SHELL`, `TMPDIR`, locale and timezone — as in T4: a worker granted
 *   `shell.exec` runs real commands, and a toolchain that cannot find a temp
 *   directory writes into the worktree instead.
 *
 * `TERM` is deliberately absent, as in T4: with it the CLI emits ANSI colour
 * into a transcript nobody reads in a terminal.
 */

/** Passed through on every platform: without these nothing starts at all. */
const UNIVERSAL_ALLOWLIST: readonly string[] = ["PATH", "HOME"];

/**
 * Variables Claude Code needs to locate its own configuration, credentials and
 * network path. Allowed on every platform; see the module comment for why each
 * one earns its place.
 */
export const CLAUDE_ENV_ALLOWLIST: readonly string[] = [
  "CLAUDE_CONFIG_DIR",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
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

/** POSIX essentials, matching T4's list. */
export const POSIX_ENV_ALLOWLIST: readonly string[] = [
  ...UNIVERSAL_ALLOWLIST,
  ...CLAUDE_ENV_ALLOWLIST,
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TMPDIR",
  "SHELL",
  "USER",
  "LOGNAME",
];

/** Windows essentials, matching T4's list. */
export const WINDOWS_ENV_ALLOWLIST: readonly string[] = [
  ...UNIVERSAL_ALLOWLIST,
  ...CLAUDE_ENV_ALLOWLIST,
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

/**
 * Set by Nightshift on every Claude Code process it starts, over whatever the
 * parent had. Nothing here takes a capability away; background commands stay
 * on, and the session is kept alive for them (`session.ts`).
 *
 * - `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS` — the `session_state_changed`
 *   frames (`running`, `idle`) the adapter ends a session by. Without it Claude
 *   Code never says it is idle, and a session held open is held forever
 *   (found by the conformance run on 2.1.286).
 * - `BASH_MAX_TIMEOUT_MS` — two hours, so a gate a worker chooses to run in
 *   the foreground is not killed at Claude Code's ten-minute ceiling.
 * - `BASH_DEFAULT_TIMEOUT_MS` — ten minutes when the model names none, so a
 *   test suite is not killed at the two-minute default and run again.
 */
export const HEADLESS_CLAUDE_ENV: Readonly<Record<string, string>> = Object.freeze({
  CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1",
  BASH_MAX_TIMEOUT_MS: String(2 * 60 * 60 * 1000),
  BASH_DEFAULT_TIMEOUT_MS: String(10 * 60 * 1000),
});

export interface SanitizeClaudeEnvironmentInput {
  readonly platform: NodeJS.Platform;
  /** The parent process environment, injected so this function stays pure. */
  readonly parentEnv: Readonly<Record<string, string | undefined>>;
  /** Added to the allowlisted base; an entry here wins on a name collision. */
  readonly extra?: Readonly<Record<string, string>>;
}

/**
 * The environment for the worker's Claude Code process: the platform allowlist
 * filtered out of the parent, plus whatever the caller added.
 *
 * Caller entries are applied over the base rather than beside it, so a caller
 * that means to extend `PATH` can, but the base is never discarded.
 *
 * Windows environment names are case-insensitive, so the match there is too: a
 * parent whose variable is spelled `Path` must still reach the child, and it
 * keeps its original spelling when it does.
 */
export const sanitizeClaudeEnvironment = (
  input: SanitizeClaudeEnvironmentInput,
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
