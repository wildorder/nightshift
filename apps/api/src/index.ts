/**
 * `@nightshift/api` — the control-plane HTTP runtime.
 *
 * The handler is adapter-free: it depends on `NightshiftStores` from core. Only
 * the Lambda entry point that wires AWS stores may import
 * `@nightshift/persistence/aws`.
 */
export {
  ACTIVE_ORG_CLAIM,
  type ActingOrgRefusal,
  type ActingOrgResolution,
  describeRefusal,
  resolveActingOrg,
} from "./auth/acting-org.js";
export { type ApiConfig, ConfigError, loadConfig } from "./config.js";
export { DOMAIN_ERROR_STATUS, toErrorResponse } from "./errors.js";
export { handleRequest, ROUTES } from "./handler.js";
export { type ApiDeps, type ApiRequest, type ApiResponse, HttpError } from "./http.js";
export { createApiLambdaHandler } from "./lambda/api-handler.js";
