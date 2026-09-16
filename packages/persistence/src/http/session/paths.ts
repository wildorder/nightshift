/**
 * Where Nightshift keeps things on a developer's machine (D-P3-10).
 *
 * Two directories, deliberately distinct:
 *
 * - **config** holds what the operator set up and would be annoyed to lose: the
 *   profile and the credentials.
 * - **state** holds what a run produces and nobody would miss: worktrees, the
 *   event spool, transcripts awaiting upload.
 *
 * Neither is ever the program checkout. Nothing is written into the operator's
 * repository except by fast-forwarding its branch (A-29), and putting a worktree
 * or a spool file under it would break that the first time someone ran `git
 * status`.
 *
 * One module, used by the CLI, the MCP server and the execution layer, so the
 * three cannot disagree about where a spool lives.
 */
import { homedir } from "node:os";
import { join } from "node:path";

export const CONFIG_DIR_ENV = "NIGHTSHIFT_CONFIG_DIR";
export const STATE_DIR_ENV = "NIGHTSHIFT_STATE_DIR";

/** The directory name Nightshift appends to a platform's base directory. */
const APP = "nightshift";

export interface PathEnvironment {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly platform?: NodeJS.Platform;
  readonly home?: string;
}

const read = (
  environment: PathEnvironment,
): {
  env: Readonly<Record<string, string | undefined>>;
  platform: NodeJS.Platform;
  home: string;
} => ({
  env: environment.env ?? process.env,
  platform: environment.platform ?? process.platform,
  home: environment.home ?? homedir(),
});

/**
 * The config directory.
 *
 * `NIGHTSHIFT_CONFIG_DIR` wins, so a test never touches the operator's real one.
 * Otherwise: `LOCALAPPDATA` on Windows, `XDG_CONFIG_HOME` where it is set, and
 * `~/.config` on Linux and macOS.
 *
 * macOS gets the XDG layout rather than `~/Library/Application Support`, on
 * purpose: this is a developer tool whose files a developer will want to read,
 * diff and occasionally delete by hand, and every other tool in that workflow
 * puts them under `~/.config`.
 */
export const configDir = (environment: PathEnvironment = {}): string => {
  const { env, platform, home } = read(environment);
  const override = env[CONFIG_DIR_ENV];
  if (override !== undefined && override !== "") return override;
  if (platform === "win32") {
    const local = env.LOCALAPPDATA;
    return join(local === undefined || local === "" ? join(home, "AppData", "Local") : local, APP);
  }
  const xdg = env.XDG_CONFIG_HOME;
  return join(xdg === undefined || xdg === "" ? join(home, ".config") : xdg, APP);
};

/**
 * The state directory: `LOCALAPPDATA` on Windows, `XDG_STATE_HOME` or
 * `~/.local/state` elsewhere.
 */
export const stateDir = (environment: PathEnvironment = {}): string => {
  const { env, platform, home } = read(environment);
  const override = env[STATE_DIR_ENV];
  if (override !== undefined && override !== "") return override;
  if (platform === "win32") {
    const local = env.LOCALAPPDATA;
    return join(
      local === undefined || local === "" ? join(home, "AppData", "Local") : local,
      APP,
      "state",
    );
  }
  const xdg = env.XDG_STATE_HOME;
  return join(xdg === undefined || xdg === "" ? join(home, ".local", "state") : xdg, APP);
};

export const profilePath = (environment: PathEnvironment = {}): string =>
  join(configDir(environment), "profile.json");

export const credentialsPath = (environment: PathEnvironment = {}): string =>
  join(configDir(environment), "credentials.json");

/**
 * Where one run's local state lives.
 *
 * Kept short on purpose. Windows still has a 260-character path limit in many
 * APIs, and a worktree under here holds a whole repository checkout, so the
 * prefix this adds must not eat the budget: `wt` rather than `worktrees`, and the
 * tail of an identifier rather than the whole ULID (the full ids are recorded on
 * the node, which is where a reader should look anyway).
 */
export const runStateDir = (runId: string, environment: PathEnvironment = {}): string =>
  join(stateDir(environment), "runs", runId);

export const spoolPath = (runId: string, environment: PathEnvironment = {}): string =>
  join(runStateDir(runId, environment), "spool.ndjson");

export const agentStateDir = (
  runId: string,
  agentId: string,
  environment: PathEnvironment = {},
): string => join(runStateDir(runId, environment), "agents", agentId);

export const transcriptPath = (
  runId: string,
  agentId: string,
  environment: PathEnvironment = {},
): string => join(agentStateDir(runId, agentId, environment), "transcript.jsonl");

/** The last `count` characters of an identifier, for a short worktree path. */
export const idTail = (id: string, count = 8): string => id.slice(-count);

/** `<state>/wt/<runId tail>/<nodeId tail>` — see {@link runStateDir} on length. */
export const worktreePath = (
  runId: string,
  nodeId: string,
  environment: PathEnvironment = {},
): string => join(stateDir(environment), "wt", idTail(runId), idTail(nodeId));
