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
  buildCodexArgs,
  buildGitGuard,
  CODEX_COMMAND,
  type CodexCommandInput,
  codexBriefAddendum,
  codexPrompt,
  FORBIDDEN_GIT_SUBCOMMANDS,
  mcpOverrides,
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
export type {
  AdapterFileSystem,
  SpawnedChild,
  SpawnLike,
  SpawnOptions,
  TranscriptSink,
} from "./process.js";
export {
  createStreamInterpreter,
  type StreamInterpreter,
  type StreamOutcome,
} from "./stream.js";
