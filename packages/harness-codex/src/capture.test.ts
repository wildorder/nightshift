import { describe, expect, it } from "vitest";
import { type CoverageInput, codexCoverage, reconcileCapture } from "./capture.js";
import { readRolloutMetadata } from "./rollout.js";
import { CODEX_VERIFIED_NATIVE_CHILDREN, decodeCodexTelemetry } from "./telemetry.js";

const GOOD: CoverageInput = {
  sources: { stream: true, otlp: true, rollout: true },
  turnCompletedCleanly: true,
  parentBoundary: "ordinal",
  receiver: { started: true, stopGap: false, journalLoss: false, journalRead: true },
  transports: ["sse"],
  countsAgree: true,
  telemetryOnly: false,
  spawned: false,
  otherConversations: false,
};

describe("codexCoverage", () => {
  it("never trusts native children until a live matrix says so", () => {
    expect(CODEX_VERIFIED_NATIVE_CHILDREN).toBe(false);
  });

  const cases: readonly [string, Partial<CoverageInput>, string, string | undefined][] = [
    ["every condition holds", {}, "complete", undefined],
    [
      "no source reported",
      { sources: { stream: false, otlp: false, rollout: false } },
      "unknown",
      undefined,
    ],
    [
      "only the stream reported",
      { sources: { stream: true, otlp: false, rollout: false }, parentBoundary: undefined },
      "partial",
      "rollout unread",
    ],
    [
      "the turn did not complete",
      { turnCompletedCleanly: false },
      "partial",
      "turn did not complete",
    ],
    ["the rollout was not read", { parentBoundary: undefined }, "partial", "rollout unread"],
    ["the boundary was by time", { parentBoundary: "time" }, "partial", "launch boundary by time"],
    [
      "the receiver did not start",
      { receiver: { started: false, stopGap: false, journalLoss: false, journalRead: false } },
      "partial",
      "receiver unavailable",
    ],
    [
      "the receiver stopped with a gap",
      { receiver: { started: true, stopGap: true, journalLoss: false, journalRead: true } },
      "partial",
      "receiver stopped with a gap",
    ],
    [
      "the journal has a loss gap",
      { receiver: { started: true, stopGap: false, journalLoss: true, journalRead: true } },
      "partial",
      "telemetry journal loss",
    ],
    [
      "the journal could not be read",
      { receiver: { started: true, stopGap: false, journalLoss: false, journalRead: false } },
      "partial",
      "telemetry absent",
    ],
    [
      "a websocket transport",
      { transports: ["sse", "websocket"] },
      "partial",
      "transport websocket unverified",
    ],
    [
      "an unknown transport",
      { transports: ["unknown"] },
      "partial",
      "transport unknown unverified",
    ],
    ["counts disagree", { countsAgree: false }, "partial", "counts do not agree"],
    [
      "telemetry alone",
      { telemetryOnly: true },
      "partial",
      "telemetry only: replay cannot be excluded",
    ],
    [
      "a child was spawned",
      { spawned: true },
      "partial",
      "native children spawned; capture unverified",
    ],
    [
      "another conversation appears",
      { otherConversations: true },
      "partial",
      "native children spawned; capture unverified",
    ],
    ["spawn evidence is unknown", { spawned: undefined }, "partial", "native children spawned"],
  ];
  it.each(cases)("%s", (_name, change, coverage, gap) => {
    const verdict = codexCoverage({ ...GOOD, ...change });
    expect(verdict.coverage).toBe(coverage);
    if (gap !== undefined) expect(verdict.gaps.join("|")).toContain(gap);
    if (coverage === "complete") expect(verdict.gaps).toEqual([]);
  });

  it("is complete with children only when the native child capture is verified", () => {
    const input = { ...GOOD, spawned: true, otherConversations: true };
    expect(codexCoverage({ ...input, nativeChildrenVerified: true }).coverage).toBe("complete");
  });

  it("names each failed condition", () => {
    const verdict = codexCoverage({
      ...GOOD,
      turnCompletedCleanly: false,
      transports: ["websocket"],
      countsAgree: false,
    });
    expect(verdict.gaps).toHaveLength(3);
  });
});

describe("reconcileCapture", () => {
  const line = (ordinal: number, type: string, payload: object): string =>
    JSON.stringify({ timestamp: "2026-10-20T23:00:00.000Z", ordinal, type, payload });
  const rollout = (thread: string, responses: number): ReturnType<typeof readRolloutMetadata> =>
    readRolloutMetadata(
      Array.from({ length: responses }, (_, i) =>
        line(i, "token_usage_record", {
          thread_id: thread,
          response_id: `r${i}`,
          usage: { input_tokens: 10 },
        }),
      ).join("\n"),
    );

  it("emits nothing and names its absences when there is no source", () => {
    const result = reconcileCapture({
      threadId: "t",
      boundary: { kind: "ordinal", fromOrdinal: 0 },
      parent: undefined,
      children: new Map(),
      telemetry: undefined,
    });
    expect(result.observations).toEqual([]);
    expect(result.gaps).toContain("telemetry absent");
  });

  it("emits the rollout's requests when there is no telemetry", () => {
    const result = reconcileCapture({
      threadId: "t",
      boundary: { kind: "ordinal", fromOrdinal: 0 },
      parent: rollout("t", 2).records,
      children: new Map(),
      telemetry: decodeCodexTelemetry([]),
    });
    expect(result.requestCount).toBe(2);
    expect(result.facts.countsAgree).toBe(false);
    expect(result.gaps.join("|")).toContain("discrepancy");
  });
});
