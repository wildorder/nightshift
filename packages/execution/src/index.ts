/**
 * `@nightshift/execution` — the machinery that turns a validated Job Contract
 * into an integrated, checkpointed commit.
 *
 * Depends on `@nightshift/contracts`, `@nightshift/core`, `@nightshift/harness`
 * and `@nightshift/verification`, and on nothing else. **No adapter and no
 * provider SDK**: the stores, the artifact body store, the harness, the clock,
 * the identifier generator, the paths and the `git` runner all arrive injected,
 * so this package cannot know whether it is talking to DynamoDB or to a loopback
 * server, or driving Claude Code or a scripted stand-in. Only an application's
 * composition root names a concrete one, and the architecture tests enforce it
 * (SC-P3-14).
 *
 * Where to start:
 *
 * - `runner.ts` — the lifecycle of contract §4.3, and the order of writes that
 *   makes SC-P3-02 true.
 * - `worker.ts` — the worker-side half: what a completed job *is*.
 * - `verify.ts` — the only writer of a `Verification` (D-P3-06).
 * - `integrate.ts` — seal, fast-forward, checkpoint (D-P3-05).
 * - `outbox.ts` — ordered, retrying, spilling event delivery (D-P3-10).
 * - `start-run.ts` — the one function `nightshift run` and `run.start` share.
 */

export {
  type CarryOverEnvironment,
  type CarryOverInput,
  carriedStrandsFor,
} from "./carry-over.js";
export { routingDataset } from "./dataset.js";
export {
  createEngine,
  DEFAULT_DISCOVERY_INTERVAL_MS,
  type DisputeResult,
  type Engine,
  type EngineOptions,
  type EngineSnapshot,
  FixLimitError,
  type RouteContext,
  type RoutePins,
  StrandBlockedError,
  StrandDelegationError,
  type Submission,
  type Submitted,
  type WaitingReason,
} from "./engine.js";
export {
  DEFAULT_CANCEL_GRACE_MS,
  DEFAULT_VERIFICATION_TIMEOUT_MS,
  type ExaminationServices,
  type ExecutionEnvironment,
  type LandingEnvironment,
  type PrerequisiteBook,
  type RunSession,
  runIdOf,
  type WorkerEnvironment,
  type WorkerIdentity,
  type WorkerLaunchIdentity,
} from "./environment.js";
export {
  arbitrateAll,
  carriedExamination,
  describeBlocking,
  EXAMINATION_CONTEXT_ENV,
  type ExaminationContext,
  type ExaminationOutcome,
  examine,
  examineInQueue,
  fixAttemptOf,
  fixOf,
  latestExamination,
  parseAnswers,
  patchIdOf,
  RULING_CHOICES,
  RULING_CONTEXT_ENV,
  type RulingContext,
} from "./examine.js";
export {
  type AuditedGate,
  auditGates,
  type GateAudit,
  type GateAuditInput,
  type GateVerdict,
  outputTail,
} from "./gate-audit.js";
export * from "./git/index.js";
export { createHookSink, type HookSinkOptions } from "./hook-sink.js";
export { type IntegrateInput, type IntegrateResult, integrateNode } from "./integrate.js";
export { createMergeQueue, type MergeQueue } from "./merge-queue.js";
export {
  createEventOutbox,
  type EmitInput,
  type EventOutbox,
  type OutboxOptions,
} from "./outbox.js";
export {
  PREFLIGHT_TIMEOUT_MS,
  type PreflightCheck,
  type PreflightInput,
  type PreflightResult,
  runPreflight,
} from "./preflight.js";
export * from "./publish.js";
export {
  deferredLine,
  type ResumeResult,
  type ResumeSession,
  resumeDeferred,
} from "./resume.js";
export {
  type DelegateJobInput,
  delegateJob,
  type IntegrateCandidate,
  type IntegrationCandidate,
  MAX_UNREPORTED_RESUMES,
  type RunJobInput,
  recordArtifact,
  runJob,
  type StartedJob,
  type StartJobInput,
  startJob,
  stepsAs,
  verifyAndIntegrate,
} from "./runner.js";
export { checkChangedPaths, describeScopeViolation, type ScopeCheck } from "./scope-check.js";
export {
  discardScratch,
  ensureScratch,
  freshScratch,
  type RunScratchAs,
  scratchEnv,
  scratchOf,
} from "./scratch.js";
export {
  DEFAULT_FLUSH_DEADLINE_MS,
  endProgramNode,
  type ShutdownInput,
  type ShutdownResult,
  shutdown,
} from "./shutdown.js";
export {
  type StampEnvironment,
  type StampSession,
  stampJobDecisions,
  stampSettledDecisions,
} from "./stamp.js";
export {
  failBeforeStart,
  PlanChangedError,
  PlanNotRatifiedError,
  ProgramContractChangedError,
  ProjectMissingError,
  requireRatifiedPlan,
  type StartedRun,
  type StartRunEnvironment,
  type StartRunInput,
  startRun,
} from "./start-run.js";
export { type VerifyInput, type VerifyResult, verifyNode } from "./verify.js";
export {
  type CompleteJobResult,
  completeJob,
  createWorkerTools,
  failJob,
  recordWorkerDecision,
  reportProgress,
  WORKER_FLUSH_DEADLINE_MS,
} from "./worker.js";
export * from "./worker-tokens.js";
