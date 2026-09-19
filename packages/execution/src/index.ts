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
  DEFAULT_CANCEL_GRACE_MS,
  DEFAULT_VERIFICATION_TIMEOUT_MS,
  type ExecutionEnvironment,
  type RunSession,
  runIdOf,
  type WorkerEnvironment,
  type WorkerIdentity,
  type WorkerLaunchIdentity,
} from "./environment.js";
export * from "./git/index.js";
export { createHookSink, type HookSinkOptions } from "./hook-sink.js";
export { type IntegrateInput, type IntegrateResult, integrateNode } from "./integrate.js";
export {
  createEventOutbox,
  type EmitInput,
  type EventOutbox,
  type OutboxOptions,
} from "./outbox.js";
export {
  ConcurrencyRefusedError,
  P3_MAX_CONCURRENT_CHILDREN,
  type RunJobInput,
  recordArtifact,
  runJob,
  runningChildren,
  type StartedJob,
} from "./runner.js";
export { checkChangedPaths, describeScopeViolation, type ScopeCheck } from "./scope-check.js";
export {
  DEFAULT_FLUSH_DEADLINE_MS,
  type ShutdownInput,
  type ShutdownResult,
  shutdown,
} from "./shutdown.js";
export {
  ProgramContractChangedError,
  ProjectMissingError,
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
