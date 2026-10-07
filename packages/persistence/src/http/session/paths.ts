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
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { LocalPaths } from "@nightshift/core";

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

/**
 * One profile per stage (P12, D-P12-05):
 *
 * ```text
 * <config>/current                              the stage in use
 * <config>/profiles/<stage>/profile.json         where that stage's plane is
 * <config>/profiles/<stage>/credentials.json     its session (Cognito stages)
 * ```
 *
 * `nightshift login` selects the stage it signed into, `nightshift local`
 * selects `local`, `nightshift use <stage>` switches. The CLI and the MCP server
 * read the same `current`, so they switch together.
 */
const PROFILE_FILE = "profile.json";
const CREDENTIALS_FILE = "credentials.json";
const STAGE_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

export const isStageName = (stage: string): boolean => STAGE_NAME.test(stage);

export const profilesDir = (environment: PathEnvironment = {}): string =>
  join(configDir(environment), "profiles");

export const currentStagePath = (environment: PathEnvironment = {}): string =>
  join(configDir(environment), "current");

/**
 * Moves a pre-P12 flat profile (`<config>/profile.json` and its
 * `credentials.json`) under `profiles/<its stage>/` and selects it, once. A
 * move, never a copy then a delete, so a sign-in is never lost halfway.
 */
const migrateFlatLayout = (environment: PathEnvironment): void => {
  const dir = configDir(environment);
  const flatProfile = join(dir, PROFILE_FILE);
  if (existsSync(currentStagePath(environment)) || !existsSync(flatProfile)) return;
  let stage: unknown;
  try {
    stage = (JSON.parse(readFileSync(flatProfile, "utf8")) as { stage?: unknown }).stage;
  } catch {
    return; // Not a profile this code wrote; the reader will say so.
  }
  if (typeof stage !== "string" || !isStageName(stage)) return;
  const target = join(profilesDir(environment), stage);
  mkdirSync(target, { recursive: true, mode: 0o700 });
  renameSync(flatProfile, join(target, PROFILE_FILE));
  const flatCredentials = join(dir, CREDENTIALS_FILE);
  if (existsSync(flatCredentials)) renameSync(flatCredentials, join(target, CREDENTIALS_FILE));
  writeFileSync(currentStagePath(environment), `${stage}\n`, { mode: 0o600 });
};

/** The stage in use, or `undefined` on a machine that has never signed in anywhere. */
export const currentStage = (environment: PathEnvironment = {}): string | undefined => {
  migrateFlatLayout(environment);
  const path = currentStagePath(environment);
  if (!existsSync(path)) return undefined;
  const stage = readFileSync(path, "utf8").trim();
  return isStageName(stage) ? stage : undefined;
};

/** Selects `stage` for every command and MCP server that reads the profile after. */
export const selectStage = (stage: string, environment: PathEnvironment = {}): void => {
  if (!isStageName(stage)) throw new Error(`not a stage name: ${stage}`);
  mkdirSync(configDir(environment), { recursive: true, mode: 0o700 });
  writeFileSync(currentStagePath(environment), `${stage}\n`, { mode: 0o600 });
};

/** Every stage this machine holds a profile for. */
export const knownStages = (environment: PathEnvironment = {}): readonly string[] => {
  migrateFlatLayout(environment);
  const dir = profilesDir(environment);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((stage) => isStageName(stage) && existsSync(join(dir, stage, PROFILE_FILE)))
    .sort();
};

const stageDir = (environment: PathEnvironment, stage: string | undefined): string =>
  stage === undefined ? configDir(environment) : join(profilesDir(environment), stage);

/**
 * A stage's profile; with no stage named, the current one's. On a machine with
 * no current stage this is the flat path, where nothing is: a reader then says
 * "not signed in", which is true.
 */
export const profilePath = (environment: PathEnvironment = {}, stage?: string): string =>
  join(stageDir(environment, stage ?? currentStage(environment)), PROFILE_FILE);

export const credentialsPath = (environment: PathEnvironment = {}, stage?: string): string =>
  join(stageDir(environment, stage ?? currentStage(environment)), CREDENTIALS_FILE);

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

/** `<state>/t/<12 hex of the checkout's path>` — see {@link LocalPaths.scratch} on length. */
export const scratchPath = (checkout: string, environment: PathEnvironment = {}): string =>
  join(
    stateDir(environment),
    "t",
    createHash("sha256").update(checkout).digest("hex").slice(0, 12),
  );

/**
 * The {@link LocalPaths} port over this module (D-P3-10).
 *
 * The execution layer takes the port; the composition root builds this. Declared
 * against the port in `core` so the two cannot drift: a change to either side
 * that broke the other fails to compile here.
 */
export const createLocalPaths = (environment: PathEnvironment = {}): LocalPaths => ({
  worktree: (runId, nodeId) => worktreePath(runId, nodeId, environment),
  runDir: (runId) => runStateDir(runId, environment),
  spool: (runId) => spoolPath(runId, environment),
  transcript: (runId, agentId) => transcriptPath(runId, agentId, environment),
  scratch: (checkout) => scratchPath(checkout, environment),
});
