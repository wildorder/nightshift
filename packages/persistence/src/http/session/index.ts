/**
 * The local session: where Nightshift's files live, what is in them, and how the
 * operator's refresh token becomes an ID token.
 *
 * One module, shared by `apps/cli`, `apps/mcp` and `packages/execution`, so the
 * three cannot disagree about where a spool file or a credential lives.
 */
export {
  agentStateDir,
  CONFIG_DIR_ENV,
  configDir,
  createLocalPaths,
  credentialsPath,
  idTail,
  type PathEnvironment,
  profilePath,
  runStateDir,
  STATE_DIR_ENV,
  spoolPath,
  stateDir,
  transcriptPath,
  worktreePath,
} from "./paths.js";
export {
  type Credentials,
  CredentialsSchema,
  deleteCredentials,
  NotLoggedInError,
  type Profile,
  ProfileSchema,
  readCredentials,
  readProfile,
  requireCredentials,
  requireProfile,
  writeCredentials,
  writeProfile,
} from "./store.js";
export {
  createTokenProvider,
  refreshIdToken,
  staticTokenProvider,
  TOKEN_REFRESH_MARGIN_MS,
  type TokenFetch,
  type TokenProviderOptions,
  tokenClaims,
  tokenEndpointFor,
  tokenExpiry,
} from "./tokens.js";
