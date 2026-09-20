/**
 * The `codex exec --json` stream, interpreted (P5, T3 deliverable 2).
 *
 * Newline-delimited JSON on stdout. The grammar below was **recorded from real
 * runs on 0.154.0**, not read from documentation; `fixtures/` holds one.
 *
 * ## EVENT MAPPING
 *
 * | Codex event                                   | Hook event                      |
 * |-----------------------------------------------|---------------------------------|
 * | `thread.started { thread_id }`                 | `agent.started`                 |
 * | `item.started`, item `command_execution`       | `tool.called { tool: "shell" }` |
 * | `item.completed`, item `command_execution`     | `tool.completed`, `ok` = exit 0 |
 * | `item.started`, item `mcp_tool_call`           | `tool.called { tool: "<server>.<tool>" }` |
 * | `item.completed`, item `mcp_tool_call`         | `tool.completed`, `ok` = no error |
 * | `item.completed`, item `file_change`           | `tool.called` + `tool.completed { tool: "apply_patch" }` |
 * | `item.completed`, item `web_search`            | `tool.called` + `tool.completed { tool: "web_search" }` |
 * | `turn.completed { usage }`                     | none; `usage` and the clean ending are kept for the exit |
 * | `turn.failed { error }`, `error { message }`   | none; kept for the exit's failure payload |
 * | `agent_message`, `reasoning`, `todo_list`       | none: the model talking, not acting |
 *
 * `file_change` and `web_search` arrive only as `item.completed`, so the pair is
 * emitted together: a reader still sees one call and one completion per action.
 *
 * ## What has no Codex source
 *
 * `agent.subagent_created` and `agent.context_compacted`: `codex exec` reports
 * neither on this stream. Both are observations an adapter makes *when its
 * harness has them* (D-P3-09), not lifecycle events, so nothing is configured to
 * fake them. The lifecycle itself — the start and exactly one ending — never
 * depends on the stream: `ensureStarted` and the process exit cover a Codex that
 * printed nothing at all.
 *
 * Never throws. A malformed line or an unknown event is skipped and counted.
 */
import { MAX_INLINE_PAYLOAD_BYTES, type RouteUsage } from "@nightshift/contracts";
import { type Clock, nowIso } from "@nightshift/core";
import type { HookEvent, HookEventType, HookSink } from "@nightshift/harness";

const MAX_SUMMARY_CHARS = 300;
const MAX_NAME_CHARS = 120;

/** Well under the inline bound, so context fields never push an event over it. */
export const MAX_HOOK_PAYLOAD_BYTES = Math.floor(MAX_INLINE_PAYLOAD_BYTES / 4);

type Frame = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is Frame =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;

const truncate = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

export const optionalField = (key: string, value: unknown): Record<string, unknown> =>
  value === undefined ? {} : { [key]: value };

/** What the interpreter learned from the stream, for the exit mapping. */
export interface StreamOutcome {
  /** True once a `turn.completed` has been seen: Codex's own clean ending. */
  readonly turnCompleted: boolean;
  /** The message of a `turn.failed` or a top-level `error`, when there was one. */
  readonly failure?: string;
  /** Codex's own session identifier, from `thread.started`. */
  readonly threadId?: string;
  /** Token counts, summed over every completed turn. Absent until one reports. */
  readonly usage?: RouteUsage;
  readonly startEmitted: boolean;
  readonly unparseableLines: number;
}

export interface StreamInterpreterInput {
  readonly sink: HookSink;
  readonly clock: Clock;
  /** Extra fields merged into every payload. */
  readonly context?: Readonly<Record<string, unknown>>;
}

export interface StreamInterpreter {
  /** Feed raw stdout bytes. Safe at any chunk boundary, including mid-line. */
  write(chunk: Uint8Array): void;
  /** Flush a trailing line with no newline. Call once, when the pipe closes. */
  end(): void;
  /** Emit `agent.started` if `thread.started` never arrived. Idempotent. */
  ensureStarted(payload?: Readonly<Record<string, unknown>>): void;
  /** Emit one event directly. Used by the adapter for the ending. */
  emit(type: HookEventType, payload: Readonly<Record<string, unknown>>): void;
  readonly outcome: StreamOutcome;
}

/** A payload over the bound, replaced by one that says so. */
const bound = (payload: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> => {
  const size = new TextEncoder().encode(JSON.stringify(payload)).byteLength;
  return size <= MAX_HOOK_PAYLOAD_BYTES ? payload : { truncated: true, originalBytes: size };
};

export const createStreamInterpreter = (input: StreamInterpreterInput): StreamInterpreter => {
  const decoder = new TextDecoder("utf-8");
  let pending = "";
  let turnCompleted = false;
  let failure: string | undefined;
  let threadId: string | undefined;
  let usage: RouteUsage | undefined;
  let startEmitted = false;
  let unparseableLines = 0;

  const emit = (type: HookEventType, payload: Readonly<Record<string, unknown>>): void => {
    const event: HookEvent = {
      type,
      occurredAt: nowIso(input.clock),
      payload: bound({ ...input.context, ...payload }),
    };
    try {
      input.sink.emit(event);
    } catch {
      // A sink is documented never to throw. One that does must not end a run.
    }
  };

  const ensureStarted = (payload: Readonly<Record<string, unknown>> = {}): void => {
    if (startEmitted) return;
    startEmitted = true;
    emit("agent.started", { harness: "codex", ...payload });
  };

  /** The tool an item stands for, and a bounded line about it. */
  const describe = (item: Frame): { tool: string; summary?: string } | undefined => {
    switch (str(item.type)) {
      case "command_execution":
        return { tool: "shell", ...optionalField("summary", summarise(str(item.command))) };
      case "mcp_tool_call":
        return {
          tool: truncate(
            `${str(item.server) ?? "mcp"}.${str(item.tool) ?? "unknown"}`,
            MAX_NAME_CHARS,
          ),
        };
      case "file_change": {
        const changes = Array.isArray(item.changes) ? item.changes.filter(isRecord) : [];
        const paths = changes
          .map((change) => str(change.path))
          .filter((path) => path !== undefined);
        return { tool: "apply_patch", ...optionalField("summary", summarise(paths.join(", "))) };
      }
      case "web_search":
        return { tool: "web_search", ...optionalField("summary", summarise(str(item.query))) };
      default:
        return undefined;
    }
  };

  const summarise = (text: string | undefined): string | undefined =>
    text === undefined || text === "" ? undefined : truncate(text, MAX_SUMMARY_CHARS);

  const succeeded = (item: Frame): boolean => {
    if (str(item.type) === "command_execution") return item.exit_code === 0;
    if (item.error !== null && item.error !== undefined) return false;
    return str(item.status) !== "failed";
  };

  const handleItem = (phase: "started" | "completed", item: Frame): void => {
    const described = describe(item);
    if (described === undefined) return;
    const id = optionalField("toolUseId", str(item.id));
    const pairedOnCompletion = str(item.type) === "file_change" || str(item.type) === "web_search";

    if (phase === "started" || pairedOnCompletion) {
      if (phase === "started" && pairedOnCompletion) return;
      emit("tool.called", { ...described, ...id });
    }
    if (phase === "completed") {
      emit("tool.completed", {
        tool: described.tool,
        ...id,
        ok: succeeded(item),
        ...optionalField("exitCode", count(item.exit_code)),
      });
    }
  };

  const addUsage = (reported: Frame): void => {
    const input_ = count(reported.input_tokens);
    const output = count(reported.output_tokens);
    if (input_ === undefined && output === undefined) return;
    usage = {
      ...optionalField("inputTokens", (usage?.inputTokens ?? 0) + (input_ ?? 0)),
      ...optionalField("outputTokens", (usage?.outputTokens ?? 0) + (output ?? 0)),
    };
  };

  /** One line as a frame, or `undefined` for a blank, malformed or non-object line. */
  const parse = (line: string): Frame | undefined => {
    if (line.trim() === "") return undefined;
    try {
      const frame: unknown = JSON.parse(line);
      return isRecord(frame) ? frame : undefined;
    } catch {
      unparseableLines += 1;
      return undefined;
    }
  };

  const failureOf = (frame: Frame): string =>
    truncate(
      (isRecord(frame.error) ? str(frame.error.message) : str(frame.message)) ??
        "codex reported a failure",
      MAX_SUMMARY_CHARS,
    );

  const handleLine = (line: string): void => {
    const frame = parse(line);
    if (frame === undefined) return;

    switch (str(frame.type)) {
      case "thread.started":
        threadId = str(frame.thread_id);
        ensureStarted(optionalField("sessionId", threadId));
        return;
      case "item.started":
        if (isRecord(frame.item)) handleItem("started", frame.item);
        return;
      case "item.completed":
        if (isRecord(frame.item)) handleItem("completed", frame.item);
        return;
      case "turn.completed":
        turnCompleted = true;
        if (isRecord(frame.usage)) addUsage(frame.usage);
        return;
      case "turn.failed":
        failure = failureOf(frame);
        return;
      case "error":
        failure ??= failureOf(frame);
        return;
      default:
        return;
    }
  };

  return {
    write: (chunk) => {
      pending += decoder.decode(chunk, { stream: true });
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) handleLine(line);
    },
    end: () => {
      pending += decoder.decode();
      const last = pending;
      pending = "";
      handleLine(last);
    },
    ensureStarted,
    emit,
    get outcome(): StreamOutcome {
      return {
        turnCompleted,
        ...optionalField("failure", failure),
        ...optionalField("threadId", threadId),
        ...optionalField("usage", usage),
        startEmitted,
        unparseableLines,
      } as StreamOutcome;
    },
  };
};
