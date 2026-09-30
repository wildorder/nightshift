/**
 * `nightshift plan conversation` (P14, D-P14-05 … D-P14-07).
 *
 *   nightshift plan conversation <program> [--list]
 *   nightshift plan conversation <program> --keep 3,5-7 [--summary <file>]
 *   nightshift plan conversation <program> --summary <file>
 *
 * Keeps the planning conversation in `docs/programs/{id}/conversation.md`: a
 * summary, and the exchanges that shaped the plan, word for word. The planning
 * skill **chooses** (message numbers from `--list`, and a summary it wrote); this
 * command **copies**, from the harness's own transcript, so no excerpt can be a
 * paraphrase. The transcript is read through `nightshift-transcript`, started as
 * a process because reading it is a harness's code. It is only read: nothing
 * but the chosen messages is written, and only here.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  NIGHTSHIFT_CONFIG_FILE,
  NightshiftConfigSchema,
  PROGRAMS_DIRECTORY,
} from "@nightshift/contracts";
import {
  CONVERSATION_FILE,
  type ConversationSession,
  emptyConversation,
  keepMessages,
  parseConversation,
  parseSelection,
  renderConversation,
} from "@nightshift/core";
import type { CliEnvironment } from "../environment.js";
import { UsageError } from "../failures.js";
import { CONTRACT_FILE, isProgramDirectoryName, resolveFrom } from "../program-files.js";

export interface ConversationOptions {
  readonly id: string;
  readonly repo?: string;
  /** Message numbers to keep, `3,5-7`. */
  readonly keep?: string;
  /** A file holding the summary, which replaces the one kept. */
  readonly summary?: string;
  /** A transcript by path, instead of the current session's. */
  readonly session?: string;
}

const readText = async (path: string): Promise<string | undefined> => {
  try {
    return await readFile(path, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw cause;
  }
};

/**
 * Whether this program keeps its conversation: its own contract's word, else
 * the repository's, else yes (D-P14-06). Read raw, because the first round of
 * planning comes before the contract is whole.
 */
const keeps = async (repoPath: string, id: string): Promise<boolean> => {
  const contractText = await readText(join(repoPath, PROGRAMS_DIRECTORY, id, CONTRACT_FILE));
  if (contractText !== undefined) {
    try {
      const stated = (JSON.parse(contractText) as { keepConversation?: unknown }).keepConversation;
      if (typeof stated === "boolean") return stated;
    } catch {
      // A contract mid-draft that does not parse says nothing about this.
    }
  }
  const configText = await readText(join(repoPath, NIGHTSHIFT_CONFIG_FILE));
  if (configText === undefined) return true;
  return NightshiftConfigSchema.parse(JSON.parse(configText)).keepConversation !== false;
};

const readSession = async (
  environment: CliEnvironment,
  repoPath: string,
  session: string | undefined,
): Promise<ConversationSession> => {
  const entry = environment.assets?.transcriptPath;
  if (environment.exec === undefined || entry === undefined) {
    throw new UsageError(
      "this build of the CLI cannot read a planning transcript",
      "It needs the Nightshift MCP app built beside it (`npm run build` in the Nightshift repository).",
    );
  }
  const result = await environment.exec(
    process.execPath,
    [entry, ...(session === undefined ? [] : ["--session", resolveFrom(environment.cwd, session)])],
    { cwd: repoPath },
  );
  const last = result.stdout.trim().split("\n").at(-1) ?? "";
  if (result.exitCode !== 0 || last === "") {
    const said = result.stderr.replace(/^\[nightshift-transcript\] /gm, "").trim();
    throw new UsageError(
      said === "" ? `reading the transcript exited ${result.exitCode}` : said,
      "Run this from the planning session itself, or name its transcript with --session <path>.",
    );
  }
  return JSON.parse(last) as ConversationSession;
};

const speaker = (session: ConversationSession, role: "human" | "assistant"): string =>
  role === "human" ? "Human" : session.harness === "codex" ? "Codex" : "Claude";

const oneLine = (text: string, width: number): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= width ? flat : `${flat.slice(0, width - 1)}…`;
};

export const planConversation = async (
  environment: CliEnvironment,
  options: ConversationOptions,
): Promise<number> => {
  if (!isProgramDirectoryName(options.id)) {
    throw new UsageError(`\`${options.id}\` is not a program id`);
  }
  const repoPath = resolveFrom(environment.cwd, options.repo ?? environment.cwd);
  if (!(await keeps(repoPath, options.id))) {
    environment.err(
      `${options.id} keeps no planning conversation (keepConversation is false), so nothing was read or written.`,
    );
    return 1;
  }
  const directory = join(repoPath, PROGRAMS_DIRECTORY, options.id);
  const path = join(directory, CONVERSATION_FILE);
  const existingText = await readText(path);
  const existing =
    existingText === undefined
      ? emptyConversation(options.id)
      : parseConversation(options.id, existingText);
  const session = await readSession(environment, repoPath, options.session);
  const keptHere = new Set(
    existing.sessions
      .filter((kept) => kept.harness === session.harness && kept.sessionId === session.sessionId)
      .flatMap((kept) => kept.kept.map((message) => message.index)),
  );

  if (options.keep === undefined && options.summary === undefined) {
    for (const message of session.messages) {
      environment.out(
        `${String(message.index).padStart(4)} ${keptHere.has(message.index) ? "*" : " "} ${speaker(session, message.role).padEnd(6)} ${oneLine(message.text, 140)}`,
      );
    }
    environment.out(
      `${session.messages.length} messages in this session; ${keptHere.size} kept (*). ` +
        `Keep the ones that led to something in the plan: nightshift plan conversation ${options.id} --keep 3,5-7 --summary <file>`,
    );
    return 0;
  }

  let chosen: readonly number[];
  try {
    chosen =
      options.keep === undefined ? [] : parseSelection(options.keep, session.messages.length);
  } catch (cause) {
    throw new UsageError(cause instanceof Error ? cause.message : String(cause));
  }
  const summary =
    options.summary === undefined
      ? undefined
      : await readFile(resolveFrom(environment.cwd, options.summary), "utf8");
  const next = keepMessages(existing, session, chosen, summary);
  await mkdir(directory, { recursive: true });
  await writeFile(path, renderConversation(next));

  const added = chosen.filter((index) => !keptHere.has(index)).length;
  const total = next.sessions.reduce((sum, kept) => sum + kept.kept.length, 0);
  environment.out(
    `kept ${added} more ${added === 1 ? "message" : "messages"} from this session in ${PROGRAMS_DIRECTORY}/${options.id}/${CONVERSATION_FILE} (${total} in all)` +
      `${summary === undefined ? "" : "; summary replaced"}.`,
  );
  environment.out(
    "Read it before committing: cut anything you would rather not keep, but do not reword an excerpt.",
  );
  return 0;
};
