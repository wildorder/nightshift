import { type MeasurementObservation, MeasurementObservationSchema } from "@nightshift/contracts";
import { createCountingIdGenerator, reconcileSegment } from "@nightshift/core";
import type { HarnessObservation } from "@nightshift/harness";
import { describe, expect, it } from "vitest";
import {
  type CoverageInput,
  childBoundaryFor,
  codexCoverage,
  reconcileCapture,
} from "./capture.js";
import { type LaunchBoundary, readRolloutMetadata } from "./rollout.js";
import {
  CODEX_VERIFIED_NATIVE_CHILDREN,
  type CodexTelemetryEvidence,
  decodeCodexTelemetry,
} from "./telemetry.js";

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

describe("childBoundaryFor", () => {
  const at = (ordinal: number, timestamp: string) =>
    ({ ordinal, timestamp, type: "task_started" }) as const;
  const records = [
    at(0, "2026-10-20T10:00:00.000Z"),
    at(1, "2026-10-20T10:05:00.000Z"),
    at(2, "2026-10-20T11:00:00.000Z"),
    at(3, "2026-10-20T11:05:00.000Z"),
  ];
  const ordinal = (fromOrdinal: number): LaunchBoundary => ({ kind: "ordinal", fromOrdinal });

  it("keeps ordinal 0 for a fresh thread, even with no parent records", () => {
    expect(childBoundaryFor(records, ordinal(0))).toEqual(ordinal(0));
    expect(childBoundaryFor(undefined, ordinal(0))).toEqual(ordinal(0));
  });

  it("bounds children by the parent's first record at the resume ordinal", () => {
    expect(childBoundaryFor(records, ordinal(2))).toEqual({
      kind: "time",
      notBefore: "2026-10-20T11:00:00.000Z",
    });
    expect(childBoundaryFor([...records].reverse(), ordinal(2))).toEqual({
      kind: "time",
      notBefore: "2026-10-20T11:00:00.000Z",
    });
  });

  it("bounds children by the first parent record at or after a time boundary", () => {
    expect(
      childBoundaryFor(records, { kind: "time", notBefore: "2026-10-20T10:30:00.000Z" }),
    ).toEqual({ kind: "time", notBefore: "2026-10-20T11:00:00.000Z" });
  });

  it("is undefined when no parent record is at or after the boundary", () => {
    expect(childBoundaryFor(records, ordinal(9))).toBeUndefined();
    expect(childBoundaryFor([], ordinal(2))).toBeUndefined();
    expect(childBoundaryFor(undefined, ordinal(2))).toBeUndefined();
    expect(
      childBoundaryFor(records, { kind: "time", notBefore: "2026-10-21T00:00:00.000Z" }),
    ).toBeUndefined();
  });
});

describe("reconcileCapture children across launches", () => {
  const PARENT = "parent-thread";
  const CHILD = "child-thread-1234";
  const line = (ordinal: number, timestamp: string, type: string, payload: object): string =>
    JSON.stringify({ timestamp, ordinal, type, payload });
  const usage = (ordinal: number, timestamp: string, thread: string, input: number): string =>
    line(ordinal, timestamp, "token_usage_record", {
      thread_id: thread,
      response_id: `${thread}-${ordinal}`,
      usage: { input_tokens: input },
    });
  const read = (lines: string[]) => readRolloutMetadata(`${lines.join("\n")}\n`).records;

  const L1 = "2026-10-20T10:00:00.000Z";
  const L1_REQ = "2026-10-20T10:30:00.000Z";
  const L2 = "2026-10-20T11:00:00.000Z";
  const L2_REQ = "2026-10-20T11:30:00.000Z";
  const parentOne = [line(0, L1, "task_started", {}), usage(1, L1_REQ, PARENT, 10)];
  const parentAll = [...parentOne, line(2, L2, "task_started", {}), usage(3, L2_REQ, PARENT, 20)];
  const childOne = [usage(0, L1_REQ, CHILD, 100)];
  const childAll = [...childOne, usage(1, L2_REQ, CHILD, 50)];

  const ids = createCountingIdGenerator();
  const stamp = (observation: HarnessObservation, launchId: string): MeasurementObservation =>
    MeasurementObservationSchema.parse({
      ...observation,
      schemaVersion: 1,
      projectId: ids.next("proj"),
      programId: ids.next("prog"),
      runId: ids.next("run"),
      executionNodeId: ids.next("node"),
      agentId: ids.next("agent"),
      launch: { agentId: ids.next("agent"), launchId, segment: 0 },
      receivedAt: "2026-10-21T00:00:00.000Z",
    });

  const completion = (position: number, inputTokens: number) => ({ position, inputTokens });
  const telemetry = (
    completions: ReturnType<typeof completion>[],
    extra: Partial<CodexTelemetryEvidence["conversations"][number]> = {},
  ): CodexTelemetryEvidence => ({
    conversations: [
      {
        conversationId: CHILD,
        completions,
        attempts: [],
        transports: ["sse"],
        retried: false,
        ...extra,
      },
    ],
    lossGaps: [],
    filteredRecordCount: 0,
    droppedRecords: 0,
  });
  const childRequests = (observations: readonly HarnessObservation[]) =>
    observations.filter(
      (o): o is HarnessObservation & { kind: "request" } =>
        o.kind === "request" && o.childRef?.id === CHILD,
    );

  it("never counts a child's earlier launch again: 100 and 50, not 100 and 150", () => {
    const one = reconcileCapture({
      threadId: PARENT,
      boundary: { kind: "ordinal", fromOrdinal: 0 },
      parent: read(parentOne),
      children: new Map([[CHILD, read(childOne)]]),
      telemetry: telemetry([completion(0, 100)]),
    });
    const two = reconcileCapture({
      threadId: PARENT,
      boundary: { kind: "ordinal", fromOrdinal: 2 },
      parent: read(parentAll),
      children: new Map([[CHILD, read(childAll)]]),
      telemetry: telemetry([completion(0, 50)]),
    });
    expect(childRequests(one.observations).map((o) => o.counters?.inputTokens)).toEqual([100]);
    expect(childRequests(two.observations).map((o) => o.counters?.inputTokens)).toEqual([50]);
    expect(two.observations.filter((o) => o.kind === "request")).toHaveLength(2);
    expect(one.observations.filter((o) => o.kind === "request")).toHaveLength(2);
    const idsOne = new Set(childRequests(one.observations).map((o) => o.observationId));
    for (const o of childRequests(two.observations))
      expect(idsOne.has(o.observationId)).toBe(false);
    expect(two.gaps.join("|")).toContain("child child-th boundary by time");
    expect(one.gaps.join("|")).not.toContain("boundary by time");

    const total = (result: typeof one, launchId: string): number | undefined =>
      reconcileSegment(
        result.observations.filter((o) => o.childRef?.id === CHILD).map((o) => stamp(o, launchId)),
        { resumedSession: false },
      ).childCounters?.inputTokens;
    expect(total(one, "l1")).toBe(100);
    expect(total(two, "l2")).toBe(50);
  });

  it("does not use a child rollout when the parent rollout is unread; telemetry decides", () => {
    const result = reconcileCapture({
      threadId: PARENT,
      boundary: { kind: "ordinal", fromOrdinal: 2 },
      parent: undefined,
      children: new Map([[CHILD, read(childAll)]]),
      telemetry: telemetry([completion(0, 50)]),
    });
    const requests = childRequests(result.observations);
    expect(requests.map((o) => o.observationId)).toEqual([`codex:otel:${CHILD}:0`]);
    expect(requests.map((o) => o.counters?.inputTokens)).toEqual([50]);
    expect(result.gaps).toContain("child child-th rollout unbounded; telemetry decides");
  });

  it("excludes retried or unverified child telemetry when its rollout is unbounded", () => {
    for (const extra of [{ retried: true }, { transports: ["websocket" as const] }]) {
      const result = reconcileCapture({
        threadId: PARENT,
        boundary: { kind: "ordinal", fromOrdinal: 2 },
        parent: undefined,
        children: new Map([[CHILD, read(childAll)]]),
        telemetry: telemetry([completion(0, 50)], extra),
      });
      expect(childRequests(result.observations)).toEqual([]);
      expect(result.excludedTelemetry).toBe(1);
      expect(result.gaps).toContain("child child-th rollout unbounded; telemetry decides");
    }
  });
});
