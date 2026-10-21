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
import {
  MAX_INLINE_PAYLOAD_BYTES,
  type MeasurementObservation,
  MeasurementObservationSchema,
} from "@nightshift/contracts";
import {
  countersFromRouteUsage,
  createSteppingClock,
  reconcileSegment,
  reconcileSegments,
} from "@nightshift/core";
import type { HarnessObservation, HookEvent } from "@nightshift/harness";
import { recordingHookSink, recordingMeasurementSink } from "@nightshift/harness";
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
    expect(
      play(`${toolUse}
${refusal(404)}
`).interpreter.outcome.unavailable,
    ).toBeUndefined();
  });

  it("is claimed for a usage limit even after work began, with the work said to have begun", () => {
    const toolUse = JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }],
      },
    });
    const outcome = play(`${toolUse}
${refusal(429)}
`).interpreter.outcome;
    expect(outcome.unavailable).toMatch(/^the provider answered 429 after work began: /);
    expect(outcome.workBegan).toBe(true);
  });

  // The shape of a subscription's session limit, as Claude Code records it
  // (2026-10): a rejecting `rate_limit_event`, then an assistant message with
  // `error: "rate_limit"` and the words the human would see.
  const limitFrames = (resultStatus?: number): string =>
    [
      { type: "system", subtype: "init", session_id: "s1" },
      {
        type: "assistant",
        message: {
          content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }],
        },
      },
      {
        type: "rate_limit_event",
        rate_limit_info: { status: "rejected", resetsAt: 1789162800, rateLimitType: "five_hour" },
      },
      {
        type: "assistant",
        error: "rate_limit",
        message: {
          content: [
            {
              type: "text",
              text: "You've hit your session limit · resets 2:40pm (America/Los_Angeles)",
            },
          ],
        },
      },
      {
        type: "result",
        subtype: "success",
        is_error: true,
        ...(resultStatus === undefined
          ? {}
          : { terminal_reason: "api_error", api_error_status: resultStatus }),
        result: "You've hit your session limit · resets 2:40pm (America/Los_Angeles)",
      },
    ]
      .map((frame) => JSON.stringify(frame))
      .join("\n");

  it("reads a session limit and when it resets, with or without a status on the result", () => {
    for (const status of [429, undefined]) {
      const outcome = play(`${limitFrames(status)}
`).interpreter.outcome;
      expect(outcome.unavailable).toBe(
        "the provider answered 429 after work began: You've hit your session limit · resets 2:40pm (America/Los_Angeles)",
      );
      expect(outcome.availableAgainAt).toBe(new Date(1789162800 * 1000).toISOString());
      expect(outcome.workBegan).toBe(true);
    }
  });

  it("ignores a rate limit that allowed the request", () => {
    const allowed = JSON.stringify({
      type: "rate_limit_event",
      rate_limit_info: { status: "allowed_warning", resetsAt: 1789162800 },
    });
    const failed = JSON.stringify({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
    });
    expect(
      play(`${allowed}
${failed}
`).interpreter.outcome.unavailable,
    ).toBeUndefined();
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

// ---------------------------------------------------------------------------
// Measurement capture (P20)
// ---------------------------------------------------------------------------

const fixture = (name: string): string =>
  readFileSync(new URL(`./__fixtures__/stream/${name}`, import.meta.url), "utf8");

const measure = (text: string, streamRequests?: boolean) => {
  const measurements = recordingMeasurementSink();
  const sink = recordingHookSink();
  const interpreter = createStreamInterpreter({
    sink,
    clock: createSteppingClock(Date.UTC(2026, 8, 15, 12, 0, 0), 1),
    measurements,
    ...(streamRequests === undefined ? {} : { streamRequests }),
  });
  interpreter.write(encoder.encode(text));
  interpreter.end();
  return { observations: measurements.observations, outcome: interpreter.outcome };
};

/** What the recorder stamps, so the contract schema can be applied. */
const stamp = (observation: HarnessObservation): unknown => ({
  ...observation,
  projectId: "proj_00000000000000000000000001",
  programId: "prog_00000000000000000000000001",
  runId: "run_00000000000000000000000001",
  executionNodeId: "node_00000000000000000000000001",
  receivedAt: "2026-09-15T12:00:00.000Z",
});

const frameLine = (frame: unknown): string => `${JSON.stringify(frame)}\n`;

describe("measurement observations from the stream", () => {
  it("emits one request for four assistant frames sharing a message id, with no outputTokens", () => {
    const frame = {
      type: "assistant",
      message: {
        id: "msg_shared",
        model: "claude-sonnet-5",
        content: [],
        usage: {
          input_tokens: 5,
          output_tokens: 1,
          cache_read_input_tokens: 7,
          cache_creation_input_tokens: 9,
        },
      },
    };
    const { observations } = measure(frameLine(frame).repeat(4), true);
    expect(observations).toHaveLength(1);
    const [request] = observations;
    expect(request).toMatchObject({
      kind: "request",
      requestId: "msg_shared",
      observationId: "claude:assistant:msg_shared",
      inclusion: "self",
      model: "claude-sonnet-5",
      counters: {
        inputTokens: 5,
        cacheReadTokens: 7,
        cacheWriteTokens: 9,
        inputIncludesCache: false,
      },
    });
    expect(request?.kind === "request" && "outputTokens" in request.counters).toBe(false);
  });

  it("emits a session-scoped includes_children snapshot equal to the modelUsage sum", () => {
    const { observations, outcome } = measure(fixture("subagent.jsonl"));
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      kind: "cumulative_snapshot",
      counterScope: "session",
      inclusion: "includes_children",
      sessionId: "sess-subagent",
      observationId: "claude:result:00000000-0000-4000-8000-000000000001",
      source: "harness",
      provenance: { adapter: "claude", version: "2.1.286" },
      counters: {
        inputTokens: 72,
        cacheReadTokens: 1300,
        cacheWriteTokens: 1000,
        outputTokens: 22,
        inputIncludesCache: false,
        reportedUsd: 0.03,
      },
    });
    // Only one of the two models reports thinkingTokens, so the sum is unknown.
    const first = observations[0];
    expect(first?.kind === "cumulative_snapshot" && "reasoningTokens" in first.counters).toBe(
      false,
    );
    // The turn's own `usage` (22 input) is not emitted as anything.
    expect(JSON.stringify(observations)).not.toContain('"inputTokens":22,');
    expect(outcome.usage?.inputTokens).toBe(22);
  });

  it("emits no outputTokens in the snapshot or exit usage when modelUsage lacks it", () => {
    const text = frameLine({
      type: "result",
      subtype: "success",
      is_error: false,
      uuid: "00000000-0000-4000-8000-0000000000aa",
      session_id: "sess-partial",
      usage: { input_tokens: 3, output_tokens: 4 },
      modelUsage: {
        "claude-sonnet-5": {
          inputTokens: 12,
          cacheReadInputTokens: 2,
          cacheCreationInputTokens: 1,
        },
      },
    });
    const { observations, outcome } = measure(text);
    expect(observations).toHaveLength(1);
    const [snapshot] = observations;
    expect(snapshot?.kind === "cumulative_snapshot" && snapshot.counters).toEqual({
      inputTokens: 12,
      cacheReadTokens: 2,
      cacheWriteTokens: 1,
      inputIncludesCache: false,
    });
    expect(outcome.measures.usageScope).toBe("session");
    expect(outcome.measures.usage).toMatchObject({ inputTokens: 12 });
    expect(outcome.measures.usage).not.toHaveProperty("outputTokens");
  });

  it("emits a request with childRef for a sub-agent's assistant message", () => {
    const { observations } = measure(fixture("subagent.jsonl"), true);
    const requests = observations.filter((o) => o.kind === "request");
    expect(requests.map((r) => r.observationId)).toEqual([
      "claude:assistant:msg_sub_01",
      "claude:assistant:msg_child_01",
      "claude:assistant:msg_sub_02",
    ]);
    expect(requests[0]?.childRef).toBeUndefined();
    expect(requests[1]?.childRef).toEqual({ kind: "agent", id: "toolu_a1" });
    expect(requests[1]).toMatchObject({ model: "claude-haiku-4-5" });
  });

  it("sets contextWindowTokens only once a result has named the model's window", () => {
    const text = `${fixture("compaction.jsonl")}${frameLine({
      type: "assistant",
      message: {
        id: "msg_late",
        model: "claude-sonnet-5",
        content: [],
        usage: { input_tokens: 1 },
      },
    })}`;
    const requests = measure(text, true).observations.filter((o) => o.kind === "request");
    expect(requests.map((r) => r.kind === "request" && r.contextWindowTokens)).toEqual([
      undefined,
      undefined,
      200000,
    ]);
  });

  it("emits nothing for a <synthetic> assistant frame or a zeroed result", () => {
    const { observations, outcome } = measure(fixture("auth-failure.jsonl"), true);
    expect(observations).toEqual([]);
    expect(outcome.measures.resultCoverage).toBe("partial");
    expect(outcome.measures.observedModel).toBe("claude-sonnet-5");
  });

  it("emits no requests when streamRequests is false, but still the snapshot", () => {
    const { observations } = measure(fixture("compaction.jsonl"), false);
    expect(observations.map((o) => o.kind)).toEqual(["cumulative_snapshot"]);
  });

  it("emits nothing without a sink", () => {
    const interpreter = createStreamInterpreter({
      sink: recordingHookSink(),
      clock: createSteppingClock(0, 1),
      streamRequests: true,
    });
    interpreter.write(encoder.encode(fixture("subagent.jsonl")));
    interpreter.end();
    expect(interpreter.outcome.measures.usageScope).toBe("session");
  });

  it("falls back to an ordinal observation id when a result has no uuid", () => {
    const { observations } = measure(fixture("resumed.jsonl").replace(/, "uuid": "[^"]*"/, ""));
    expect(observations[0]?.observationId).toBe("claude:result:sess-resumed:1");
  });

  it.each(["subagent", "compaction", "resumed", "interrupted", "no-result", "auth-failure"])(
    "every observation from %s parses and carries no text",
    (name) => {
      const { observations } = measure(fixture(`${name}.jsonl`), true);
      for (const observation of observations) {
        expect(() => MeasurementObservationSchema.parse(stamp(observation))).not.toThrow();
      }
      const serialized = JSON.stringify(observations);
      for (const text of ["placeholder", "/placeholder", "toolu_c1", "done"]) {
        expect(serialized).not.toContain(`"${text}"`);
      }
      expect(serialized).not.toContain("a.txt");
      expect(serialized).not.toContain('"input"');
    },
  );
});

describe("outcome.measures", () => {
  it("reports session scope, includes_children and complete for a resumed launch", () => {
    const { outcome, observations } = measure(fixture("resumed.jsonl"));
    expect(outcome.measures).toMatchObject({
      usageScope: "session",
      inclusion: "includes_children",
      resultCoverage: "complete",
      observedModel: "claude-sonnet-5",
      usage: {
        inputTokens: 1015,
        outputTokens: 806,
        cacheReadTokens: 52000,
        cacheWriteTokens: 9000,
        inputIncludesCache: false,
        actualCostUsd: 0.4,
        latencyMs: 1000,
      },
    });
    // The restored totals exceed the turn's own usage, which stays as it was.
    expect(outcome.usage).toMatchObject({ inputTokens: 15, outputTokens: 6 });
    expect(observations[0]).toMatchObject({
      counters: { inputTokens: 1015, reasoningTokens: 100 },
    });
  });

  it("covers a compaction run", () => {
    const { outcome, observations } = measure(fixture("compaction.jsonl"), true);
    expect(outcome.measures.resultCoverage).toBe("complete");
    expect(observations.map((o) => o.kind)).toEqual(["request", "request", "cumulative_snapshot"]);
  });

  it("reports an aborted_streaming result as partial, still with its session usage", () => {
    const { outcome } = measure(fixture("interrupted.jsonl"));
    expect(outcome.terminalReason).toBe("aborted_streaming");
    expect(outcome.measures.resultCoverage).toBe("partial");
    expect(outcome.measures.usageScope).toBe("session");
  });

  it("reports a stream with no result and no usage as unknown, launch/self", () => {
    const { outcome, observations } = measure(fixture("no-result.jsonl"), true);
    expect(outcome.measures).toEqual({
      usageScope: "launch",
      inclusion: "self",
      observedModel: "claude-sonnet-5",
      resultCoverage: "unknown",
    });
    expect(observations.map((o) => o.kind)).toEqual(["request"]);
  });

  const noModelUsage = (input: number, cost: number | undefined, extra: object = {}): string =>
    frameLine({ type: "system", subtype: "init", session_id: "s", model: "claude-sonnet-5" }) +
    frameLine({
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: "s",
      usage: { input_tokens: input },
      ...(cost === undefined ? {} : { total_cost_usd: cost }),
      ...extra,
    });

  it("falls back to launch scope without dollars and keeps them as a session snapshot", () => {
    const { outcome, observations } = measure(noModelUsage(50, 1.5));
    expect(outcome.measures).toMatchObject({
      usageScope: "launch",
      inclusion: "self",
      resultCoverage: "partial",
      usage: { inputTokens: 50 },
    });
    expect(outcome.measures.usage).not.toHaveProperty("actualCostUsd");
    expect(observations).toHaveLength(1);
    const [snapshot] = observations;
    expect(snapshot).toMatchObject({
      kind: "cumulative_snapshot",
      counterScope: "session",
      inclusion: "includes_children",
      sessionId: "s",
    });
    expect(snapshot?.kind === "cumulative_snapshot" && snapshot.counters).toEqual({
      reportedUsd: 1.5,
    });
    expect(
      MeasurementObservationSchema.safeParse(stamp(snapshot as HarnessObservation)).success,
    ).toBe(true);
  });

  it("emits no cost snapshot for zero or absent cost without modelUsage", () => {
    expect(measure(noModelUsage(5, 0)).observations).toEqual([]);
    expect(measure(noModelUsage(5, undefined)).observations).toEqual([]);
  });

  it("emits only the existing snapshot when modelUsage is usable", () => {
    const text = noModelUsage(5, 2, {
      modelUsage: { "claude-sonnet-5": { inputTokens: 12 } },
    });
    const { observations } = measure(text);
    expect(observations).toHaveLength(1);
    expect(observations[0]?.observationId).toMatch(/^claude:result:/);
  });

  it("does not double-count session-cumulative dollars across a resume", () => {
    const segment = (input: number, cost: number, resumed: boolean) => {
      const { observations, outcome } = measure(noModelUsage(input, cost));
      const m = outcome.measures;
      const stamped = observations.map((o) => stamp(o) as MeasurementObservation);
      stamped.push({
        ...(stamp({
          schemaVersion: 1,
          kind: "terminal_summary",
          observationId: `exit:${resumed ? 2 : 1}`,
          source: "engine",
          provenance: { adapter: "execution", note: "the harness exit" },
          inclusion: m.inclusion,
          counters: countersFromRouteUsage(m.usage ?? {}),
          counterScope: m.usageScope,
          exitKind: "completed",
          coverage: "partial",
        } as unknown as HarnessObservation) as object),
      } as MeasurementObservation);
      return stamped;
    };
    const first = reconcileSegment(segment(100, 1, false), { resumedSession: false });
    const second = reconcileSegment(segment(50, 1.5, true), {
      resumedSession: true,
      ...(first.sessionCumulative === undefined
        ? {}
        : { baseline: first.sessionCumulative.counters }),
    });
    const total = reconcileSegments([first, second]);
    expect(total.inputTokens).toBe(150);
    expect(total.reportedUsd).toBe(1.5);
    expect(first.gaps).toEqual([]);
    expect(second.gaps).toEqual([]);
  });

  describe("multi-turn results mixing modelUsage and fallback", () => {
    const resultFrame = (input: number, cost: number, uuid: string, modelUsage?: object) =>
      frameLine({
        type: "result",
        subtype: "success",
        is_error: false,
        uuid,
        session_id: "s",
        usage: { input_tokens: input },
        total_cost_usd: cost,
        ...(modelUsage === undefined ? {} : { modelUsage }),
      });
    const init = frameLine({
      type: "system",
      subtype: "init",
      session_id: "s",
      model: "claude-sonnet-5",
    });

    it("does not re-emit an earlier aggregate when a later turn lacks modelUsage", () => {
      const { observations, outcome } = measure(
        init +
          resultFrame(100, 1, "00000000-0000-4000-8000-000000000001", {
            m: { inputTokens: 100 },
          }) +
          resultFrame(50, 1.5, "00000000-0000-4000-8000-000000000002"),
      );
      const m = outcome.measures;
      expect(m).toMatchObject({
        usageScope: "launch",
        inclusion: "self",
        resultCoverage: "partial",
        observedModel: "claude-sonnet-5",
        usage: { inputTokens: 150 },
      });
      expect(m.usage).not.toHaveProperty("actualCostUsd");
      expect(m).not.toHaveProperty("counters");
      expect(observations).toHaveLength(2);
      expect(observations[0]).toMatchObject({
        kind: "cumulative_snapshot",
        counters: { inputTokens: 100, reportedUsd: 1 },
      });
      expect(observations[1]?.kind === "cumulative_snapshot" && observations[1].counters).toEqual({
        reportedUsd: 1.5,
      });

      // The recorder receives these in order, each at a later instant.
      const at = (n: number) => ({ receivedAt: `2026-09-15T12:00:0${n}.000Z` });
      const stamped = observations.map(
        (o, i) => ({ ...(stamp(o) as object), ...at(i) }) as MeasurementObservation,
      );
      stamped.push({
        ...(stamp({
          schemaVersion: 1,
          kind: "terminal_summary",
          observationId: "exit:1",
          source: "engine",
          provenance: { adapter: "execution", note: "the harness exit" },
          inclusion: m.inclusion,
          counters: countersFromRouteUsage(m.usage ?? {}),
          counterScope: m.usageScope,
          exitKind: "completed",
          coverage: "partial",
        } as unknown as HarnessObservation) as object),
        ...at(observations.length),
      } as MeasurementObservation);
      const reconciled = reconcileSegment(stamped, { resumedSession: false });
      expect(reconciled.counters.inputTokens).toBe(150);
      expect(reconciled.counters.reportedUsd).toBe(1.5);
    });

    it("reports the later modelUsage when the fallback result comes first", () => {
      const { outcome } = measure(
        init +
          resultFrame(50, 1, "00000000-0000-4000-8000-000000000001") +
          resultFrame(100, 1.5, "00000000-0000-4000-8000-000000000002", {
            m: { inputTokens: 120 },
          }),
      );
      expect(outcome.measures).toMatchObject({
        usageScope: "session",
        inclusion: "includes_children",
        resultCoverage: "complete",
        counters: { inputTokens: 120, reportedUsd: 1.5 },
      });
    });

    it("keeps the latest modelUsage across two usable results", () => {
      const { outcome } = measure(
        init +
          resultFrame(100, 1, "00000000-0000-4000-8000-000000000001", {
            m: { inputTokens: 100 },
          }) +
          resultFrame(50, 1.5, "00000000-0000-4000-8000-000000000002", {
            m: { inputTokens: 150 },
          }),
      );
      expect(outcome.measures).toMatchObject({
        usageScope: "session",
        counters: { inputTokens: 150, reportedUsd: 1.5 },
      });
    });
  });

  it("uses the init model when no assistant frame names one", () => {
    const init = fixture("no-result.jsonl").split("\n")[0] ?? "";
    expect(measure(`${init}\n`).outcome.measures.observedModel).toBe("claude-sonnet-5");
  });
});
