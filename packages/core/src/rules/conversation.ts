/**
 * The kept planning conversation (P14, D-P14-05 … D-P14-07).
 *
 * `docs/programs/{id}/conversation.md` holds a **summary** of how the plan came
 * about, written by the planning model and labelled as its own, and
 * **excerpts**: the exchanges that shaped the plan, copied from the harness's
 * transcript word for word. The skill chooses which messages by number; the CLI
 * copies them. So an excerpt can be cut by the human but never paraphrased by a
 * model, and a story's quote can be held to it (D-P14-04).
 *
 * Everything here is pure: reading a transcript is a harness's (AR-2), writing
 * the file is the CLI's.
 */

export const CONVERSATION_FILE = "conversation.md";

export type ConversationRole = "human" | "assistant";

/** One message as the human saw it: never a tool call, its output, or reasoning. */
export interface ConversationMessage {
  /** Its number in the session, from 1, as `plan conversation --list` shows it. */
  readonly index: number;
  readonly role: ConversationRole;
  readonly text: string;
  /** ISO timestamp, when the transcript has one. */
  readonly at?: string;
}

/** A harness session's human and assistant messages, in order. */
export interface ConversationSession {
  /** The harness that ran it: `claude`, `codex`. */
  readonly harness: string;
  readonly sessionId: string;
  readonly messages: readonly ConversationMessage[];
}

export interface KeptSession {
  readonly harness: string;
  readonly sessionId: string;
  /** How many messages the session had when it was last kept from. */
  readonly total: number;
  readonly kept: readonly ConversationMessage[];
}

export interface KeptConversation {
  readonly programId: string;
  readonly summary: string;
  readonly sessions: readonly KeptSession[];
}

// --- credentials ---------------------------------------------------------------

const CREDENTIALS: readonly { readonly kind: string; readonly pattern: RegExp }[] = [
  {
    kind: "private key",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  { kind: "AWS access key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  {
    kind: "AWS secret key",
    pattern: /(?<=aws_secret_access_key["']?\s*[=:]\s*["']?)[A-Za-z0-9/+=]{40}/gi,
  },
  { kind: "GitHub token", pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/g },
  { kind: "GitHub token", pattern: /\bgithub_pat_[A-Za-z0-9_]{22,}/g },
  { kind: "Anthropic key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { kind: "OpenAI key", pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g },
  { kind: "Stripe key", pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { kind: "Slack token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { kind: "Google API key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: "JWT", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
];

/**
 * Anything shaped like a credential, replaced by what kind it looked like
 * (D-P14-05). A net, not a guarantee: the human reads the file before it is
 * committed.
 */
export const maskCredentials = (
  text: string,
): { readonly text: string; readonly masked: number } => {
  let masked = 0;
  let result = text;
  for (const { kind, pattern } of CREDENTIALS) {
    result = result.replace(pattern, () => {
      masked += 1;
      return `[masked ${kind}]`;
    });
  }
  return { text: result, masked };
};

// --- choosing ------------------------------------------------------------------

/**
 * Message numbers from a selection like `3,7-9,12`. Refuses a number the
 * session does not have, so a stale list cannot keep the wrong message.
 */
export const parseSelection = (selection: string, total: number): readonly number[] => {
  const chosen = new Set<number>();
  for (const part of selection.split(",").map((piece) => piece.trim())) {
    if (part === "") continue;
    const range = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(part);
    if (range === null) throw new Error(`"${part}" is not a message number or a range like 3-7`);
    const from = Number(range[1]);
    const to = range[2] === undefined ? from : Number(range[2]);
    if (from < 1 || to > total || from > to) {
      throw new Error(`"${part}" is outside this session's messages, 1 to ${total}`);
    }
    for (let index = from; index <= to; index += 1) chosen.add(index);
  }
  return [...chosen].sort((a, b) => a - b);
};

/**
 * The conversation with `chosen` messages of `session` kept, and `summary` when
 * one is given. A session already kept from is extended, never duplicated: a
 * message already there keeps its text as it is in the file, which the human
 * may have cut.
 */
export const keepMessages = (
  conversation: KeptConversation,
  session: ConversationSession,
  chosen: readonly number[],
  summary?: string,
): KeptConversation => {
  const byIndex = new Map(session.messages.map((message) => [message.index, message]));
  const existing = conversation.sessions.find(
    (candidate) =>
      candidate.harness === session.harness && candidate.sessionId === session.sessionId,
  );
  const kept = new Map((existing?.kept ?? []).map((message) => [message.index, message]));
  for (const index of chosen) {
    const message = byIndex.get(index);
    if (message === undefined) throw new Error(`this session has no message ${index}`);
    if (!kept.has(index)) {
      kept.set(index, { ...message, text: maskCredentials(message.text).text });
    }
  }
  const next: KeptSession = {
    harness: session.harness,
    sessionId: session.sessionId,
    total: Math.max(session.messages.length, existing?.total ?? 0),
    kept: [...kept.values()].sort((a, b) => a.index - b.index),
  };
  return {
    programId: conversation.programId,
    summary: summary ?? conversation.summary,
    sessions:
      existing === undefined
        ? [...conversation.sessions, next]
        : conversation.sessions.map((candidate) => (candidate === existing ? next : candidate)),
  };
};

// --- the file ------------------------------------------------------------------

const HARNESS_NAMES: Readonly<Record<string, string>> = { claude: "Claude", codex: "Codex" };

const speaker = (harness: string, role: ConversationRole): string =>
  role === "human" ? "Human" : (HARNESS_NAMES[harness] ?? harness);

/** `2026-09-30T14:02:11.000Z` as `2026-09-30 14:02 UTC`. */
const when = (at: string | undefined): string => {
  if (at === undefined) return "";
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(at);
  return match === null ? "" : ` · ${match[1]} ${match[2]} UTC`;
};

const SESSION_MARK = /^<!-- nightshift:session (\S+) (\S+) (\d+) -->$/;
const MESSAGE_MARK = /^<!-- nightshift:message (\d+) (human|assistant)(?: (\S+))? -->$/;
const SUMMARY_HEADING = "## Summary";
const EXCERPTS_HEADING = "## Excerpts";

export const emptyConversation = (programId: string): KeptConversation => ({
  programId,
  summary: "",
  sessions: [],
});

/** The file as it is written. Pure: the same conversation always gives the same bytes. */
export const renderConversation = (conversation: KeptConversation): string => {
  const lines: string[] = [
    `# Planning conversation: ${conversation.programId}`,
    "",
    "<!--",
    "  Kept by `nightshift plan conversation`. The summary is the planning model's.",
    "  The excerpts are copied word for word from the planning session, and only the",
    "  exchanges that shaped the plan are kept. Cut anything you would rather not",
    "  keep before committing; do not reword an excerpt, a story's quote is checked",
    "  against it.",
    "-->",
    "",
    SUMMARY_HEADING,
    "",
    conversation.summary.trim() === "" ? "*No summary yet.*" : conversation.summary.trim(),
    "",
    EXCERPTS_HEADING,
    "",
  ];
  for (const session of conversation.sessions) {
    lines.push(
      `<!-- nightshift:session ${session.harness} ${session.sessionId} ${session.total} -->`,
      `### ${HARNESS_NAMES[session.harness] ?? session.harness} session \`${session.sessionId.slice(0, 8)}\``,
      "",
      `*Kept ${session.kept.length} of ${session.total} messages; the rest led to nothing in the plan.*`,
      "",
    );
    for (const message of session.kept) {
      lines.push(
        `<!-- nightshift:message ${message.index} ${message.role}${message.at === undefined ? "" : ` ${message.at}`} -->`,
        `**${speaker(session.harness, message.role)}**${when(message.at)}`,
        "",
        message.text.trim(),
        "",
      );
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
};

/**
 * The file read back. Structure comes from the markers alone, so the human can
 * cut text, or whole messages with their marker, and it still reads.
 */
export const parseConversation = (programId: string, text: string): KeptConversation => {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const summaryAt = lines.indexOf(SUMMARY_HEADING);
  const excerptsAt = lines.indexOf(EXCERPTS_HEADING);
  const summary =
    summaryAt === -1
      ? ""
      : lines
          .slice(summaryAt + 1, excerptsAt === -1 ? lines.length : excerptsAt)
          .join("\n")
          .trim();

  const sessions: {
    harness: string;
    sessionId: string;
    total: number;
    kept: ConversationMessage[];
  }[] = [];
  let message: { index: number; role: ConversationRole; at?: string; body: string[] } | undefined;
  const flush = (): void => {
    const session = sessions.at(-1);
    if (message === undefined || session === undefined) return;
    // The first line under a marker is its speaker line, which the file writes.
    const body = message.body.slice(message.body[0]?.startsWith("**") ? 1 : 0);
    session.kept.push({
      index: message.index,
      role: message.role,
      text: body.join("\n").trim(),
      ...(message.at === undefined ? {} : { at: message.at }),
    });
    message = undefined;
  };
  for (const line of excerptsAt === -1 ? [] : lines.slice(excerptsAt + 1)) {
    const sessionMark = SESSION_MARK.exec(line);
    if (sessionMark !== null) {
      flush();
      sessions.push({
        harness: sessionMark[1] ?? "",
        sessionId: sessionMark[2] ?? "",
        total: Number(sessionMark[3]),
        kept: [],
      });
      continue;
    }
    const messageMark = MESSAGE_MARK.exec(line);
    if (messageMark !== null) {
      flush();
      message = {
        index: Number(messageMark[1]),
        role: messageMark[2] as ConversationRole,
        ...(messageMark[3] === undefined ? {} : { at: messageMark[3] }),
        body: [],
      };
      continue;
    }
    if (message !== undefined) message.body.push(line);
  }
  flush();
  return {
    programId,
    summary: summary === "*No summary yet.*" ? "" : summary,
    sessions,
  };
};

// --- quotes --------------------------------------------------------------------

const normaliseSpace = (text: string): string => text.replace(/\s+/g, " ").trim();

/**
 * Whether `quote` is something the human said, as kept: inside one of the
 * human's excerpts, differing at most in whitespace (D-P14-04).
 */
export const humanSaid = (conversation: KeptConversation, quote: string): boolean => {
  const wanted = normaliseSpace(quote);
  if (wanted === "") return false;
  return conversation.sessions.some((session) =>
    session.kept.some(
      (message) => message.role === "human" && normaliseSpace(message.text).includes(wanted),
    ),
  );
};
