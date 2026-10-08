/**
 * `@nightshift/cli` — sign in, create a project, start a run (T7).
 *
 * A thin client (A-16). It holds no domain logic, no routing and no execution
 * logic: `nightshift run` calls `startRun` from `@nightshift/execution`, the
 * same function the MCP server's `run.start` calls, and every control-plane
 * write goes through `@nightshift/persistence/http`. The one thing that is
 * genuinely the CLI's own is the interactive sign-in — authorization code with
 * PKCE against the loopback redirect the data stack reserves — because there is
 * nowhere else for it to live: it needs a browser and a human.
 *
 * Everything below `bin/nightshift.ts` takes its dependencies as parameters, so
 * the whole surface is drivable with no network, no browser and no real home
 * directory.
 */

export { openBrowser, openerFor } from "./browser.js";
export { runCli, USAGE, VERSION } from "./cli.js";
export {
  gateHealthReadiness,
  type RecordedGatesOptions,
  type RecordGatesOptions,
  recordedGates,
  recordGates,
} from "./commands/gate-health.js";
export { mintId } from "./commands/id.js";
export {
  detectSetup,
  detectVerification,
  type InitOptions,
  type InitResult,
  init,
} from "./commands/init.js";
export { runLocal, useStage } from "./commands/local.js";
export {
  DEFAULT_STAGE,
  type LoginFlags,
  type LoginOptions,
  type LoginResult,
  login,
  resolveProfile,
} from "./commands/login.js";
export { type LogoutOptions, type LogoutResult, logout } from "./commands/logout.js";
export {
  githubInstall,
  githubRemove,
  githubStatus,
  orgOf,
  providersSet,
  providersStatus,
} from "./commands/org-remote.js";
export {
  type PlanCheckResult,
  type PlanOptions,
  planCheck,
  planRatify,
} from "./commands/plan.js";
export { type PreflightOptions, preflight } from "./commands/preflight.js";
export { createProject, type ProjectCreateOptions } from "./commands/project-create.js";
export {
  assertRemoteReady,
  dispatchRun,
  REMOTE_NEEDS_PLAN,
  type RemoteOptions,
  remoteCancel,
  remoteResume,
  remoteStatus,
} from "./commands/remote.js";
export { type ResumeOptions, resume } from "./commands/resume.js";
export { REMOTE_REFUSAL, type RunOptions, type RunResult, run } from "./commands/run.js";
export { ACTIVE_ORG_CLAIM, type WhoamiOrg, type WhoamiResult, whoami } from "./commands/whoami.js";
export {
  type BrowserOpener,
  type CliAssets,
  type CliEnvironment,
  createCliEnvironment,
  type Exec,
  type Launch,
  type Write,
} from "./environment.js";
export {
  describeFailure,
  type Failure,
  type FailureCode,
  failureLines,
  UsageError,
} from "./failures.js";
export {
  fingerprintAtCommit,
  gitBlobReader,
  type ReadBlob,
  sha256Bytes,
} from "./gate-fingerprint.js";
export {
  AuthorizationRefusedError,
  CALLBACK_PATH,
  CallbackTimeoutError,
  DEFAULT_CALLBACK_TIMEOUT_MS,
  LOOPBACK_CALLBACK_URL,
  LOOPBACK_HOST,
  LOOPBACK_PORT,
  type Loopback,
  type LoopbackOptions,
  PortUnavailableError,
  startLoopback,
} from "./loopback.js";
export {
  API_SCOPE,
  type AuthorizeUrlInput,
  authorizeEndpointFor,
  authorizeUrl,
  describeTokenFailure,
  type ExchangedTokens,
  type ExchangeInput,
  exchangeAuthorizationCode,
  revokeEndpointFor,
  revokeRefreshToken,
  SCOPES,
  TokenExchangeError,
  tokenEndpointFor,
} from "./oauth.js";
export {
  assertState,
  CODE_CHALLENGE_METHOD,
  challengeFor,
  createPkce,
  createState,
  type Pkce,
  type RandomBytes,
  StateMismatchError,
  VERIFIER_BYTES,
  VERIFIER_MAX_LENGTH,
  VERIFIER_MIN_LENGTH,
} from "./pkce.js";
export {
  CONTRACT_FILE,
  isProgramDirectoryName,
  PLAN_FILE,
  type ProgramFiles,
  readConfig,
  readProgramFiles,
} from "./program-files.js";
export { type FreshSession, openFreshSession, openSession, type Session } from "./session.js";
