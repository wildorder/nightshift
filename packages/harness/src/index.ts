/**
 * `@nightshift/harness` — the harness adapter contract, version 0.
 *
 * Contains no provider code and imports no Node builtin: adapters spawn
 * processes, the contract does not. Its only dependencies are
 * `@nightshift/contracts` and `@nightshift/core`.
 *
 * Start at `harness.ts` for the interface an adapter implements, `hooks.ts` for
 * the channel that carries ground truth, and `brief.ts` for the text every
 * worker is told.
 */

export {
  grantedPermissions,
  grantsPermission,
  isWorkerPermission,
  PERMISSION_FS_READ,
  PERMISSION_FS_WRITE,
  PERMISSION_SHELL_EXEC,
  unknownPermissions,
  WORKER_PERMISSIONS,
  type WorkerPermission,
} from "@nightshift/core";
export { renderWorkerBrief, type WorkerBriefInput } from "./brief.js";
export {
  agentStatusForExit,
  type Duration,
  describeExit,
  type Harness,
  type HarnessExit,
  type HarnessHandle,
  type HarnessStartInput,
  hookTypeForExit,
  type McpLaunch,
  millis,
} from "./harness.js";
export {
  HOOK_EVENT_TYPES,
  type HookEvent,
  type HookEventType,
  type HookSink,
  isHookEventType,
  nullHookSink,
  recordingHookSink,
} from "./hooks.js";
