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
export { type CausesOfRetryInput, causesOfRetry, type StrandFailures } from "./causes.js";
export { routingDataset } from "./dataset.js";
export {
  type EndGatesResult,
  type FailedEndGate,
  verifyRunHead,
} from "./end-gates.js";
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
  boundEnvironmentFault,
  environmentFaultReason,
  type FaultOutputs,
  MIN_ENVIRONMENT_FAULT_TAIL_CHARS,
  type RecordEnvironmentFaultInput,
  recordEnvironmentFault,
  splitEnvironmentFault,
} from "./environment-fault.js";
export {
  arbitrateAll,
  carriedExamination,
  continuedByNightshift,
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
  deferralOf,
  type GateAudit,
  type GateAuditInput,
  type GateVerdict,
  gateVerdictOf,
  outputTail,
} from "./gate-audit.js";
export {
  type ComparedGate,
  compareWithReference,
  type GateAgreement,
  type GateComparison,
  gateAgreement,
} from "./gate-comparison.js";
export {
  fingerprintAtCommit,
  gitBlobReader,
  type ReadBlob,
  sha256Bytes,
} from "./gate-fingerprint.js";
export {
  type ContractGates,
  contractGatesAt,
  endSteps,
  type GateDefinitions,
  type GateSession,
  gateDefinitions,
  gateDefinitionsAt,
  landingSteps,
  type ReconcileGateRepairsInput,
  reconcileGateRepairs,
  withGateDefinitions,
} from "./gate-repair.js";
export * from "./git/index.js";
export { createHookSink, type HookSinkOptions } from "./hook-sink.js";
export { type IntegrateInput, type IntegrateResult, integrateNode } from "./integrate.js";
export { blockerKey, type LifecycleInput, observeLifecycle } from "./lifecycle.js";
export {
  appendJournalLine,
  durableAppend,
  type Journal,
  type JournalContext,
  JournalContextSchema,
  type JournalFs,
  type JournalLine,
  JournalLineSchema,
  type JournalOwner,
  nodeJournalFs,
  openJournal,
  readJournal,
} from "./measurement/journal.js";
export {
  createMeasurementRecorder,
  type EngineObservation,
  type MeasurementRecorder,
  type MeasurementRecorderInput,
  type MeasurementRecorderLimits,
  publishedSummaryFor,
  type StartSegmentOptions,
} from "./measurement/recorder.js";
export {
  LIVE_WINDOW_MS,
  type RecoveryOptions,
  type RecoveryResult,
  recoverMeasurementJournals,
} from "./measurement/recover.js";
export { createMergeQueue, type MergeQueue } from "./merge-queue.js";
export {
  createEventOutbox,
  type EmitInput,
  type EventOutbox,
  type OutboxOptions,
} from "./outbox.js";
export { lastChars, readableOutput, readableTail } from "./output-tail.js";
export {
  PREFLIGHT_CLEANUP_SECONDS,
  PREFLIGHT_TIMEOUT_SECONDS,
  type PreflightCheck,
  type PreflightInput,
  type PreflightResult,
  runPreflight,
} from "./preflight.js";
export {
  type ProvisionalLineEnvironment,
  type ProvisionalLineSession,
  repairProvisionalLine,
} from "./provisional-line.js";
export * from "./publish.js";
export {
  gateRedPayload,
  type RecordGateOutputsInput,
  type RecordRedBaseInput,
  recordGateOutputs,
  recordRedBase,
} from "./red-base.js";
export {
  MAX_REFERENCE_TAILS_CHARS,
  type ReferenceAuditInput,
  referenceAuditOf,
  referenceGatesOf,
} from "./reference-audit.js";
export {
  deferredLine,
  type ResumeResult,
  type ResumeSession,
  resumeDeferred,
} from "./resume.js";
export {
  createRouteAvailability,
  DEFAULT_LIMIT_COOLDOWN_MS,
  type RouteAvailability,
  type UnavailableRoute,
  unavailableUntil,
} from "./route-availability.js";
export { programRulings, rulingsCarriedBy } from "./rulings.js";
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
export {
  discardScratch,
  ensureScratch,
  freshScratch,
  projectStepEnv,
  type Reclaim,
  type ScratchPaths,
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
export {
  limitsOf,
  type RecordStepSkipInput,
  type RecordStepTimeoutInput,
  recordStepSkip,
  recordStepTimeout,
  runAdjustmentDecisions,
  runDecisions,
  runVerifications,
  StepAdjustmentRefusedError,
} from "./step-adjustments.js";
export {
  MAX_STRAND_FIX_ROUNDS,
  strandBranch,
  strandContinuing,
} from "./strand.js";
export {
  MAX_PLAN_REVIEWS,
  PLAN_REVIEW_FILE_ENV,
  type PlannedJob,
  PlannedJobSchema,
  type PlanReview,
  PlanReviewSchema,
  planProblems,
  planStateOf,
  renderPlan,
  STRAND_PLAN_CONTEXT,
  STRAND_PLAN_REVIEW_CONTEXT,
} from "./strand-plan.js";
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
