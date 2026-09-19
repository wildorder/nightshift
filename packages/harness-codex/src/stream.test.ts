/**
 * The stream interpreter against a **recorded** run (T3 deliverable 6).
 *
 * `__fixtures__/codex-stream-completing.jsonl` is the transcript of one real
 * headless run of the conformance suite's completing job on codex-cli 0.154.0:
 * exploration, a source edit, a test edit, a shell command, progress, a decision
 * and completion. Nothing in it was written by hand, so a grammar change in
 * Codex shows up here as a diff rather than as a guess.
 */
import { readFileSync } from "node:fs";
import type { HookEvent } from "@nightshift/harness";
import { describe, expect, it } from "vitest";
import { createStreamInterpreter, MAX_HOOK_PAYLOAD_BYTES } from "./stream.js";

const RECORDING = readFileSync(
  new URL("./__fixtures__/codex-stream-completing.jsonl", import.meta.url),
  "utf8",
);

const encoder = new TextEncoder();
const interpret = (text: string, chunkSize?: number) => {
  const events: HookEvent[] = [];
  const interpreter = createStreamInterpreter({
    sink: { emit: (event) => void events.push(event) },
    clock: { now: () => Date.parse("2026-09-19T00:00:00.000Z") },
    context: { agentId: "agent_1" },
  });
  const bytes = encoder.encode(text);
  const size = chunkSize ?? bytes.byteLength;
  for (let at = 0; at < bytes.byteLength; at += size) {
    interpreter.write(bytes.slice(at, at + size));
  }
  interpreter.end();
  return { events, outcome: interpreter.outcome };
};

const frames = (...values: readonly unknown[]): string =>
  values.map((value) => `${JSON.stringify(value)}\n`).join("");

describe("the recorded completing job", () => {
  const { events, outcome } = interpret(RECORDING);
  const called = events.filter((event) => event.type === "tool.called");
  const completed = events.filter((event) => event.type === "tool.completed");
  const tools = called.map((event) => String(event.payload.tool));

  it("starts once, from thread.started, with Codex's session id", () => {
    expect(events[0]?.type).toBe("agent.started");
    expect(events.filter((event) => event.type === "agent.started")).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({ harness: "codex", agentId: "agent_1" });
    expect(outcome.threadId).toMatch(/^[0-9a-f-]{36}$/);
    expect(events[0]?.payload.sessionId).toBe(outcome.threadId);
  });

  it("reports the worker's Nightshift tool calls by server and tool", () => {
    expect(tools).toContain("nightshift.job.progress");
    expect(tools).toContain("nightshift.decision.record");
    expect(tools).toContain("nightshift.job.complete");
    const complete = completed.find((event) => event.payload.tool === "nightshift.job.complete");
    expect(complete?.payload.ok).toBe(true);
  });

  it("reports shell commands, with a bounded summary and how each ended", () => {
    expect(tools).toContain("shell");
    const shell = completed.filter((event) => event.payload.tool === "shell");
    expect(shell.length).toBeGreaterThan(0);
    for (const event of shell) expect(typeof event.payload.ok).toBe("boolean");
    for (const event of called) {
      expect(String(event.payload.summary ?? "").length).toBeLessThanOrEqual(300);
    }
  });

  it("pairs every call with a completion", () => {
    expect(completed).toHaveLength(called.length);
    const ids = (list: readonly HookEvent[]) => list.map((event) => event.payload.toolUseId).sort();
    expect(ids(completed)).toEqual(ids(called));
  });

  it("emits no ending: the ending is the process's, never the stream's", () => {
    const endings = events.filter(
      (event) => event.type.startsWith("agent.") && event.type !== "agent.started",
    );
    expect(endings).toEqual([]);
  });

  it("knows the turn completed, and sums what it cost", () => {
    expect(outcome.turnCompleted).toBe(true);
    expect(outcome.failure).toBeUndefined();
    expect(outcome.usage?.inputTokens).toBeGreaterThan(0);
    expect(outcome.usage?.outputTokens).toBeGreaterThan(0);
    expect(outcome.unparseableLines).toBe(0);
  });

  it("keeps every payload under the hook bound, however long a command's output was", () => {
    for (const event of events) {
      expect(encoder.encode(JSON.stringify(event.payload)).byteLength).toBeLessThanOrEqual(
        MAX_HOOK_PAYLOAD_BYTES,
      );
    }
  });

  it("reads the same events at any chunk boundary", () => {
    const whole = interpret(RECORDING).events.map((event) => [event.type, event.payload.tool]);
    for (const size of [1, 7, 4096]) {
      expect(
        interpret(RECORDING, size).events.map((event) => [event.type, event.payload.tool]),
      ).toEqual(whole);
    }
  });
});

describe("what the recording does not show", () => {
  it("reports a refused MCP call as a completed call that failed (measured on 0.154.0)", () => {
    const { events } = interpret(
      frames(
        {
          type: "item.started",
          item: {
            id: "item_1",
            type: "mcp_tool_call",
            server: "nightshift",
            tool: "job.progress",
            status: "in_progress",
          },
        },
        {
          type: "item.completed",
          item: {
            id: "item_1",
            type: "mcp_tool_call",
            server: "nightshift",
            tool: "job.progress",
            result: null,
            error: { message: "MCP tool call requires approval, but approval policy is never" },
            status: "failed",
          },
        },
      ),
    );
    expect(events.map((event) => [event.type, event.payload.tool, event.payload.ok])).toEqual([
      ["tool.called", "nightshift.job.progress", undefined],
      ["tool.completed", "nightshift.job.progress", false],
    ]);
  });

  it("reports a file change, which arrives only completed, as one call and one completion", () => {
    const { events } = interpret(
      frames({
        type: "item.completed",
        item: {
          id: "item_4",
          type: "file_change",
          changes: [{ path: "src/math.js", kind: "update" }],
          status: "completed",
        },
      }),
    );
    expect(events.map((event) => [event.type, event.payload.tool])).toEqual([
      ["tool.called", "apply_patch"],
      ["tool.completed", "apply_patch"],
    ]);
    expect(events[0]?.payload.summary).toBe("src/math.js");
  });

  it("keeps a failed turn's reason, and a top-level error's, for the exit", () => {
    expect(
      interpret(frames({ type: "turn.failed", error: { message: "usage limit reached" } })).outcome,
    ).toMatchObject({ turnCompleted: false, failure: "usage limit reached" });
    expect(
      interpret(frames({ type: "error", message: "stream disconnected" })).outcome.failure,
    ).toBe("stream disconnected");
  });

  it("sums usage over turns", () => {
    const turn = { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } };
    expect(interpret(frames(turn, turn)).outcome.usage).toEqual({
      inputTokens: 20,
      outputTokens: 4,
    });
  });

  it("skips what it does not understand, counts what it cannot parse, and never throws", () => {
    const { events, outcome } = interpret(
      `not json\n${frames({ type: "item.updated", item: { type: "todo_list" } }, [1, 2], { type: "thread.started", thread_id: "t" })}{"type":"turn.comp`,
    );
    expect(events.map((event) => event.type)).toEqual(["agent.started"]);
    expect(outcome.unparseableLines).toBe(2);
  });

  it("synthesises the start exactly once when Codex printed nothing", () => {
    const events: HookEvent[] = [];
    const interpreter = createStreamInterpreter({
      sink: { emit: (event) => void events.push(event) },
      clock: { now: () => 0 },
    });
    interpreter.ensureStarted({ harnessVersion: "0.154.0" });
    interpreter.ensureStarted();
    expect(events.map((event) => event.type)).toEqual(["agent.started"]);
  });

  it("survives a sink that throws", () => {
    const interpreter = createStreamInterpreter({
      sink: {
        emit: () => {
          throw new Error("sink down");
        },
      },
      clock: { now: () => 0 },
    });
    expect(() =>
      interpreter.write(encoder.encode(frames({ type: "thread.started", thread_id: "t" }))),
    ).not.toThrow();
  });
});
