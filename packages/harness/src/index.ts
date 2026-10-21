/**
 * `@nightshift/harness` — the harness adapter contract, version 1.
 *
 * Contains no provider code: adapters spawn processes, the contract does not.
 * Its only dependencies are `@nightshift/contracts`, `@nightshift/core`, `zod`
 * and Node builtins (launcher helpers and the loopback receiver).
 *
 * Start at `harness.ts` for the interface an adapter implements, `tools.ts` for
 * the four worker operations, `hooks.ts` for the channel that carries ground
 * truth, and `brief.ts` for the text every worker is told.
 */

export {
  nightshiftToolNames,
  promptFor,
  renderAnswerBrief,
  renderArbiterBrief,
  renderExaminerBrief,
  renderForbiddenActions,
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
  countersOfExit,
  coverageOfExit,
  type Duration,
  describeExit,
  type ExaminationEvidence,
  type ExitMeasures,
  type Harness,
  type HarnessCapabilities,
  type HarnessExit,
  type HarnessHandle,
  type HarnessStartInput,
  hookTypeForExit,
  inclusionOfExit,
  isoFromEpochSeconds,
  type McpLaunch,
  millis,
  type ProgramRuling,
  routeUnavailableReason,
  type StrandContinuation,
  usageOfExit,
  usageScopeOfExit,
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
export {
  type HarnessObservation,
  type MeasurementSink,
  nullMeasurementSink,
  recordingMeasurementSink,
} from "./measurement.js";
export * from "./node-cli.js";
export { type DurableFs, durableAppend } from "./receiver/durable-append.js";
export {
  type ReceiverEnvelope,
  type ReceiverGap,
  type ReceiverRecord,
  readReceiverJournal,
  receiverEnvelopeSchema,
  receiverGapSchema,
  receiverRecordSchema,
} from "./receiver/journal.js";
export {
  type LocalReceiver,
  type LocalReceiverOptions,
  startLocalReceiver,
} from "./receiver/receiver.js";
export type { AttributeSpec, AttributeType } from "./receiver/reduce.js";
export * from "./run-as.js";
export {
  NoCheckpointError,
  refusingWorkerTools,
  type WorkerCompletion,
  type WorkerDecisionInput,
  type WorkerTools,
} from "./tools.js";
export type { TranscriptLocateInput, TranscriptSource } from "./transcript.js";
