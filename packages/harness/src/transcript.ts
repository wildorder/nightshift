/**
 * Reading a planning session's transcript (P14, D-P14-07).
 *
 * The planning conversation happens in the human's own harness session, and
 * each harness keeps it in a file of its own format. A `TranscriptSource` knows
 * one format: where the current session's file is, and how to read the human's
 * messages and the assistant's visible replies out of it, and nothing else (no
 * tool call, tool output or reasoning). What is kept of them is `core`'s
 * (`keepMessages`), and the file is the CLI's.
 *
 * Implemented in `harness-claude` and `harness-codex` (AR-2), and reached only
 * through `apps/mcp`'s composition root, like every harness.
 */
import type { ConversationSession } from "@nightshift/core";

export interface TranscriptLocateInput {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The repository the planning session runs in. */
  readonly cwd: string;
  readonly home: string;
}

export interface TranscriptSource {
  /** The harness id, as `ConversationSession.harness` records it: `claude`, `codex`. */
  readonly harness: string;
  /**
   * The transcript of the session this process was started from, when the
   * environment names it; `undefined` when this is not that harness's session.
   */
  readonly current: (input: TranscriptLocateInput) => Promise<string | undefined>;
  /** Whether a transcript file is this harness's, from its first line. */
  readonly recognises: (firstLine: string) => boolean;
  /** The human's and the assistant's visible messages, numbered from 1. */
  readonly parse: (text: string, path: string) => ConversationSession;
}
