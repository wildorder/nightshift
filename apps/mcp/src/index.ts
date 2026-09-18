/**
 * `@nightshift/mcp` — the Nightshift MCP server.
 *
 * One binary, two roles (D-P3-01). `compose.ts` is the composition root and the
 * only module here that may name an adapter (D-P3-12); everything else takes its
 * dependencies as parameters, which is what lets the slice suite run **this**
 * binary against a scripted harness.
 */
export {
  API_ENDPOINT_ENV,
  API_TOKEN_ENV,
  createRuntime,
  HARNESS_MODULE_ENV,
  harnessModuleSpecifier,
  MissingExecutionTokenError,
  type Runtime,
} from "./compose.js";
export {
  DEFAULT_JOB_WAIT_CAP_SECONDS,
  JOB_WAIT_CAP_ENV,
  registerOrchestratorTools,
} from "./orchestrator.js";
export { asRefusal, type RefusalCode, ToolRefusal } from "./results.js";
export {
  type Env,
  EXECUTION_TOKEN_ENV,
  MissingWorkerIdentityError,
  ROLE_ENV,
  type Role,
  roleFrom,
  WORKER_IDENTITY_ENV,
  workerIdentityFrom,
  workerLaunchEnv,
} from "./role.js";
export {
  type CreateServerInput,
  createNightshiftServer,
  type NightshiftServer,
  SERVER_NAME,
  SERVER_VERSION,
  SHUTDOWN_DEADLINE_MS,
} from "./server.js";
export {
  type AttachedRun,
  DEFAULT_CONTRACT_FILE,
  type OrchestratorSession,
} from "./session.js";
export { registerWorkerTools } from "./worker.js";
