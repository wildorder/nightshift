/**
 * `@nightshift/harness` — the harness adapter contract, version 1.
 *
 * Contains no provider code and imports no Node builtin: adapters spawn
 * processes, the contract does not. Its only dependencies are
 * `@nightshift/contracts` and `@nightshift/core`.
 *
 * Start at `harness.ts` for the interface an adapter implements, `tools.ts` for
 * the four worker operations, `hooks.ts` for the channel that carries ground
 * truth, and `brief.ts` for the text every worker is told.
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
export {
  nightshiftToolNames,
  promptFor,
  renderAnswerBrief,
  renderArbiterBrief,
  renderExaminerBrief,
  renderPlanFollowingBrief,
  renderSubOrchestratorBrief,
  renderWorkerBrief,
  STRAND_DEPARTURE_PREFIX,
  type WorkerBriefInput,
} from "./brief.js";
export { GATE_STANDARD } from "./gate-standard.js";
export {
  type AgentTask,
  agentStatusForExit,
  type CarriedOverWork,
  type Duration,
  describeExit,
  type ExaminationEvidence,
  type Harness,
  type HarnessCapabilities,
  type HarnessExit,
  type HarnessHandle,
  type HarnessStartInput,
  hookTypeForExit,
  type McpLaunch,
  millis,
  routeUnavailableReason,
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
export * from "./run-as.js";
export {
  NoCheckpointError,
  refusingWorkerTools,
  type WorkerCompletion,
  type WorkerDecisionInput,
  type WorkerTools,
} from "./tools.js";
export type { TranscriptLocateInput, TranscriptSource } from "./transcript.js";
