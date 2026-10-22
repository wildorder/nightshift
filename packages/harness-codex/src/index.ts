/**
 * `@nightshift/harness-codex` — the Codex adapter (P5, D-P5-02).
 *
 * Start at `adapter.ts` for the `Harness` implementation and the measured exit
 * mapping, `command.ts` for the exact command line and the git guard, and
 * `stream.ts` for how `codex exec --json` becomes hook events.
 *
 * Imported by one module in the whole repository: `apps/mcp/src/compose.ts`.
 */
export {
  CODEX_HARNESS_ID,
  type CodexHarnessOptions,
  createCodexHarness,
  SPAWN_FAILURE_EXIT_CODE,
} from "./adapter.js";
export {
  boundedGaps,
  type CaptureInput,
  type CaptureResult,
  type CoverageInput,
  type CoverageVerdict,
  childThreadIds,
  codexCoverage,
  parentThreadId,
  reconcileCapture,
} from "./capture.js";
export {
  beginCapture,
  type CaptureRun,
  type CaptureRunDeps,
  type CaptureSummary,
  captureEnvironment,
  type StartReceiver,
} from "./capture-run.js";
export {
  buildCodexArgs,
  buildGitGuard,
  CODEX_COMMAND,
  type CodexCommandInput,
  type CodexOtelTarget,
  codexBriefAddendum,
  codexPrompt,
  FORBIDDEN_GIT_SUBCOMMANDS,
  mcpOverrides,
  otelOverrides,
  tomlArray,
  tomlInlineTable,
  tomlString,
  VERIFIED_CODEX_VERSION,
} from "./command.js";
export {
  CODEX_ENV_ALLOWLIST,
  envAllowlistFor,
  type SanitizeCodexEnvironmentInput,
  sanitizeCodexEnvironment,
} from "./environment.js";
export {
  buildCapabilityMatrix,
  type CapabilityDimension,
  type CapabilityFacts,
  type CapabilityMatrix,
  codexLauncherFor,
  codexLiveProbeGate,
  codexOfflineProbeGate,
  type DimensionStatus,
  type FakeResponsesProvider,
  fakeResponsesProvider,
  MEASUREMENT_FIXTURES_ENV,
  MEASUREMENT_PROBE_ENV,
  type OfflineProbeDeps,
  PROBE_ALLOW_VERSION_ENV,
  type ProbeGate,
  type ProviderStep,
  type ProviderUsage,
  STANDARD_DIMENSIONS,
  sanitizeJournalLine,
  sanitizeRolloutLine,
  syntheticUsage,
  writeCapabilityMatrix,
} from "./probe.js";
export type {
  AdapterFileSystem,
  SpawnedChild,
  SpawnLike,
  SpawnOptions,
  TranscriptSink,
} from "./process.js";
export {
  CODEX_ROLLOUT_READER_VERSION,
  findRolloutIn,
  type LaunchBoundary,
  locateRollout,
  type RolloutFacts,
  type RolloutFs,
  type RolloutRead,
  type RolloutRecord,
  type RolloutUsage,
  readRolloutMetadata,
  rolloutObservations,
} from "./rollout.js";
export {
  createStreamInterpreter,
  type StreamInterpreter,
  type StreamOutcome,
} from "./stream.js";
export {
  CODEX_OTEL_ATTRIBUTES,
  CODEX_OTEL_RECORD_FILTER,
  CODEX_VERIFIED_NATIVE_CHILDREN,
  CODEX_VERIFIED_TRANSPORTS,
  type CodexApiAttempt,
  type CodexCompletedResponse,
  type CodexConversationEvidence,
  type CodexLossReason,
  type CodexTelemetryEvidence,
  type CodexTransport,
  decodeCodexTelemetry,
  type ExcludedCompletions,
  telemetryObservations,
} from "./telemetry.js";
export {
  CODEX_TRANSCRIPT_HARNESS,
  codexTranscriptSource,
  currentCodexTranscript,
  parseCodexTranscript,
} from "./transcript.js";
