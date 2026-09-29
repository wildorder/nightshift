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
  currentStage,
  currentStagePath,
  idTail,
  isStageName,
  knownStages,
  type PathEnvironment,
  profilePath,
  profilesDir,
  runStateDir,
  STATE_DIR_ENV,
  selectStage,
  spoolPath,
  stateDir,
  transcriptPath,
  worktreePath,
} from "./paths.js";
export {
  type CognitoProfile,
  CognitoProfileSchema,
  type Credentials,
  CredentialsSchema,
  deleteCredentials,
  isTokenProfile,
  NotLoggedInError,
  type Profile,
  ProfileSchema,
  readCredentials,
  readProfile,
  requireCredentials,
  requireProfile,
  type TokenProfile,
  TokenProfileSchema,
  writeCredentials,
  writeProfile,
} from "./store.js";
export {
  createTokenProvider,
  readLocalToken,
  refreshIdToken,
  staticTokenProvider,
  TOKEN_REFRESH_MARGIN_MS,
  type TokenFetch,
  type TokenProviderOptions,
  tokenClaims,
  tokenEndpointFor,
  tokenExpiry,
} from "./tokens.js";
