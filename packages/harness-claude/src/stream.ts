/**
 * Reading Claude Code's structured output stream, and turning it into the P3
 * hook channel (D-P3-09, contract §4.7).
 *
 * ## WHERE EACH EVENT COMES FROM
 *
 * The task spec anticipated that some of §4.7 would have to come from a
 * configured Claude hook whose log the adapter tails. On **2.1.273 none of it
 * does**: every event the contract lists is carried by the `--output-format
 * stream-json` stream, and the one thing the stream cannot describe — how the
 * process ended — is the process itself, which the adapter already owns. So the
 * settings file this adapter writes configures no hooks (`command.ts` explains
 * why it is still written), and **no event depends on the worker's cooperation**.
 *
 * | Contract event            | Mechanism | Frame                                              |
 * |---------------------------|-----------|----------------------------------------------------|
 * | `agent.started`           | stream    | `system` / `init` — the first frame of every run    |
 * | `tool.called`             | stream    | `assistant` message, `tool_use` content block       |
 * | `tool.completed`          | stream    | `user` message, `tool_result` content block         |
 * | `agent.subagent_created`  | stream    | `system` / `task_started`, or a sub-agent `tool_use`|
 * | `agent.context_compacted` | stream    | `system` / `compact_boundary`                       |
 * | `agent.completed`         | process   | exit 0 **and** a non-error `result` frame           |
 * | `agent.failed`            | process   | any other exit, including a stream with no `result` |
 * | `agent.interrupted`       | process   | killed by a signal                                  |
 * | `agent.cancelled`         | process   | `cancel` was what stopped it                        |
 *
 * The four endings are emitted by `adapter.ts` from the exit, not from here,
 * which is what makes "exactly one ending, and it agrees with `exit`" true by
 * construction rather than by careful parsing. `agent.started` is emitted from
 * the `init` frame when one arrives and synthesised at settle time when none
 * does, so a worker that dies before Claude prints anything still produces a
 * start and an end.
 *
 * ## FRAMES, AS OBSERVED ON 2.1.273
 *
 * Every shape below was taken from a real recorded run
 * (`__fixtures__/claude-stream-success.jsonl`), except `compact_boundary`, whose
 * schema was read out of the installed CLI itself — a compaction needs a context
 * far larger than a recording should carry.
 *
 * - `{"type":"system","subtype":"init","session_id":…,"cwd":…,"tools":[…],
 *    "mcp_servers":[{"name":…,"status":"connected"}],"model":…,"permissionMode":…}`
 * - `{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_…",
 *    "name":"Read","input":{…}}]}}` — MCP tools arrive as
 *   `mcp__<server>__<tool_with_underscores>`; the sub-agent tool is declared as
 *   `Task` in `--tools` but **reported as `Agent`** in the `tool_use`, so both
 *   spellings are recognised.
 * - `{"type":"user","message":{"content":[{"type":"tool_result",
 *    "tool_use_id":"toolu_…","content":…,"is_error":true|absent}]}}`
 * - `{"type":"system","subtype":"task_started","task_id":…,"tool_use_id":…,
 *    "description":…,"subagent_type":"general-purpose","spawn_depth":1}` and its
 *   `task_progress` / `task_updated` / `task_notification` siblings, which carry
 *   no contract event and are ignored.
 * - `{"type":"system","subtype":"compact_boundary","compact_metadata":
 *    {"trigger":"manual"|"auto","pre_tokens":N,"post_tokens":N?}}`
 * - `{"type":"result","subtype":"success"|"error_during_execution"|…,
 *    "is_error":bool,"terminal_reason":"completed"|"aborted_streaming"|…,
 *    "permission_denials":[…],"num_turns":N,"total_cost_usd":N}`
 * - `rate_limit_event`, `system`/`thinking_tokens`,
 *   `system`/`background_tasks_changed` and the rest are ignored by name rather
 *   than by a catch-all, so a new frame type is a silent no-op and never a crash.
 *
 * One finding worth its own line, because it contradicts the obvious reading of
 * the task spec: **a `SIGINT`-interrupted run exits 0 and still prints a `result`
 * frame**, with `subtype: "error_during_execution"`, `is_error: true` and
 * `terminal_reason: "aborted_streaming"`. Exit code zero alone therefore does
 * not mean the work completed; `adapter.ts` requires a *non-error* result.
 */
import { MAX_INLINE_PAYLOAD_BYTES, type RouteUsage } from "@nightshift/contracts";
import type { Clock } from "@nightshift/core";
import { nowIso } from "@nightshift/core";
import {
  type HookEvent,
  type HookEventType,
  type HookSink,
  routeUnavailableReason,
} from "@nightshift/harness";

/**
 * The ceiling this adapter holds its own payloads to.
 *
 * The execution layer refuses an `Event` whose inline payload exceeds
 * `MAX_INLINE_PAYLOAD_BYTES` (8192). A quarter of that is the budget here, so
 * that a tool summary is never the reason a lifecycle event is lost, and so
 * there is headroom for whatever identifiers the execution layer adds on the way
 * to an `Event`. Enforced, not hoped for: {@link boundPayload} truncates.
 */
export const MAX_HOOK_PAYLOAD_BYTES = Math.floor(MAX_INLINE_PAYLOAD_BYTES / 4);

/** Per-field caps, applied before the whole-payload bound. */
const MAX_SUMMARY_CHARS = 400;
const MAX_NAME_CHARS = 200;
const MAX_LIST_ENTRIES = 12;

const encoder = new TextEncoder();

const payloadBytes = (payload: Readonly<Record<string, unknown>>): number =>
  encoder.encode(JSON.stringify(payload)).length;

const truncate = (text: string, limit: number): string =>
  text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;

/**
 * Bring a payload under {@link MAX_HOOK_PAYLOAD_BYTES}.
 *
 * Fields are dropped from the least informative end — the summary first, then
 * anything else that is still oversized — so what survives is always the part a
 * reader needs: the event's identifiers. The final fallback keeps only the keys
 * that fit, because emitting a truncated payload beats emitting none.
 */
export const boundPayload = (
  payload: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> => {
  if (payloadBytes(payload) <= MAX_HOOK_PAYLOAD_BYTES) return Object.freeze({ ...payload });

  const working: Record<string, unknown> = { ...payload };
  if (typeof working.summary === "string") {
    working.summary = truncate(working.summary, 80);
    if (payloadBytes(working) <= MAX_HOOK_PAYLOAD_BYTES) return Object.freeze(working);
    delete working.summary;
    if (payloadBytes(working) <= MAX_HOOK_PAYLOAD_BYTES) return Object.freeze(working);
  }

  // Still too large: rebuild key by key and stop at the bound. Insertion order
  // is the order the emitters write their fields, which puts identifiers first.
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(working)) {
    const candidate = { ...kept, [key]: value };
    if (payloadBytes(candidate) > MAX_HOOK_PAYLOAD_BYTES) continue;
    kept[key] = value;
  }
  return Object.freeze(kept);
};

/** A parsed stream frame. Nothing is trusted: every read is a guarded read. */
type Frame = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is Frame =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A non-negative integer, which is what `RouteUsage` accepts for a count. */
const tokenCount = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/**
 * Tool names that mean "a sub-agent was created".
 *
 * `Task` is how the tool is declared in `--tools`; `Agent` is how the resulting
 * call is reported in the `tool_use` block. Both are recognised because the
 * mismatch is real in 2.1.273 and a release could settle on either.
 */
export const SUBAGENT_TOOL_NAMES: readonly string[] = ["Task", "Agent"];

const isSubagentTool = (name: string): boolean => SUBAGENT_TOOL_NAMES.includes(name);

/**
 * A short, human-meaningful description of what a tool was asked to do.
 *
 * Per-tool rather than a generic JSON dump, because the useful field differs and
 * because a `Write` tool's `content` is the entire file — exactly the kind of
 * payload the inline bound exists to keep out of DynamoDB.
 */
/** Joins the parts of a summary that are present, dropping the rest. */
const joined = (separator: string, parts: readonly (string | undefined)[]): string =>
  parts.filter((part): part is string => part !== undefined).join(separator);

/**
 * Which field of a tool's input is worth summarising, per tool.
 *
 * A table rather than a chain of conditions, so adding a tool is one line and so
 * the fallback below is reached by one path rather than several.
 */
const TOOL_SUMMARY: Readonly<
  Record<string, (pick: (key: string) => string | undefined) => string>
> = {
  Bash: (pick) => joined("", [pick("command")]),
  Read: (pick) => joined("", [pick("file_path")]),
  Edit: (pick) => joined("", [pick("file_path")]),
  Write: (pick) => joined("", [pick("file_path")]),
  NotebookEdit: (pick) => joined("", [pick("notebook_path") ?? pick("file_path")]),
  Glob: (pick) => joined("", [pick("pattern")]),
  Grep: (pick) => joined(" in ", [pick("pattern"), pick("path")]),
  Task: (pick) => joined(": ", [pick("subagent_type"), pick("description")]),
  Agent: (pick) => joined(": ", [pick("subagent_type"), pick("description")]),
};

/** For a tool with no entry above: a label if it has one, never a value dump. */
const genericSummary = (pick: (key: string) => string | undefined): string =>
  joined("", [pick("description") ?? pick("summary") ?? pick("message") ?? pick("reason")]);

export const summariseToolInput = (tool: string, input: unknown): string | undefined => {
  if (!isRecord(input)) return undefined;
  const pick = (key: string): string | undefined => str(input[key]);
  const summary = (TOOL_SUMMARY[tool] ?? genericSummary)(pick);
  if (summary.length > 0) return truncate(summary, MAX_SUMMARY_CHARS);
  // Nothing recognisable: the key names alone say more than a truncated value
  // dump would, and they cannot contain a file's contents.
  const keys = Object.keys(input).slice(0, MAX_LIST_ENTRIES);
  return keys.length === 0 ? undefined : truncate(keys.join(", "), MAX_SUMMARY_CHARS);
};

/** One content block of a `tool_result`, as a line of summary. */
const summariseBlock = (block: unknown): string | undefined => {
  if (!isRecord(block)) return undefined;
  const text = str(block.text);
  if (text !== undefined) return text;
  const kind = str(block.type);
  return kind === undefined ? undefined : `[${kind}]`;
};

/** A `tool_result`'s content is a string, or content blocks, or anything at all. */
export const summariseToolResult = (content: unknown): string | undefined => {
  if (typeof content === "string") return truncate(content, MAX_SUMMARY_CHARS);
  if (!Array.isArray(content)) return undefined;
  const text = joined("\n", content.slice(0, MAX_LIST_ENTRIES).map(summariseBlock)).trim();
  return text.length === 0 ? undefined : truncate(text, MAX_SUMMARY_CHARS);
};

/**
 * `{ [key]: value }` when `value` is defined, and `{}` when it is not.
 *
 * `exactOptionalPropertyTypes` means an absent field must be *omitted* rather
 * than set to `undefined`, and a payload built from a dozen guarded reads turns
 * into a wall of ternaries without this.
 */
export const optionalField = (key: string, value: unknown): Record<string, unknown> =>
  value === undefined ? {} : { [key]: value };

/** What the interpreter learned from the stream, for the exit mapping. */
export interface StreamOutcome {
  /** True once a `result` frame has been seen, error or not. */
  readonly sawResult: boolean;
  /** True when the `result` frame reported an error. */
  readonly resultErrored: boolean;
  /** The `result` frame's `subtype`, e.g. `success`, `error_during_execution`. */
  readonly resultSubtype?: string;
  /** The `result` frame's `terminal_reason`, e.g. `completed`, `aborted_streaming`. */
  readonly terminalReason?: string;
  /** Claude's own session identifier, from the `init` frame. */
  readonly sessionId?: string;
  /** The `result` frame's text: the model's final message (P8, an answerer's answers). */
  readonly resultText?: string;
  /**
   * P8 (D-P8-06): why the route could not start, when the `result` frame was a
   * provider error (`terminal_reason: "api_error"` with an `api_error_status`)
   * before any tool was called. `routeUnavailableReason` draws the line.
   */
  readonly unavailable?: string;
  /**
   * What the `result` frame said the run cost (contract v1, D-P5-01):
   * `usage.input_tokens`, `usage.output_tokens`, `total_cost_usd` and
   * `duration_ms`, each only when the frame carried it. An interrupted run's
   * frame carries them too, and what it spent is still what it spent.
   */
  readonly usage?: RouteUsage;
  /** True once `agent.started` has been emitted, so it is emitted exactly once. */
  readonly startEmitted: boolean;
  /** Lines that were not parseable JSON. A non-zero count belongs in the failure payload. */
  readonly unparseableLines: number;
}

export interface StreamInterpreterInput {
  readonly sink: HookSink;
  readonly clock: Clock;
  /**
   * Extra fields merged into every payload. The adapter puts the agent
   * identifier here so a reader of the raw sink can attribute an event without
   * the execution layer's help.
   */
  readonly context?: Readonly<Record<string, unknown>>;
}

export interface StreamInterpreter {
  /** Feed raw stdout bytes. Safe at any chunk boundary, including mid-line. */
  write(chunk: Uint8Array): void;
  /** Flush a trailing line with no newline. Call once, when the pipe closes. */
  end(): void;
  /** Emit `agent.started` if the `init` frame never arrived. Idempotent. */
  ensureStarted(payload?: Readonly<Record<string, unknown>>): void;
  /** Emit one event directly. Used by the adapter for the ending. */
  emit(type: HookEventType, payload: Readonly<Record<string, unknown>>): void;
  readonly outcome: StreamOutcome;
}

/**
 * The stream interpreter: bytes in, `HookEvent`s out.
 *
 * Stateful because the stream is: a `tool_result` names a `tool_use_id` and not
 * a tool, so `tool.completed` can only carry a tool name if the interpreter
 * remembers the `tool_use` that opened it. That map is bounded — entries are
 * deleted as results arrive — and a run that leaves entries behind has
 * unanswered tool calls, which is information the failure payload carries.
 *
 * Never throws. A malformed line, an unknown frame, a content block of the wrong
 * shape: each is skipped. Losing the lifecycle of a run because one line was
 * truncated would be the worse bug, and `emit` on a `HookSink` is documented as
 * non-blocking and non-throwing in both directions.
 */
export const createStreamInterpreter = (input: StreamInterpreterInput): StreamInterpreter => {
  const decoder = new TextDecoder("utf-8");
  let pending = "";
  /** `tool_use_id` → tool name, so a `tool_result` can be attributed. */
  const openToolCalls = new Map<string, string>();
  /** `tool_use_id`s already reported as a sub-agent, so each is reported once. */
  const subagentsSeen = new Set<string>();

  let sawResult = false;
  let resultErrored = false;
  let resultSubtype: string | undefined;
  let terminalReason: string | undefined;
  let sessionId: string | undefined;
  let usage: RouteUsage | undefined;
  let unavailable: string | undefined;
  let resultText: string | undefined;
  let toolCalls = 0;
  let startEmitted = false;
  let unparseableLines = 0;

  const emit = (type: HookEventType, payload: Readonly<Record<string, unknown>>): void => {
    const event: HookEvent = {
      type,
      occurredAt: nowIso(input.clock),
      payload: boundPayload({ ...payload, ...input.context }),
    };
    try {
      input.sink.emit(event);
    } catch {
      // A `HookSink` is documented as never throwing. If one does anyway, the
      // parse must continue: the run's remaining events are still worth having.
    }
  };

  const emitStarted = (payload: Readonly<Record<string, unknown>>): void => {
    if (startEmitted) return;
    startEmitted = true;
    emit("agent.started", payload);
  };

  const handleInit = (frame: Frame): void => {
    sessionId = str(frame.session_id);
    const tools = Array.isArray(frame.tools)
      ? frame.tools.filter((tool): tool is string => typeof tool === "string")
      : [];
    const servers = Array.isArray(frame.mcp_servers)
      ? frame.mcp_servers.filter(isRecord).map((server) => ({
          name: str(server.name) ?? "",
          status: str(server.status) ?? "",
        }))
      : [];
    emitStarted({
      harness: "claude",
      ...optionalField("sessionId", sessionId),
      ...optionalField("model", str(frame.model)),
      ...optionalField("harnessVersion", str(frame.claude_code_version)),
      ...optionalField("permissionMode", str(frame.permissionMode)),
      toolCount: tools.length,
      tools: tools.slice(0, MAX_LIST_ENTRIES),
      mcpServers: servers.slice(0, MAX_LIST_ENTRIES),
    });
  };

  const handleSubagent = (frame: Frame): void => {
    const toolUseId = str(frame.tool_use_id);
    if (toolUseId !== undefined && subagentsSeen.has(toolUseId)) return;
    if (toolUseId !== undefined) subagentsSeen.add(toolUseId);
    const description = str(frame.description);
    emit("agent.subagent_created", {
      ...optionalField("toolUseId", toolUseId),
      ...optionalField("taskId", str(frame.task_id)),
      ...optionalField("subagentType", str(frame.subagent_type)),
      ...optionalField("depth", num(frame.spawn_depth)),
      ...optionalField(
        "summary",
        description === undefined ? undefined : truncate(description, MAX_SUMMARY_CHARS),
      ),
    });
  };

  const handleCompaction = (frame: Frame): void => {
    const metadata = isRecord(frame.compact_metadata) ? frame.compact_metadata : {};
    emit("agent.context_compacted", {
      ...optionalField("trigger", str(metadata.trigger)),
      ...optionalField("preTokens", num(metadata.pre_tokens)),
      ...optionalField("postTokens", num(metadata.post_tokens)),
    });
  };

  /** The content blocks of an `assistant` or `user` message frame, or none. */
  const contentBlocksOf = (frame: Frame): readonly unknown[] => {
    const message = isRecord(frame.message) ? frame.message : undefined;
    const content = message === undefined ? undefined : message.content;
    return Array.isArray(content) ? content : [];
  };

  const handleToolUse = (block: Frame): void => {
    const tool = str(block.name);
    if (tool === undefined) return;
    toolCalls += 1;
    const toolUseId = str(block.id);
    if (toolUseId !== undefined) openToolCalls.set(toolUseId, tool);
    const summary = summariseToolInput(tool, block.input);
    emit("tool.called", {
      tool: truncate(tool, MAX_NAME_CHARS),
      ...optionalField("toolUseId", toolUseId),
      ...optionalField("summary", summary),
    });
    // A sub-agent shows up twice in the stream: the `tool_use` here, then a
    // `system`/`task_started` naming the same `tool_use_id`. Reporting on the
    // first and deduplicating on the second means one event per sub-agent
    // without buffering, and still covers a `task_started` whose `tool_use` was
    // never seen.
    if (!isSubagentTool(tool) || toolUseId === undefined) return;
    if (subagentsSeen.has(toolUseId)) return;
    subagentsSeen.add(toolUseId);
    emit("agent.subagent_created", {
      toolUseId,
      tool: truncate(tool, MAX_NAME_CHARS),
      ...optionalField("summary", summary),
    });
  };

  const handleAssistant = (frame: Frame): void => {
    for (const block of contentBlocksOf(frame)) {
      if (isRecord(block) && block.type === "tool_use") handleToolUse(block);
    }
  };

  const handleToolResult = (block: Frame): void => {
    const toolUseId = str(block.tool_use_id);
    const tool = toolUseId === undefined ? undefined : openToolCalls.get(toolUseId);
    if (toolUseId !== undefined) openToolCalls.delete(toolUseId);
    emit("tool.completed", {
      ...optionalField("tool", tool),
      ...optionalField("toolUseId", toolUseId),
      ok: block.is_error !== true,
      ...optionalField("summary", summariseToolResult(block.content)),
    });
  };

  const handleUser = (frame: Frame): void => {
    for (const block of contentBlocksOf(frame)) {
      if (isRecord(block) && block.type === "tool_result") handleToolResult(block);
    }
  };

  const handleResult = (frame: Frame): void => {
    sawResult = true;
    resultErrored = frame.is_error === true || str(frame.subtype) !== "success";
    resultSubtype = str(frame.subtype);
    terminalReason = str(frame.terminal_reason);
    resultText = str(frame.result);
    if (resultErrored && terminalReason === "api_error") {
      unavailable = routeUnavailableReason({
        status: tokenCount(frame.api_error_status),
        message: str(frame.result) ?? "the provider refused the request",
        workBegan: toolCalls > 0,
      });
    }

    const reported = isRecord(frame.usage) ? frame.usage : {};
    const found: RouteUsage = {
      ...optionalField("inputTokens", tokenCount(reported.input_tokens)),
      ...optionalField("outputTokens", tokenCount(reported.output_tokens)),
      ...optionalField("cacheReadTokens", tokenCount(reported.cache_read_input_tokens)),
      ...optionalField("cacheWriteTokens", tokenCount(reported.cache_creation_input_tokens)),
      ...optionalField(
        "actualCostUsd",
        typeof frame.total_cost_usd === "number" && frame.total_cost_usd >= 0
          ? frame.total_cost_usd
          : undefined,
      ),
      ...optionalField("latencyMs", tokenCount(frame.duration_ms)),
    };
    if (Object.keys(found).length > 0) usage = found;
  };

  const handleFrame = (frame: Frame): void => {
    switch (frame.type) {
      case "system":
        switch (frame.subtype) {
          case "init":
            handleInit(frame);
            return;
          case "task_started":
            handleSubagent(frame);
            return;
          case "compact_boundary":
            handleCompaction(frame);
            return;
          default:
            // `thinking_tokens`, `task_progress`, `task_updated`,
            // `task_notification`, `background_tasks_changed`, `status`, … None
            // carries a contract event; a new one must be a no-op, not a crash.
            return;
        }
      case "assistant":
        handleAssistant(frame);
        return;
      case "user":
        handleUser(frame);
        return;
      case "result":
        handleResult(frame);
        return;
      default:
        // `rate_limit_event`, `stream_event`, `prompt_suggestion`, …
        return;
    }
  };

  const handleLine = (line: string): void => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      unparseableLines += 1;
      return;
    }
    if (!isRecord(parsed)) return;
    handleFrame(parsed);
  };

  return {
    write: (chunk) => {
      pending += decoder.decode(chunk, { stream: true });
      let newline = pending.indexOf("\n");
      while (newline !== -1) {
        handleLine(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
      }
    },
    end: () => {
      pending += decoder.decode();
      const rest = pending;
      pending = "";
      handleLine(rest);
    },
    ensureStarted: (payload) => emitStarted({ harness: "claude", ...payload }),
    emit,
    get outcome(): StreamOutcome {
      return {
        sawResult,
        resultErrored,
        ...optionalField("resultSubtype", resultSubtype),
        ...optionalField("terminalReason", terminalReason),
        ...optionalField("sessionId", sessionId),
        ...optionalField("usage", usage),
        ...optionalField("unavailable", unavailable),
        ...optionalField("resultText", resultText),
        startEmitted,
        unparseableLines,
      };
    },
  };
};
