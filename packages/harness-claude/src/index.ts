/**
 * `@nightshift/harness-claude` — the Claude Code harness adapter (T8, D-P3-03).
 *
 * Provider-specific by design and by permission: AR-2 allows a provider's
 * command line, authentication, output format and tool policy to exist **only**
 * inside a `harness-*` package, and D-P3-12 makes `apps/mcp`'s composition
 * module the only place allowed to import this one. Nothing above the adapter
 * layer may name it.
 *
 * It drives the installed CLI, not an API: there is no `@anthropic-ai/*` import
 * and no SDK anywhere in the package. Its dependencies are Node builtins,
 * `@nightshift/contracts`, `@nightshift/core` and `@nightshift/harness`.
 *
 * Read `adapter.ts` for the `Harness` implementation and the exit mapping,
 * `command.ts` for the exact command line and the version it was verified
 * against, `permissions.ts` for D-P3-15, `stream.ts` for which lifecycle event
 * comes from where, and `conformance.ts` for the gated real-CLI run.
 */

export {
  CLAUDE_HARNESS_ID,
  type ClaudeHarnessOptions,
  createClaudeHarness,
  SPAWN_FAILURE_EXIT_CODE,
} from "./adapter.js";
export {
  buildClaudeArgs,
  buildMcpConfig,
  buildSettings,
  CLAUDE_COMMAND,
  type ClaudeCommandInput,
  claudeBriefAddendum,
  claudePrompt,
  VERIFIED_CLAUDE_VERSION,
} from "./command.js";
export {
  CLAUDE_CONFORMANCE_ENV,
  CLAUDE_CONFORMANCE_VALUE,
  type ClaudeConformanceFixture,
  type ClaudeConformanceFixtureOptions,
  type ConformanceGate,
  type ConformanceStartInput,
  claudeConformanceFixture,
  claudeConformanceGate,
} from "./conformance.js";
export {
  CLAUDE_ENV_ALLOWLIST,
  envAllowlistFor,
  HEADLESS_CLAUDE_ENV,
  POSIX_ENV_ALLOWLIST,
  type SanitizeClaudeEnvironmentInput,
  sanitizeClaudeEnvironment,
  WINDOWS_ENV_ALLOWLIST,
} from "./environment.js";
export {
  type ClaudeToolPolicy,
  claudeMcpToolName,
  claudeToolPolicy,
  FORBIDDEN_GIT_SUBCOMMANDS,
  gitWriteDenials,
} from "./permissions.js";
export {
  type AdapterFileSystem,
  type ChildOutputStream,
  killProcessTree,
  nodeFileSystem,
  nodeSpawn,
  type SpawnedChild,
  type SpawnLike,
  type SpawnOptions,
  type TranscriptSink,
} from "./process.js";
export {
  boundPayload,
  createStreamInterpreter,
  MAX_HOOK_PAYLOAD_BYTES,
  type StreamInterpreter,
  type StreamInterpreterInput,
  type StreamOutcome,
  SUBAGENT_TOOL_NAMES,
  summariseToolInput,
  summariseToolResult,
} from "./stream.js";
export {
  CLAUDE_TRANSCRIPT_HARNESS,
  claudeTranscriptSource,
  currentClaudeTranscript,
  parseClaudeTranscript,
} from "./transcript.js";
