/**
 * The Claude Code session transcript (P14, D-P14-07).
 *
 * Claude Code keeps each session as JSON lines in
 * `<config>/projects/<the directory, flattened>/<session id>.jsonl`, and names
 * the session to every command it runs in `CLAUDE_CODE_SESSION_ID`. Verified
 * against Claude Code 2.1.
 *
 * What a person saw is read out of it: their own prompts, the answers they gave
 * to the assistant's multiple-choice questions (with any note they typed), and
 * the assistant's text. Tool calls and their output, reasoning, side chains,
 * compaction summaries, slash-command echoes, task notifications and injected
 * reminders are not the conversation and are left out.
 */
import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ConversationMessage, ConversationSession } from "@nightshift/core";
import type { TranscriptLocateInput, TranscriptSource } from "@nightshift/harness";

export const CLAUDE_TRANSCRIPT_HARNESS = "claude";

interface Block {
  readonly type?: string;
  readonly text?: string;
  readonly name?: string;
  readonly input?: {
    readonly questions?: readonly {
      readonly question?: string;
      readonly options?: readonly { readonly label?: string; readonly description?: string }[];
    }[];
  };
}

interface Entry {
  readonly type?: string;
  readonly sessionId?: string;
  readonly timestamp?: string;
  readonly isMeta?: boolean;
  readonly isSidechain?: boolean;
  readonly isCompactSummary?: boolean;
  readonly message?: { readonly content?: string | readonly Block[] };
  readonly toolUseResult?: {
    readonly questions?: readonly { readonly question?: string; readonly header?: string }[];
    readonly answers?: Readonly<Record<string, string>>;
    readonly annotations?: Readonly<Record<string, { readonly notes?: string }>> | null;
  };
}

/** Text Claude Code writes into the user's turn that the user did not type. */
const NOT_TYPED = [
  "<task-notification>",
  "<command-name>",
  "<command-message>",
  "<command-args>",
  "<local-command-",
  "<bash-input>",
  "<bash-stdout>",
  "<bash-stderr>",
  "[Request interrupted",
  "Caveat: The messages below were generated",
];

const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

const typedText = (text: string): string | undefined => {
  const cleaned = text.replace(REMINDER, "").trim();
  if (cleaned === "" || NOT_TYPED.some((prefix) => cleaned.startsWith(prefix))) return undefined;
  return cleaned;
};

const parseLine = (line: string): Entry | undefined => {
  try {
    const value: unknown = JSON.parse(line);
    return value !== null && typeof value === "object" ? (value as Entry) : undefined;
  } catch {
    return undefined;
  }
};

const renderQuestions = (block: Block): string =>
  (block.input?.questions ?? [])
    .map((question) =>
      [
        question.question ?? "",
        ...(question.options ?? []).map(
          (option) =>
            `- ${option.label ?? ""}${option.description ? `: ${option.description}` : ""}`,
        ),
      ].join("\n"),
    )
    .join("\n\n");

/** The human's answers to a multiple-choice question, and the notes they typed. */
const renderAnswers = (result: NonNullable<Entry["toolUseResult"]>): string | undefined => {
  const answers = result.answers ?? {};
  const questions = Object.keys(answers);
  if (questions.length === 0) return undefined;
  return questions
    .map((question) => {
      const header = result.questions?.find((q) => q.question === question)?.header;
      const answer = answers[question] ?? "";
      const notes = result.annotations?.[question]?.notes?.trim();
      return [
        questions.length > 1 && header !== undefined ? `${header}: ${answer}` : answer,
        ...(notes === undefined || notes === "" ? [] : [notes]),
      ].join("\n\n");
    })
    .join("\n\n");
};

/** A session's transcript as the messages a person saw, numbered from 1. */
export const parseClaudeTranscript = (text: string, path: string): ConversationSession => {
  const messages: ConversationMessage[] = [];
  let sessionId = basename(path).replace(/\.jsonl$/, "");
  let pending: { parts: string[]; at?: string } | undefined;

  const push = (role: ConversationMessage["role"], body: string, at: string | undefined): void => {
    messages.push({
      index: messages.length + 1,
      role,
      text: body,
      ...(at === undefined ? {} : { at }),
    });
  };
  const flush = (): void => {
    if (pending !== undefined && pending.parts.length > 0) {
      push("assistant", pending.parts.join("\n\n"), pending.at);
    }
    pending = undefined;
  };
  const say = (part: string, at: string | undefined): void => {
    pending ??= at === undefined ? { parts: [] } : { parts: [], at };
    pending.parts.push(part);
  };

  for (const line of text.split("\n")) {
    const entry = parseLine(line);
    if (entry === undefined || entry.isSidechain === true) continue;
    if (entry.sessionId !== undefined) sessionId = entry.sessionId;
    const content = entry.message?.content;

    if (entry.type === "assistant" && Array.isArray(content)) {
      for (const block of content as readonly Block[]) {
        if (block.type === "text" && (block.text ?? "").trim() !== "") {
          say((block.text ?? "").trim(), entry.timestamp);
        } else if (block.type === "tool_use" && block.name === "AskUserQuestion") {
          say(renderQuestions(block), entry.timestamp);
        }
      }
      continue;
    }
    if (entry.type !== "user" || entry.isMeta === true || entry.isCompactSummary === true) continue;

    if (entry.toolUseResult?.answers !== undefined) {
      const answered = renderAnswers(entry.toolUseResult);
      if (answered !== undefined) {
        flush();
        push("human", answered, entry.timestamp);
      }
      continue;
    }
    const raw =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? (content as readonly Block[])
              .filter((block) => block.type === "text")
              .map((block) => block.text ?? "")
              .join("\n\n")
          : "";
    const typed = typedText(raw);
    if (typed === undefined) continue;
    flush();
    push("human", typed, entry.timestamp);
  }
  flush();
  return { harness: CLAUDE_TRANSCRIPT_HARNESS, sessionId, messages };
};

/** Where Claude Code keeps its projects: `CLAUDE_CONFIG_DIR`, or `~/.claude`. */
const projectsDir = (input: TranscriptLocateInput): string =>
  join(input.env.CLAUDE_CONFIG_DIR ?? join(input.home, ".claude"), "projects");

/** The file of the session named by `CLAUDE_CODE_SESSION_ID`, in whichever project directory holds it. */
export const currentClaudeTranscript = async (
  input: TranscriptLocateInput,
): Promise<string | undefined> => {
  const sessionId = input.env.CLAUDE_CODE_SESSION_ID;
  if (sessionId === undefined || !/^[A-Za-z0-9-]+$/.test(sessionId)) return undefined;
  const root = projectsDir(input);
  let projects: string[];
  try {
    projects = await readdir(root);
  } catch {
    return undefined;
  }
  for (const project of projects) {
    const candidate = join(root, project, `${sessionId}.jsonl`);
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      // Not in this project directory.
    }
  }
  return undefined;
};

export const claudeTranscriptSource: TranscriptSource = {
  harness: CLAUDE_TRANSCRIPT_HARNESS,
  current: currentClaudeTranscript,
  // A Codex rollout's every line carries a `payload`; a Claude Code entry never does.
  recognises: (firstLine) => {
    const entry = parseLine(firstLine);
    return entry !== undefined && typeof entry.type === "string" && !("payload" in entry);
  },
  parse: parseClaudeTranscript,
};
