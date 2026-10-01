/**
 * Which transcript a planning session is, and what it says (P14, D-P14-07).
 *
 * `nightshift plan conversation` runs in a command the planning harness
 * started, so the harness's own environment names its session. Asked for a
 * file by path, the first line says which harness wrote it. Nothing is written:
 * the transcript is only ever read, on this machine.
 */
import { readFile } from "node:fs/promises";
import type { ConversationSession } from "@nightshift/core";
import type { TranscriptLocateInput, TranscriptSource } from "@nightshift/harness";

export class TranscriptNotFound extends Error {}

export interface ReadTranscriptInput extends TranscriptLocateInput {
  readonly sources: readonly TranscriptSource[];
  /** A transcript named explicitly, instead of the current session's. */
  readonly session?: string;
}

const firstLine = (text: string): string => text.split("\n", 1)[0] ?? "";

export const readTranscript = async (input: ReadTranscriptInput): Promise<ConversationSession> => {
  if (input.session !== undefined) {
    let text: string;
    try {
      text = await readFile(input.session, "utf8");
    } catch (cause) {
      throw new TranscriptNotFound(
        `cannot read ${input.session}: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
    const source = input.sources.find((candidate) => candidate.recognises(firstLine(text)));
    if (source === undefined) {
      throw new TranscriptNotFound(
        `${input.session} is not a transcript this build can read (${input.sources.map((s) => s.harness).join(", ")})`,
      );
    }
    return source.parse(text, input.session);
  }
  for (const source of input.sources) {
    const path = await source.current(input);
    if (path !== undefined) return source.parse(await readFile(path, "utf8"), path);
  }
  throw new TranscriptNotFound(
    "this is not running inside a planning session this build can read " +
      "(Claude Code names it in CLAUDE_CODE_SESSION_ID, Codex in CODEX_THREAD_ID); " +
      "name the transcript with --session <path>",
  );
};
