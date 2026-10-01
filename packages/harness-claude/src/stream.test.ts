/**
 * The stream parser, tested against a **real recording**.
 *
 * `__fixtures__/claude-stream-success.jsonl` is the verbatim stdout of one
 * headless `claude -p` run on Claude Code 2.1.273, recorded on 2026-09-15 with
 * this adapter's own command line against a throwaway git repository holding two
 * small files. The run was chosen to exercise the whole lifecycle in one stream:
 * it reads a file, spawns a sub-agent, edits a file, calls two Nightshift MCP
 * tools through a stdio server that registered the worker role's tool names, and
 * finishes with a success result.
 *
 * The only edit made to it is redaction: absolute paths naming the recording
 * machine's user were replaced with placeholder paths, and the auto-memory path
 * with a placeholder. No frame, field or ordering was changed, nothing was
 * inserted, and it was checked for tokens and keys before being committed.
 *
 * A compaction is the one lifecycle event a recording cannot reasonably carry —
 * it needs a context far larger than a 23 KB fixture — so its frame is written
 * out literally below, from the schema read out of the installed CLI itself:
 * `system` / `compact_boundary` with a `compact_metadata` of `trigger`
 * (`manual` | `auto`), `pre_tokens` and an optional `post_tokens`. It is marked
 * as such where it appears.
 */

import { readFileSync } from "node:fs";
import { MAX_INLINE_PAYLOAD_BYTES } from "@nightshift/contracts";
import { createSteppingClock } from "@nightshift/core";
import type { HookEvent } from "@nightshift/harness";
import { recordingHookSink } from "@nightshift/harness";
import { describe, expect, it } from "vitest";
import {
  boundPayload,
  createStreamInterpreter,
  MAX_HOOK_PAYLOAD_BYTES,
  summariseToolInput,
  summariseToolResult,
} from "./stream.js";

const RECORDING = readFileSync(
  new URL("./__fixtures__/claude-stream-success.jsonl", import.meta.url),
  "utf8",
);

const encoder = new TextEncoder();

interface Run {
  readonly events: readonly HookEvent[];
  readonly interpreter: ReturnType<typeof createStreamInterpreter>;
}

/** Feed `text` to a fresh interpreter, optionally in chunks of `chunkSize` bytes. */
const play = (text: string, chunkSize?: number): Run => {
  const sink = recordingHookSink();
  const interpreter = createStreamInterpreter({
    sink,
    clock: createSteppingClock(Date.UTC(2026, 8, 15, 12, 0, 0), 1),
    context: { agentId: "agent_0000000000000000000001" },
  });
  const bytes = encoder.encode(text);
  const size = chunkSize ?? bytes.byteLength;
  for (let offset = 0; offset < bytes.byteLength; offset += size) {
    interpreter.write(bytes.subarray(offset, Math.min(offset + size, bytes.byteLength)));
  }
  interpreter.end();
  return { events: sink.events, interpreter };
};

const typesOf = (events: readonly HookEvent[]): readonly string[] => events.map((e) => e.type);

const firstOf = (events: readonly HookEvent[], type: string): HookEvent | undefined =>
  events.find((event) => event.type === type);

describe("the recorded stream: every lifecycle event the contract lists", () => {
  const run = play(RECORDING);

  it("produces agent.started from the init frame, exactly once and first", () => {
    expect(typesOf(run.events).filter((type) => type === "agent.started")).toHaveLength(1);
    expect(run.events[0]?.type).toBe("agent.started");
    expect(run.interpreter.outcome.startEmitted).toBe(true);
  });

  it("carries the session, model and MCP status Claude reported on that frame", () => {
    const started = firstOf(run.events, "agent.started");
    expect(started?.payload.sessionId).toBe("9cb83dd4-77b4-4d5d-91f4-b44452cfeb3a");
    expect(started?.payload.model).toBe("claude-sonnet-5");
    expect(started?.payload.harnessVersion).toBe("2.1.273");
    expect(started?.payload.mcpServers).toEqual([{ name: "nightshift", status: "connected" }]);
  });

  it("produces one tool.called per tool_use, naming the tool", () => {
    const called = run.events.filter((event) => event.type === "tool.called");
    expect(called.map((event) => event.payload.tool)).toEqual([
      "Read",
      "Agent",
      "Read",
      "Edit",
      "mcp__nightshift__job_progress",
      "mcp__nightshift__job_complete",
    ]);
  });

  it("produces one tool.completed per tool_result, attributed to the call that opened it", () => {
    const completed = run.events.filter((event) => event.type === "tool.completed");
    expect(completed).toHaveLength(6);
    expect(completed.map((event) => event.payload.tool)).toEqual([
      "Read",
      "Read",
      "Agent",
      "Edit",
      "mcp__nightshift__job_progress",
      "mcp__nightshift__job_complete",
    ]);
    for (const event of completed) expect(event.payload.ok).toBe(true);
  });

  it("pairs every completion with the tool_use_id of its call", () => {
    const calls = new Map(
      run.events
        .filter((event) => event.type === "tool.called")
        .map((event) => [event.payload.toolUseId, event.payload.tool]),
    );
    for (const event of run.events.filter((e) => e.type === "tool.completed")) {
      expect(calls.get(event.payload.toolUseId)).toBe(event.payload.tool);
    }
  });

  it("produces exactly one agent.subagent_created for the one sub-agent, with its type", () => {
    const created = run.events.filter((event) => event.type === "agent.subagent_created");
    expect(created).toHaveLength(1);
    // The stream reports a sub-agent twice — the `tool_use` and then a
    // `system`/`task_started` naming the same `tool_use_id`. One event, not two.
    expect(created[0]?.payload.toolUseId).toBe("toolu_01Xyzc9i9WAgG49m6vjoedjZ");
  });

  it("orders the sub-agent event after the tool call that created it", () => {
    const types = typesOf(run.events);
    expect(types.indexOf("agent.subagent_created")).toBeGreaterThan(types.indexOf("tool.called"));
  });

  it("records the run as a non-error result, which is what completion requires", () => {
    expect(run.interpreter.outcome.sawResult).toBe(true);
    expect(run.interpreter.outcome.resultErrored).toBe(false);
    expect(run.interpreter.outcome.resultSubtype).toBe("success");
    expect(run.interpreter.outcome.terminalReason).toBe("completed");
  });

  it("emits no ending of its own: the ending belongs to the process exit", () => {
    for (const ending of [
      "agent.completed",
      "agent.failed",
      "agent.cancelled",
      "agent.interrupted",
    ]) {
      expect(typesOf(run.events)).not.toContain(ending);
    }
  });

  it("emits nothing for the frames that carry no contract event", () => {
    // `rate_limit_event`, `task_progress`, `task_updated`, `task_notification`
    // and the assistant's thinking and text blocks are all present in the
    // recording and all produce nothing.
    expect(new Set(typesOf(run.events))).toEqual(
      new Set(["agent.started", "tool.called", "tool.completed", "agent.subagent_created"]),
    );
  });

  it("attaches the adapter's context to every event", () => {
    for (const event of run.events) {
      expect(event.payload.agentId).toBe("agent_0000000000000000000001");
      expect(Date.parse(event.occurredAt)).not.toBeNaN();
    }
  });

  it("counts no unparseable line in a real recording", () => {
    expect(run.interpreter.outcome.unparseableLines).toBe(0);
  });
});

describe("chunk boundaries", () => {
  it.each([1, 7, 64, 997, 8192])(
    "produces the same events when the same bytes arrive %i at a time",
    (size) => {
      expect(typesOf(play(RECORDING, size).events)).toEqual(typesOf(play(RECORDING).events));
    },
  );

  it("handles a final line with no trailing newline", () => {
    const withoutTrailing = RECORDING.trimEnd();
    expect(play(withoutTrailing).interpreter.outcome.sawResult).toBe(true);
  });

  it("does not split a multi-byte character across a chunk boundary", () => {
    const frame = `${JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "echo ✅ dôné" } }],
      },
    })}\n`;
    const events = play(frame, 3).events;
    expect(events[0]?.payload.summary).toBe("echo ✅ dôné");
  });
});

describe("a stream that ends without a result", () => {
  it("reports no result, which the adapter maps to failed", () => {
    const truncated = RECORDING.split("\n").slice(0, 10).join("\n");
    const run = play(truncated);
    expect(run.interpreter.outcome.sawResult).toBe(false);
    expect(run.interpreter.outcome.resultErrored).toBe(false);
    // The start still arrived, which is the half of D-P3-09 the stream owns.
    expect(typesOf(run.events)).toContain("agent.started");
  });

  it("reports no result for an empty stream either", () => {
    const run = play("");
    expect(run.interpreter.outcome.sawResult).toBe(false);
    expect(run.interpreter.outcome.startEmitted).toBe(false);
    expect(run.events).toHaveLength(0);
  });
});

describe("a result that reports an error", () => {
  // Measured, not invented: a SIGINT-interrupted `claude -p` exits 0 and prints
  // this frame. Exit code zero therefore cannot mean completion on its own.
  const interrupted = `${JSON.stringify({
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    terminal_reason: "aborted_streaming",
    num_turns: 1,
  })}\n`;

  it("is recorded as an error, so exit 0 does not read as completion", () => {
    const outcome = play(interrupted).interpreter.outcome;
    expect(outcome.sawResult).toBe(true);
    expect(outcome.resultErrored).toBe(true);
    expect(outcome.terminalReason).toBe("aborted_streaming");
  });

  it("treats a result whose subtype is not success as an error even without is_error", () => {
    const frame = `${JSON.stringify({ type: "result", subtype: "error_max_turns" })}\n`;
    expect(play(frame).interpreter.outcome.resultErrored).toBe(true);
  });
});

describe("compaction", () => {
  /**
   * SYNTHETIC FRAME — not from the recording. Written from the zod schema in the
   * installed CLI: `compact_metadata` is `{ trigger: "manual" | "auto",
   * pre_tokens: int, post_tokens?: int }`. A recording that contained a real
   * compaction would have to carry a full context window.
   */
  const boundary = `${JSON.stringify({
    type: "system",
    subtype: "compact_boundary",
    session_id: "9cb83dd4-77b4-4d5d-91f4-b44452cfeb3a",
    uuid: "00000000-0000-4000-8000-000000000000",
    compact_metadata: { trigger: "auto", pre_tokens: 184_320, post_tokens: 42_100 },
  })}\n`;

  it("produces agent.context_compacted with the trigger and the token counts", () => {
    const events = play(boundary).events;
    expect(typesOf(events)).toEqual(["agent.context_compacted"]);
    expect(events[0]?.payload).toMatchObject({
      trigger: "auto",
      preTokens: 184_320,
      postTokens: 42_100,
    });
  });

  it("produces the event even when the metadata is missing fields", () => {
    const bare = `${JSON.stringify({
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { trigger: "manual", pre_tokens: 1 },
    })}\n`;
    const events = play(bare).events;
    expect(typesOf(events)).toEqual(["agent.context_compacted"]);
    expect(events[0]?.payload.postTokens).toBeUndefined();
  });

  it("produces one per compaction, not one per run", () => {
    expect(typesOf(play(boundary + boundary).events)).toEqual([
      "agent.context_compacted",
      "agent.context_compacted",
    ]);
  });
});

describe("a sub-agent reported only by task_started", () => {
  it("is still reported once, when its tool_use was never seen", () => {
    const frame = `${JSON.stringify({
      type: "system",
      subtype: "task_started",
      task_id: "a587581d0b6700c99",
      tool_use_id: "toolu_unseen",
      description: "Background sweep",
      subagent_type: "general-purpose",
      spawn_depth: 1,
    })}\n`;
    const events = play(frame).events;
    expect(typesOf(events)).toEqual(["agent.subagent_created"]);
    expect(events[0]?.payload).toMatchObject({
      toolUseId: "toolu_unseen",
      subagentType: "general-purpose",
      depth: 1,
      summary: "Background sweep",
    });
  });

  it("recognises both spellings the CLI uses for the sub-agent tool", () => {
    for (const name of ["Task", "Agent"]) {
      const frame = `${JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", id: `t-${name}`, name, input: {} }] },
      })}\n`;
      expect(typesOf(play(frame).events)).toEqual(["tool.called", "agent.subagent_created"]);
    }
  });
});

describe("malformed input", () => {
  it("skips an unparseable line, counts it, and keeps parsing", () => {
    const text = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "s" }),
      "{ this is not json",
      JSON.stringify({ type: "result", subtype: "success", is_error: false }),
      "",
    ].join("\n");
    const run = play(text);
    expect(run.interpreter.outcome.unparseableLines).toBe(1);
    expect(run.interpreter.outcome.sawResult).toBe(true);
    expect(typesOf(run.events)).toEqual(["agent.started"]);
  });

  it("ignores a frame that is valid JSON but not an object", () => {
    expect(play('"just a string"\n42\nnull\n[]\n').events).toHaveLength(0);
  });

  it("ignores a tool_use with no name and a tool_result with no id", () => {
    const text = [
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "t1" }, "not a block", 7] },
      }),
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result" }] } }),
      "",
    ].join("\n");
    const events = play(text).events;
    expect(typesOf(events)).toEqual(["tool.completed"]);
    expect(events[0]?.payload.tool).toBeUndefined();
  });

  it("does not throw when a sink throws", () => {
    const interpreter = createStreamInterpreter({
      sink: {
        emit: () => {
          throw new Error("a misbehaving outbox");
        },
      },
      clock: createSteppingClock(0, 1),
    });
    expect(() => interpreter.write(encoder.encode(RECORDING))).not.toThrow();
    expect(() => interpreter.end()).not.toThrow();
  });

  it("does not throw when ensureStarted is called twice", () => {
    const sink = recordingHookSink();
    const interpreter = createStreamInterpreter({ sink, clock: createSteppingClock(0, 1) });
    interpreter.ensureStarted();
    interpreter.ensureStarted();
    expect(sink.events.filter((e) => e.type === "agent.started")).toHaveLength(1);
  });

  it("does not emit a second agent.started when the init frame arrives after ensureStarted", () => {
    const sink = recordingHookSink();
    const interpreter = createStreamInterpreter({ sink, clock: createSteppingClock(0, 1) });
    interpreter.ensureStarted({ summary: "synthesised" });
    interpreter.write(encoder.encode(RECORDING));
    interpreter.end();
    expect(sink.events.filter((e) => e.type === "agent.started")).toHaveLength(1);
  });
});

describe("the inline payload bound", () => {
  it("is well under the execution layer's ceiling", () => {
    expect(MAX_HOOK_PAYLOAD_BYTES).toBeLessThan(MAX_INLINE_PAYLOAD_BYTES);
    expect(MAX_HOOK_PAYLOAD_BYTES).toBe(2048);
  });

  it("holds for every event from the real recording", () => {
    for (const event of play(RECORDING).events) {
      const size = encoder.encode(JSON.stringify(event.payload)).length;
      expect(size, `${event.type} payload was ${size} bytes`).toBeLessThanOrEqual(
        MAX_HOOK_PAYLOAD_BYTES,
      );
    }
  });

  it("holds when a tool is handed a file's entire contents", () => {
    // `Write` is the case that matters: its `content` is the whole file, and a
    // 200 KB file would be 25 events' worth of inline payload if it got through.
    const frame = `${JSON.stringify({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "t1",
            name: "Write",
            input: { file_path: "/w/big.ts", content: "x".repeat(200_000) },
          },
        ],
      },
    })}\n`;
    const events = play(frame).events;
    expect(encoder.encode(JSON.stringify(events[0]?.payload)).length).toBeLessThanOrEqual(
      MAX_HOOK_PAYLOAD_BYTES,
    );
    // And the useful field survived.
    expect(events[0]?.payload.summary).toBe("/w/big.ts");
  });

  it("holds when a tool result is enormous", () => {
    const frame = `${JSON.stringify({
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "y".repeat(500_000), is_error: true },
        ],
      },
    })}\n`;
    const events = play(frame).events;
    expect(encoder.encode(JSON.stringify(events[0]?.payload)).length).toBeLessThanOrEqual(
      MAX_HOOK_PAYLOAD_BYTES,
    );
    expect(events[0]?.payload.ok).toBe(false);
  });

  it("keeps the identifiers when it has to drop something", () => {
    const bounded = boundPayload({
      tool: "Bash",
      toolUseId: "toolu_1",
      summary: "z".repeat(20_000),
    });
    expect(bounded.tool).toBe("Bash");
    expect(bounded.toolUseId).toBe("toolu_1");
    expect(encoder.encode(JSON.stringify(bounded)).length).toBeLessThanOrEqual(
      MAX_HOOK_PAYLOAD_BYTES,
    );
  });

  it("leaves a payload that already fits untouched", () => {
    const payload = { tool: "Read", ok: true };
    expect(boundPayload(payload)).toEqual(payload);
  });

  it("drops an oversized value that is not a summary rather than exceeding the bound", () => {
    const bounded = boundPayload({ tool: "Read", tools: Array.from({ length: 5_000 }, () => "x") });
    expect(bounded.tool).toBe("Read");
    expect(encoder.encode(JSON.stringify(bounded)).length).toBeLessThanOrEqual(
      MAX_HOOK_PAYLOAD_BYTES,
    );
  });
});

describe("tool summaries", () => {
  it("picks the field a human would want, per tool", () => {
    expect(summariseToolInput("Bash", { command: "npm test" })).toBe("npm test");
    expect(summariseToolInput("Read", { file_path: "/w/a.ts" })).toBe("/w/a.ts");
    expect(summariseToolInput("Edit", { file_path: "/w/a.ts", new_string: "…" })).toBe("/w/a.ts");
    expect(summariseToolInput("Glob", { pattern: "**/*.ts" })).toBe("**/*.ts");
    expect(summariseToolInput("Grep", { pattern: "TODO", path: "src" })).toBe("TODO in src");
    expect(
      summariseToolInput("Agent", { subagent_type: "general-purpose", description: "Sweep" }),
    ).toBe("general-purpose: Sweep");
  });

  it("falls back to key names for an unknown tool, never to its values", () => {
    const summary = summariseToolInput("mcp__nightshift__job_fail", {
      secretish: "a".repeat(9_000),
    });
    expect(summary).toBe("secretish");
  });

  it("prefers a description for an unknown tool that has one", () => {
    expect(summariseToolInput("SomeNewTool", { description: "does a thing" })).toBe("does a thing");
  });

  it("returns nothing for input that is not an object, or is empty", () => {
    expect(summariseToolInput("Bash", "nope")).toBeUndefined();
    expect(summariseToolInput("Bash", {})).toBeUndefined();
  });

  it("reads a tool result whether it is a string or content blocks", () => {
    expect(summariseToolResult("done")).toBe("done");
    expect(summariseToolResult([{ type: "text", text: "line one" }])).toBe("line one");
    expect(summariseToolResult([{ type: "image", source: {} }])).toBe("[image]");
    expect(summariseToolResult(undefined)).toBeUndefined();
    expect(summariseToolResult([])).toBeUndefined();
  });

  it("truncates rather than growing without bound", () => {
    const summary = summariseToolInput("Bash", { command: "echo ".repeat(1_000) });
    expect(summary?.length).toBeLessThanOrEqual(400);
    expect(summary?.endsWith("…")).toBe(true);
  });
});

describe("usage, from the result frame (contract v1)", () => {
  const usageOf = (frame: Record<string, unknown>) => {
    const interpreter = createStreamInterpreter({
      sink: { emit: () => {} },
      clock: { now: () => 0 },
    });
    interpreter.write(new TextEncoder().encode(`${JSON.stringify(frame)}\n`));
    return interpreter.outcome.usage;
  };

  it("reads tokens, cost and duration, each only where the frame carries it", () => {
    expect(
      usageOf({
        type: "result",
        subtype: "success",
        duration_ms: 1200,
        total_cost_usd: 0.25,
        usage: { input_tokens: 40, output_tokens: 7, cache_read_input_tokens: 9000 },
      }),
    ).toEqual({
      inputTokens: 40,
      outputTokens: 7,
      cacheReadTokens: 9000,
      actualCostUsd: 0.25,
      latencyMs: 1200,
    });
    expect(usageOf({ type: "result", subtype: "success", total_cost_usd: 0.5 })).toEqual({
      actualCostUsd: 0.5,
    });
  });

  it("reports none rather than zeros when the frame says nothing, or nonsense", () => {
    expect(usageOf({ type: "result", subtype: "success" })).toBeUndefined();
    expect(
      usageOf({ type: "result", subtype: "success", usage: { input_tokens: "many" } }),
    ).toBeUndefined();
  });

  it("keeps what an interrupted run spent", () => {
    expect(
      usageOf({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        usage: { input_tokens: 3, output_tokens: 1 },
      }),
    ).toEqual({ inputTokens: 3, outputTokens: 1 });
  });
});

describe("a route that could not start (P8, D-P8-06)", () => {
  // Recorded on 2.1.282 with `--model claude-nonexistent-9`: an error result,
  // `terminal_reason: "api_error"` and the provider's status, before any tool.
  const refusal = (status: number) =>
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: true,
      terminal_reason: "api_error",
      api_error_status: status,
      result:
        "There's an issue with the selected model (claude-nonexistent-9). It may not exist or you may not have access to it.",
    });

  it("is read from a provider refusal before any tool was called", () => {
    const { interpreter } = play(`${refusal(404)}\n`);
    expect(interpreter.outcome.unavailable).toBe(
      "the provider answered 404 before any work began: There's an issue with the selected model (claude-nonexistent-9). It may not exist or you may not have access to it.",
    );
  });

  it("is not claimed once a tool has been called: that run started, and failed", () => {
    const toolUse = JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }],
      },
    });
    expect(play(`${toolUse}\n${refusal(429)}\n`).interpreter.outcome.unavailable).toBeUndefined();
  });

  it("is not claimed for an error that is not the route's", () => {
    expect(play(`${refusal(500)}\n`).interpreter.outcome.unavailable).toBeUndefined();
  });
});

describe("a session kept open for its background work (recorded on 2.1.286)", () => {
  // A real streaming-input session: a turn that started a background command
  // and went idle, then the turn Claude Code started on its own when the
  // command finished. Two `result` frames, one session.
  const BACKGROUND = readFileSync(
    new URL("./__fixtures__/claude-stream-background.jsonl", import.meta.url),
    "utf8",
  );

  const playWithActivity = (text: string) => {
    const activity: { idle: boolean; backgroundTasks: number; finished: boolean }[] = [];
    const sink = recordingHookSink();
    const interpreter = createStreamInterpreter({
      sink,
      clock: createSteppingClock(Date.UTC(2026, 8, 30, 12, 0, 0), 1),
      onActivity: (a) => activity.push(a),
    });
    interpreter.write(encoder.encode(text));
    interpreter.end();
    return { activity, events: sink.events, interpreter };
  };

  it("adds up both turns' tokens and keeps the session's running cost", () => {
    const { interpreter } = playWithActivity(BACKGROUND);
    expect(interpreter.outcome.usage).toMatchObject({
      inputTokens: 28 + 10,
      outputTokens: 447 + 90,
      actualCostUsd: 0.023465800000000002,
    });
    expect(interpreter.outcome.resultText).toBe("FINISHED");
  });

  it("reports idleness and the background task list as they change", () => {
    const { activity } = playWithActivity(BACKGROUND);
    expect(activity).toContainEqual({ idle: true, backgroundTasks: 1, finished: false });
    expect(activity.at(-1)).toEqual({ idle: true, backgroundTasks: 0, finished: false });
  });

  it("still knows a turn has ended when Claude Code emits no session state", () => {
    // `session_state_changed` is emitted only when asked for; a session must
    // still close without it, from the `result` that ends each turn.
    const withoutState = BACKGROUND.split("\n")
      .filter((line) => !line.includes('"session_state_changed"'))
      .join("\n");
    const { activity } = playWithActivity(withoutState);
    expect(activity).toContainEqual({ idle: true, backgroundTasks: 1, finished: false });
    expect(activity).toContainEqual({ idle: false, backgroundTasks: 0, finished: false });
    expect(activity.at(-1)).toEqual({ idle: true, backgroundTasks: 0, finished: false });
  });

  it("does not report a background shell command as a sub-agent", () => {
    const { events } = playWithActivity(BACKGROUND);
    expect(typesOf(events)).not.toContain("agent.subagent_created");
  });
});
