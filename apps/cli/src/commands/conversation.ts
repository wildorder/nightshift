/**
 * `nightshift plan conversation` (P14, D-P14-05 … D-P14-07).
 *
 *   nightshift plan conversation <program> [--list]
 *   nightshift plan conversation <program> --keep 3,5-7 [--summary <file>]
 *   nightshift plan conversation <program> --summary <file>
 *
 * Keeps the planning conversation in the plan draft's next version, as its conversation document: a
 * summary, and the exchanges that shaped the plan, word for word. The planning
 * skill **chooses** (message numbers from `--list`, and a summary it wrote); this
 * command **copies**, from the harness's own transcript, so no excerpt can be a
 * paraphrase. The transcript is read through `nightshift-transcript`, started as
 * a process because reading it is a harness's code. It is only read: nothing
 * but the chosen messages is written, and only here.
 */
import { readFile } from "node:fs/promises";
import {
  type ConversationSession,
  emptyConversation,
  keepMessages,
  parseConversation,
  parseSelection,
  renderConversation,
} from "@nightshift/core";
import { createHttpPlanning } from "@nightshift/persistence/http";
import type { CliEnvironment } from "../environment.js";
import { UsageError } from "../failures.js";
import { isProgramDirectoryName, resolveFrom } from "../program-files.js";
import { openSession } from "../session.js";
import { configAt, resolveScope } from "./plan.js";

export interface ConversationOptions {
  readonly id: string;
  /** Where `nightshift.config.json` is, if one is at hand. */
  readonly repo?: string;
  readonly project?: string;
  /** Message numbers to keep, `3,5-7`. */
  readonly keep?: string;
  /** A file holding the summary, which replaces the one kept. */
  readonly summary?: string;
  /** A transcript by path, instead of the current session's. */
  readonly session?: string;
}

/**
 * Whether this program keeps its conversation: the latest version's contract's
 * word, else the repository config's if one is at hand, else yes (D-P14-06).
 * Read raw, because the first round of planning comes before the contract is whole.
 */
const keeps = async (
  environment: CliEnvironment,
  repo: string | undefined,
  contractText: string,
): Promise<boolean> => {
  try {
    const stated = (JSON.parse(contractText) as { keepConversation?: unknown }).keepConversation;
    if (typeof stated === "boolean") return stated;
  } catch {
    // A contract mid-draft that does not parse says nothing about this.
  }
  return (await configAt(environment, repo))?.keepConversation !== false;
};

const readSession = async (
  environment: CliEnvironment,
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
    { cwd: environment.cwd },
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
  const signedIn = await openSession(environment);
  const scope = await resolveScope(environment, signedIn, options);
  const planning = createHttpPlanning({ transport: signedIn.transport });
  const latest = await planning.getVersion(scope);
  if (latest === undefined) {
    throw new UsageError(
      `the plane has no draft of \`${options.id}\``,
      "Put a version first: nightshift plan put <program> --dir <scratch>.",
    );
  }
  const document = async (ref: { readonly sha256: string }): Promise<string> => {
    const found = await planning.planDocument(scope, ref.sha256);
    if (found === undefined) throw new UsageError(`the plane holds no document ${ref.sha256}`);
    return found.text;
  };
  const contractText = await document(latest.version.contract);
  if (!(await keeps(environment, options.repo, contractText))) {
    environment.err(
      `${options.id} keeps no planning conversation (keepConversation is false), so nothing was read or written.`,
    );
    return 1;
  }
  const existingText =
    latest.version.conversation === undefined
      ? undefined
      : await document(latest.version.conversation);
  const existing =
    existingText === undefined
      ? emptyConversation(options.id)
      : parseConversation(options.id, existingText);
  const session = await readSession(environment, options.session);
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
  const stored = await planning.putVersion(
    scope,
    {
      contract: contractText,
      planText: await document(latest.version.plan),
      conversationText: renderConversation(next),
    },
    latest.version.version,
  );

  const added = chosen.filter((index) => !keptHere.has(index)).length;
  const total = next.sessions.reduce((sum, kept) => sum + kept.kept.length, 0);
  environment.out(
    `kept ${added} more ${added === 1 ? "message" : "messages"} from this session in version ${stored.version.version} of ${options.id} (${total} in all)` +
      `${summary === undefined ? "" : "; summary replaced"}.`,
  );
  environment.out(
    "Read it with `nightshift plan show --dir`: cut anything you would rather not keep, but do not reword an excerpt.",
  );
  return 0;
};
