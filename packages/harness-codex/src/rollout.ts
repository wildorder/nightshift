/**
 * The Codex session rollout as measurement evidence (P20 S-03).
 *
 * Reads the rollout `<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<time>-<thread id>.jsonl`
 * and nothing else about the session. METADATA ONLY: counters, identifiers and
 * timings are retained; every text field (messages, instructions, tool
 * arguments and output) is never copied out of the parsed line. Measured on
 * codex-cli 0.155.1; `CODEX_ROLLOUT_READER_VERSION` changes with the format
 * understood here.
 *
 * Three usage figures appear in a rollout and must not be confused:
 * `token_usage_record.usage` and `token_count.info.last_token_usage` are ONE
 * request; `turn_token_usage` is the turn so far; `thread_token_usage` and
 * `token_count.info.total_token_usage` are the whole thread so far, across
 * resumes. Only the request and the thread total become observations.
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { MeasurementCounters } from "@nightshift/contracts";
import type { HarnessObservation } from "@nightshift/harness";

export const CODEX_ROLLOUT_READER_VERSION = 1;

const THREAD_ID = /^[A-Za-z0-9-]+$/;

// ---------------------------------------------------------------------------
// Parsing

/** One usage object as Codex writes it. Every field is optional: absent means not reported. */
export interface RolloutUsage {
  readonly inputTokens?: number;
  /** A subset of `inputTokens`. */
  readonly cachedInputTokens?: number;
  /** A subset of `inputTokens`. */
  readonly cacheWriteInputTokens?: number;
  readonly outputTokens?: number;
  /** A subset of `outputTokens`. */
  readonly reasoningOutputTokens?: number;
  readonly totalTokens?: number;
}

interface RecordBase {
  readonly ordinal: number;
  readonly timestamp: string;
}

export type RolloutRecord =
  | (RecordBase & {
      readonly type: "session_meta";
      readonly id?: string;
      readonly sessionId?: string;
      readonly cliVersion?: string;
      readonly source?: string;
      readonly threadSource?: string;
      readonly modelProvider?: string;
      readonly parentThreadId?: string;
    })
  | (RecordBase & {
      readonly type: "task_started";
      readonly turnId?: string;
      readonly modelContextWindow?: number;
    })
  | (RecordBase & {
      readonly type: "turn_context";
      readonly turnId?: string;
      readonly model?: string;
    })
  | (RecordBase & {
      readonly type: "token_usage_record";
      readonly threadId?: string;
      readonly turnId?: string;
      readonly sessionId?: string;
      readonly rootTurnId?: string;
      readonly responseId?: string;
      /** The one request. */
      readonly usage?: RolloutUsage;
      /** The turn so far. Never an observation. */
      readonly turnTokenUsage?: RolloutUsage;
      /** The thread so far. Never an observation here. */
      readonly threadTokenUsage?: RolloutUsage;
    })
  | (RecordBase & {
      readonly type: "token_count";
      /** The thread so far (cumulative across resumes). */
      readonly totalTokenUsage?: RolloutUsage;
      /** The last request only. Never an observation. */
      readonly lastTokenUsage?: RolloutUsage;
      /** Capacity, not use. */
      readonly modelContextWindow?: number;
    })
  | (RecordBase & {
      readonly type: "task_complete";
      readonly turnId?: string;
      readonly durationMs?: number;
      readonly timeToFirstTokenMs?: number;
    })
  | (RecordBase & {
      readonly type: "turn_aborted";
      readonly turnId?: string;
      readonly reason?: string;
    })
  | (RecordBase & {
      readonly type: "spawn_call";
      readonly name: string;
      readonly callId?: string;
    })
  | (RecordBase & {
      readonly type: "collab_agent_spawn";
      /** The payload type, e.g. `collab_agent_spawn_begin`. */
      readonly event: string;
      readonly childThreadIds: readonly string[];
    })
  | (RecordBase & { readonly type: "thread_settings_applied" });

export interface RolloutRead {
  readonly records: readonly RolloutRecord[];
  /** Byte offset (UTF-8) to resume from: just past the last complete line read. */
  readonly nextByteOffset: number;
  /** One past the highest ordinal read, or `fromOrdinal` when nothing new. */
  readonly nextOrdinal: number;
  /** The text ends in an unfinished line, left for the next read. */
  readonly tornTail: boolean;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;

/** `T` with the properties that may be undefined made optional instead. */
type Defined<T> = {
  [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined>;
} & { [K in keyof T as undefined extends T[K] ? never : K]: T[K] };

/** The object without its undefined-valued properties. */
const defined = <T extends object>(value: T): Defined<T> =>
  Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Defined<T>;

const usageOf = (value: unknown): RolloutUsage | undefined =>
  isObject(value)
    ? defined({
        inputTokens: count(value.input_tokens),
        cachedInputTokens: count(value.cached_input_tokens),
        cacheWriteInputTokens: count(value.cache_write_input_tokens),
        outputTokens: count(value.output_tokens),
        reasoningOutputTokens: count(value.reasoning_output_tokens),
        totalTokens: count(value.total_tokens),
      })
    : undefined;

/** Fields in which a `collab_agent_spawn*` event may carry the child's thread id. */
const CHILD_ID_FIELDS = [
  "new_thread_id",
  "child_thread_id",
  "receiver_thread_id",
  "agent_thread_id",
  "spawned_thread_id",
] as const;

const recordOf = (
  type: unknown,
  base: RecordBase,
  payload: Record<string, unknown>,
): RolloutRecord | undefined => {
  if (type === "session_meta") {
    return defined({
      ...base,
      type: "session_meta" as const,
      id: str(payload.id),
      sessionId: str(payload.session_id),
      cliVersion: str(payload.cli_version),
      source: str(payload.source),
      threadSource: str(payload.thread_source),
      modelProvider: str(payload.model_provider),
      parentThreadId: str(payload.parent_thread_id),
    });
  }
  if (type === "turn_context") {
    return defined({
      ...base,
      type: "turn_context" as const,
      turnId: str(payload.turn_id),
      model: str(payload.model),
    });
  }
  if (type === "token_usage_record") {
    return defined({
      ...base,
      type: "token_usage_record" as const,
      threadId: str(payload.thread_id),
      turnId: str(payload.turn_id),
      sessionId: str(payload.session_id),
      rootTurnId: str(payload.root_turn_id),
      responseId: str(payload.response_id),
      usage: usageOf(payload.usage),
      turnTokenUsage: usageOf(payload.turn_token_usage),
      threadTokenUsage: usageOf(payload.thread_token_usage),
    });
  }
  if (type === "response_item") {
    const name = str(payload.name);
    if (payload.type === "function_call" && (name === "spawn_agent" || name === "spawn_agents")) {
      return defined({
        ...base,
        type: "spawn_call" as const,
        name,
        callId: str(payload.call_id),
      });
    }
    return undefined;
  }
  if (type !== "event_msg") return undefined;
  const event = str(payload.type);
  if (event === undefined) return undefined;
  switch (event) {
    case "task_started":
      return defined({
        ...base,
        type: "task_started" as const,
        turnId: str(payload.turn_id),
        modelContextWindow: count(payload.model_context_window),
      });
    case "token_count": {
      const info = isObject(payload.info) ? payload.info : {};
      return defined({
        ...base,
        type: "token_count" as const,
        totalTokenUsage: usageOf(info.total_token_usage),
        lastTokenUsage: usageOf(info.last_token_usage),
        modelContextWindow: count(info.model_context_window),
      });
    }
    case "task_complete":
      return defined({
        ...base,
        type: "task_complete" as const,
        turnId: str(payload.turn_id),
        durationMs: count(payload.duration_ms),
        timeToFirstTokenMs: count(payload.time_to_first_token_ms),
      });
    case "turn_aborted":
      return defined({
        ...base,
        type: "turn_aborted" as const,
        turnId: str(payload.turn_id),
        reason: str(payload.reason),
      });
    case "thread_settings_applied":
      return { ...base, type: "thread_settings_applied" };
    default:
      if (event.startsWith("collab_agent_spawn")) {
        const childThreadIds = CHILD_ID_FIELDS.map((field) => str(payload[field])).filter(
          (id): id is string => id !== undefined && THREAD_ID.test(id),
        );
        return { ...base, type: "collab_agent_spawn", event, childThreadIds };
      }
      return undefined;
  }
};

/** A line as a record (undefined when it is a line kind we ignore), or "bad" when it is not a rollout line. */
const parseRecord = (
  line: string,
): { readonly ordinal: number; readonly record: RolloutRecord | undefined } | "bad" => {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return "bad";
  }
  if (!isObject(value)) return "bad";
  const ordinal = count(value.ordinal);
  const timestamp = str(value.timestamp);
  if (ordinal === undefined || timestamp === undefined) return "bad";
  const payload = isObject(value.payload) ? value.payload : {};
  return {
    ordinal,
    record: recordOf(value.type, { ordinal, timestamp }, payload),
  };
};

/**
 * Parse a rollout, or the growth of one. Never throws: an unparseable complete
 * line is skipped, an unfinished last line is reported as `tornTail` and left
 * for the next read. Records below `fromOrdinal` and repeated ordinals are
 * dropped, so re-reading the same bytes yields nothing new.
 */
export const readRolloutMetadata = (
  text: string,
  options: {
    readonly fromByteOffset?: number;
    readonly fromOrdinal?: number;
  } = {},
): RolloutRead => {
  const bytes = Buffer.from(text, "utf8");
  const start = Math.min(Math.max(options.fromByteOffset ?? 0, 0), bytes.length);
  const fromOrdinal = options.fromOrdinal ?? 0;
  const records: RolloutRecord[] = [];
  const seen = new Set<number>();
  let nextOrdinal = fromOrdinal;
  let position = start;
  let tornTail = false;
  while (position < bytes.length) {
    const newline = bytes.indexOf(0x0a, position);
    const end = newline === -1 ? bytes.length : newline;
    const line = bytes.toString("utf8", position, end);
    if (line.trim() === "") {
      position = newline === -1 ? bytes.length : newline + 1;
      continue;
    }
    const parsed = parseRecord(line);
    if (newline === -1 && parsed === "bad") {
      tornTail = true;
      break;
    }
    position = newline === -1 ? bytes.length : newline + 1;
    if (parsed === "bad") continue;
    const { ordinal, record } = parsed;
    if (ordinal < fromOrdinal || seen.has(ordinal)) continue;
    seen.add(ordinal);
    nextOrdinal = Math.max(nextOrdinal, ordinal + 1);
    if (record !== undefined) records.push(record);
  }
  return { records, nextByteOffset: position, nextOrdinal, tornTail };
};

// ---------------------------------------------------------------------------
// Discovery

/** The directory-listing surface discovery needs; defaults to node:fs/promises. */
export interface RolloutFs {
  readdir(path: string, options: { readonly recursive: boolean }): Promise<string[]>;
}

const nodeFs: RolloutFs = {
  readdir: (path, options) => readdir(path, options),
};

const listing = async (fs: RolloutFs, path: string, recursive: boolean): Promise<string[]> => {
  try {
    return await fs.readdir(path, { recursive });
  } catch {
    return [];
  }
};

const latestMatch = (files: readonly string[], threadId: string): string | undefined =>
  files
    .filter((file) => file.endsWith(`-${threadId}.jsonl`))
    .sort()
    .at(-1);

/** The day directories (UTC) of `around` and the days either side of it, as `YYYY/MM/DD`. */
const dayDirectories = (around: string): string[] => {
  const time = Date.parse(around);
  if (Number.isNaN(time)) return [];
  return [0, -1, 1].map((delta) => {
    const day = new Date(time + delta * 86_400_000);
    const pad = (n: number): string => String(n).padStart(2, "0");
    return `${day.getUTCFullYear()}/${pad(day.getUTCMonth() + 1)}/${pad(day.getUTCDate())}`;
  });
};

/**
 * The newest rollout for a thread under one root: the day directories of
 * `around` first when given, then a full recursive scan. Undefined when the
 * thread id is malformed or nothing matches; a missing root is not an error.
 */
export const findRolloutIn = async (
  root: string,
  threadId: string,
  options: {
    readonly around?: string;
    readonly fs?: RolloutFs;
    readonly scan?: boolean;
  } = {},
): Promise<string | undefined> => {
  if (!THREAD_ID.test(threadId)) return undefined;
  const fs = options.fs ?? nodeFs;
  for (const day of options.around === undefined ? [] : dayDirectories(options.around)) {
    const found = latestMatch(await listing(fs, join(root, day), false), threadId);
    if (found !== undefined) return join(root, day, found);
  }
  if (options.scan === false) return undefined;
  const found = latestMatch(await listing(fs, root, true), threadId);
  return found === undefined ? undefined : join(root, found);
};

/**
 * Find the rollout of `threadId`: under `sessions/`, then under
 * `archived_sessions/` where Codex moves a rollout it archives. Undefined when
 * it is gone; a malformed thread id is refused.
 */
export const locateRollout = async (input: {
  readonly threadId: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly home: string;
  readonly around?: string;
  readonly fs?: RolloutFs;
}): Promise<string | undefined> => {
  if (!THREAD_ID.test(input.threadId)) return undefined;
  const codexHome = input.env.CODEX_HOME ?? join(input.home, ".codex");
  const roots = [join(codexHome, "sessions"), join(codexHome, "archived_sessions")];
  const fs = input.fs ?? nodeFs;
  // Day directories of both roots before any full scan: the common case is cheap.
  if (input.around !== undefined) {
    for (const root of roots) {
      const found = await findRolloutIn(root, input.threadId, {
        around: input.around,
        fs,
        scan: false,
      });
      if (found !== undefined) return found;
    }
  }
  for (const root of roots) {
    const found = await findRolloutIn(root, input.threadId, { fs });
    if (found !== undefined) return found;
  }
  return undefined;
};

// ---------------------------------------------------------------------------
// Observations

export type LaunchBoundary =
  /** The first ordinal that belongs to this launch; 0 for a fresh thread. */
  | { readonly kind: "ordinal"; readonly fromOrdinal: number }
  /** Fallback: records stamped earlier than `notBefore` (ISO time) are excluded. */
  | { readonly kind: "time"; readonly notBefore: string };

export interface RolloutFacts {
  readonly boundary: LaunchBoundary["kind"];
  /** Turns seen in this launch. */
  readonly turnIds: readonly string[];
  readonly aborted: boolean;
  /** Requests of this thread before the launch boundary, not emitted. */
  readonly excludedBeforeBoundary: number;
  readonly spawnEvidence: {
    readonly spawned: boolean;
    readonly childThreadIds: readonly string[];
  };
  readonly cliVersion?: string;
  /** The context window CAPACITY most recently reported. */
  readonly latestContextWindow?: number;
}

const REQUEST_NOTE =
  "rollout v1 token_usage_record; cached_input and cache_write are subsets of input, reasoning of output; contextWindowTokens is capacity";
const TOTAL_NOTE =
  "rollout v1 token_count total_token_usage; thread-cumulative across resumes; cached_input and cache_write are subsets of input, reasoning of output";

const countersOf = (usage: RolloutUsage | undefined): MeasurementCounters =>
  defined({
    inputTokens: usage?.inputTokens,
    cacheReadTokens: usage?.cachedInputTokens,
    cacheWriteTokens: usage?.cacheWriteInputTokens,
    outputTokens: usage?.outputTokens,
    reasoningTokens: usage?.reasoningOutputTokens,
    inputIncludesCache: true,
  });

/**
 * Observations for one launch of a thread. A request per `token_usage_record`
 * of `threadId` at or after the launch boundary; exactly one session-scoped
 * cumulative snapshot from the latest thread total in the whole file (it is
 * session-wide, so the core baselines it against earlier launches).
 */
export const rolloutObservations = (
  records: readonly RolloutRecord[],
  options: {
    readonly threadId: string;
    readonly launchBoundary: LaunchBoundary;
    readonly childOf?: string;
  },
): {
  readonly observations: HarnessObservation[];
  readonly facts: RolloutFacts;
} => {
  const { threadId, launchBoundary, childOf } = options;
  const notBefore =
    launchBoundary.kind === "time" ? Date.parse(launchBoundary.notBefore) : Number.NaN;
  const inLaunch = (record: RolloutRecord): boolean =>
    launchBoundary.kind === "ordinal"
      ? record.ordinal >= launchBoundary.fromOrdinal
      : Date.parse(record.timestamp) >= notBefore;

  const modelOfTurn = new Map<string, string>();
  let cliVersion: string | undefined;
  let latestContextWindow: number | undefined;
  let latestTotal: (RolloutRecord & { type: "token_count" }) | undefined;
  for (const record of records) {
    if (record.type === "turn_context" && record.turnId !== undefined && record.model) {
      modelOfTurn.set(record.turnId, record.model);
    } else if (record.type === "session_meta" && record.cliVersion !== undefined) {
      cliVersion = record.cliVersion;
    } else if (record.type === "task_started" && record.modelContextWindow !== undefined) {
      latestContextWindow = record.modelContextWindow;
    } else if (record.type === "token_count") {
      if (record.modelContextWindow !== undefined) latestContextWindow = record.modelContextWindow;
      if (record.totalTokenUsage !== undefined) latestTotal = record;
    }
  }

  const provenance = (note: string) => ({
    adapter: "codex",
    ...(cliVersion === undefined ? {} : { version: cliVersion }),
    note,
  });
  const childRef =
    childOf === undefined ? {} : { childRef: { kind: "session" as const, id: childOf } };

  const observations: HarnessObservation[] = [];
  const turnIds = new Set<string>();
  const childThreadIds = new Set<string>();
  let excludedBeforeBoundary = 0;
  let aborted = false;
  let spawned = false;
  for (const record of records) {
    const launch = inLaunch(record);
    if (record.type === "token_usage_record") {
      if (record.threadId !== threadId) continue;
      if (!launch) {
        excludedBeforeBoundary += 1;
        continue;
      }
      if (record.turnId !== undefined) turnIds.add(record.turnId);
      const model = record.turnId === undefined ? undefined : modelOfTurn.get(record.turnId);
      observations.push({
        schemaVersion: 1,
        observationId: `codex:rollout:${threadId}:${record.ordinal}`,
        kind: "request",
        counters: countersOf(record.usage),
        ...(record.responseId === undefined ? {} : { requestId: record.responseId }),
        sessionId: threadId,
        ...(model === undefined ? {} : { model }),
        ...(latestContextWindow === undefined ? {} : { contextWindowTokens: latestContextWindow }),
        occurredAt: record.timestamp,
        source: "harness",
        provenance: provenance(REQUEST_NOTE),
        inclusion: "self",
        ...childRef,
      });
      continue;
    }
    if (!launch) continue;
    if (
      (record.type === "task_started" || record.type === "turn_context") &&
      record.turnId !== undefined
    ) {
      turnIds.add(record.turnId);
    } else if (record.type === "turn_aborted") {
      aborted = true;
      if (record.turnId !== undefined) turnIds.add(record.turnId);
    } else if (record.type === "spawn_call") {
      spawned = true;
    } else if (record.type === "collab_agent_spawn") {
      spawned = true;
      for (const id of record.childThreadIds) if (id !== threadId) childThreadIds.add(id);
    }
  }

  if (latestTotal !== undefined) {
    observations.push({
      schemaVersion: 1,
      observationId: `codex:rollout:${threadId}:total:${latestTotal.ordinal}`,
      kind: "cumulative_snapshot",
      counterScope: "session",
      counters: countersOf(latestTotal.totalTokenUsage),
      sessionId: threadId,
      occurredAt: latestTotal.timestamp,
      source: "harness",
      provenance: provenance(TOTAL_NOTE),
      inclusion: "self",
      ...childRef,
    });
  }

  return {
    observations,
    facts: {
      boundary: launchBoundary.kind,
      turnIds: [...turnIds],
      aborted,
      excludedBeforeBoundary,
      spawnEvidence: { spawned, childThreadIds: [...childThreadIds] },
      ...(cliVersion === undefined ? {} : { cliVersion }),
      ...(latestContextWindow === undefined ? {} : { latestContextWindow }),
    },
  };
};
