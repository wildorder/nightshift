import { describe, expect, it } from "vitest";
import {
  agentStatusForExit,
  describeExit,
  type HarnessExit,
  hookTypeForExit,
  millis,
} from "./harness.js";
import { HOOK_EVENT_TYPES, isHookEventType, recordingHookSink } from "./hooks.js";

const EXITS: readonly HarnessExit[] = [
  { kind: "completed" },
  { kind: "failed", exitCode: 3 },
  { kind: "interrupted", signal: "SIGKILL" },
  { kind: "cancelled" },
];

describe("exit mapping", () => {
  it("maps every exit kind to a terminal agent status", () => {
    expect(EXITS.map(agentStatusForExit)).toEqual([
      "completed",
      "failed",
      "interrupted",
      "cancelled",
    ]);
  });

  it("maps every exit kind to a hook event the sink will accept", () => {
    for (const exit of EXITS) expect(isHookEventType(hookTypeForExit(exit))).toBe(true);
  });

  it("describes an exit in one line that names the detail", () => {
    expect(describeExit({ kind: "failed", exitCode: 3 })).toContain("3");
    expect(describeExit({ kind: "interrupted", signal: "SIGKILL" })).toContain("SIGKILL");
  });
});

describe("hook event types", () => {
  it("includes the P3 lifecycle set and nothing that is control-plane sourced", () => {
    expect(HOOK_EVENT_TYPES).toContain("agent.started");
    expect(HOOK_EVENT_TYPES).toContain("tool.called");
    expect(HOOK_EVENT_TYPES).not.toContain("node.queued");
    expect(HOOK_EVENT_TYPES).not.toContain("agent.created");
  });

  it("refuses a type outside the set", () => {
    expect(isHookEventType("node.integrated")).toBe(false);
  });
});

describe("the recording sink", () => {
  it("keeps events in emission order", () => {
    const sink = recordingHookSink();
    sink.emit({ type: "agent.started", occurredAt: "2026-01-01T00:00:00.000Z", payload: {} });
    sink.emit({ type: "tool.called", occurredAt: "2026-01-01T00:00:01.000Z", payload: { n: 1 } });
    expect(sink.events.map((e) => e.type)).toEqual(["agent.started", "tool.called"]);
  });
});

describe("Duration", () => {
  it("names its unit", () => {
    expect(millis(5_000)).toEqual({ ms: 5_000 });
  });
});
