/**
 * The Codex session rollout (P14, D-P14-07).
 *
 * Codex keeps each session as JSON lines in
 * `<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<time>-<thread id>.jsonl` and names
 * the thread to every command it runs in `CODEX_THREAD_ID`. Verified against
 * codex-cli 0.156 and 0.159.
 *
 * The conversation is the `response_item` messages: the user's and the
 * assistant's. Developer messages, the instructions and environment Codex
 * injects into the user's turn, reasoning, tool calls and their output are not
 * the conversation and are left out. (`event_msg` repeats some messages, so it
 * is not read at all.)
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { ConversationMessage, ConversationSession } from "@nightshift/core";
import type { TranscriptLocateInput, TranscriptSource } from "@nightshift/harness";

export const CODEX_TRANSCRIPT_HARNESS = "codex";

interface Line {
  readonly timestamp?: string;
  readonly type?: string;
  readonly payload?: {
    readonly id?: string;
    readonly type?: string;
    readonly role?: string;
    readonly content?: readonly { readonly type?: string; readonly text?: string }[];
  };
}

const parseLine = (line: string): Line | undefined => {
  try {
    const value: unknown = JSON.parse(line);
    return value !== null && typeof value === "object" ? (value as Line) : undefined;
  } catch {
    return undefined;
  }
};

/** Text Codex puts into the user's turn that the user did not type. */
const INJECTED_PREFIXES = ["# AGENTS.md instructions for "];
/** A block that is one injected element, `<environment_context>…</environment_context>`. */
const INJECTED_ELEMENT = /^<([a-z_]+)>[\s\S]*<\/\1>\s*$/;

const typed = (text: string): boolean => {
  const trimmed = text.trim();
  return (
    trimmed !== "" &&
    !INJECTED_PREFIXES.some((prefix) => trimmed.startsWith(prefix)) &&
    !INJECTED_ELEMENT.test(trimmed)
  );
};

/** A rollout as the messages a person saw, numbered from 1. */
export const parseCodexTranscript = (text: string, path: string): ConversationSession => {
  const messages: ConversationMessage[] = [];
  let sessionId = /-([0-9a-f-]{36})\.jsonl$/.exec(path)?.[1] ?? path;
  for (const raw of text.split("\n")) {
    const line = parseLine(raw);
    if (line === undefined) continue;
    if (line.type === "session_meta" && line.payload?.id !== undefined) {
      sessionId = line.payload.id;
      continue;
    }
    if (line.type !== "response_item" || line.payload?.type !== "message") continue;
    const role = line.payload.role;
    if (role !== "user" && role !== "assistant") continue;
    const kind = role === "user" ? "input_text" : "output_text";
    const body = (line.payload.content ?? [])
      .filter((block) => block.type === kind && typeof block.text === "string")
      .map((block) => (block.text ?? "").trim())
      .filter((part) => (role === "user" ? typed(part) : part !== ""))
      .join("\n\n");
    if (body === "") continue;
    messages.push({
      index: messages.length + 1,
      role: role === "user" ? "human" : "assistant",
      text: body,
      ...(line.timestamp === undefined ? {} : { at: line.timestamp }),
    });
  }
  return { harness: CODEX_TRANSCRIPT_HARNESS, sessionId, messages };
};

/** The rollout of the thread named by `CODEX_THREAD_ID`. */
export const currentCodexTranscript = async (
  input: TranscriptLocateInput,
): Promise<string | undefined> => {
  const threadId = input.env.CODEX_THREAD_ID;
  if (threadId === undefined || !/^[A-Za-z0-9-]+$/.test(threadId)) return undefined;
  const root = join(input.env.CODEX_HOME ?? join(input.home, ".codex"), "sessions");
  let files: string[];
  try {
    files = await readdir(root, { recursive: true });
  } catch {
    return undefined;
  }
  const found = files.filter((file) => file.endsWith(`-${threadId}.jsonl`)).sort();
  const latest = found.at(-1);
  return latest === undefined ? undefined : join(root, latest);
};

export const codexTranscriptSource: TranscriptSource = {
  harness: CODEX_TRANSCRIPT_HARNESS,
  current: currentCodexTranscript,
  recognises: (firstLine) => {
    const line = parseLine(firstLine);
    return line !== undefined && line.payload !== undefined && typeof line.type === "string";
  },
  parse: parseCodexTranscript,
};
