import { readFileSync } from "node:fs";
import { MeasurementObservationSchema } from "@nightshift/contracts";
import type { ReceiverEnvelope, ReceiverGap } from "@nightshift/harness";
import { describe, expect, it } from "vitest";
import {
  CODEX_OTEL_ATTRIBUTES,
  CODEX_OTEL_RECORD_FILTER,
  CODEX_VERIFIED_TRANSPORTS,
  decodeCodexTelemetry,
  telemetryObservations,
} from "./telemetry.js";

type Line = ReceiverEnvelope | ReceiverGap;
const load = (name: string): Line[] =>
  readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as Line);

const THREAD = "019e0000-0000-7000-8000-000000000001";
const ULID = "01M5DKEPRMEEYE1MV3XX5YCJN7";
const stamp = (o: object) => ({
  ...o,
  schemaVersion: 1,
  projectId: `proj_${ULID}`,
  programId: `prog_${ULID}`,
  runId: `run_${ULID}`,
  executionNodeId: `node_${ULID}`,
  receivedAt: "2026-10-21T00:00:00.000Z",
});

const envelope = (attributes: Record<string, string | number | boolean>[]): ReceiverEnvelope => ({
  receivedAt: "2026-10-21T00:00:00.000Z",
  path: "/v1/logs",
  contentType: "application/json",
  signal: "logs",
  records: attributes.map((a) => ({
    kind: "log" as const,
    attributes: a,
    resourceAttributes: {},
    droppedAttributeCount: 0,
  })),
  droppedRecordCount: 0,
});
const CLOSED: Line = { closed: true, receivedAt: "2026-10-21T00:00:01.000Z" };
const completed = (extra: Record<string, string | number | boolean>, name = "codex.sse_event") => ({
  "event.name": name,
  "event.kind": "response.completed",
  "conversation.id": THREAD,
  ...extra,
});

describe("decodeCodexTelemetry", () => {
  it("decodes launch 1 into two completed responses", () => {
    const e = decodeCodexTelemetry(load("codex-otlp-journal-launch1.jsonl"));
    expect(e.conversations).toHaveLength(1);
    const c = e.conversations[0];
    expect(
      c?.completions.map((r) => [
        r.inputTokens,
        r.outputTokens,
        r.cachedTokens,
        r.cacheWriteTokens,
        r.reasoningTokens,
      ]),
    ).toEqual([
      [1007, 41, 500, 0, 10],
      [2007, 42, 1000, 0, 20],
    ]);
    expect(c?.completions[0]?.totalTokens).toBe(1048);
    expect(c?.transports).toEqual(["sse"]);
    expect(c?.appVersion).toBe("0.155.1");
    expect(c?.retried).toBe(false);
    expect(e.lossGaps).toEqual([]);
    expect(e.filteredRecordCount).toBe(14);
  });

  it("decodes launch 2 into one", () => {
    const e = decodeCodexTelemetry(load("codex-otlp-journal-launch2.jsonl"));
    expect(e.conversations[0]?.completions).toHaveLength(1);
    expect(e.conversations[0]?.completions[0]?.inputTokens).toBe(1007);
  });

  it("decodes numbers and digit strings alike, and keeps the counts a record has", () => {
    const e = decodeCodexTelemetry([
      envelope([
        completed({ input_token_count: 10, output_token_count: "5" }),
        completed({ input_token_count: "7" }),
      ]),
      CLOSED,
    ]);
    const [a, b] = e.conversations[0]?.completions ?? [];
    expect([a?.inputTokens, a?.outputTokens]).toEqual([10, 5]);
    expect(b?.inputTokens).toBe(7);
    expect(b?.outputTokens).toBeUndefined();
  });

  it("drops and counts a record without a conversation id", () => {
    const e = decodeCodexTelemetry([
      envelope([{ "event.name": "codex.api_request", attempt: 0 }]),
      CLOSED,
    ]);
    expect(e.conversations).toEqual([]);
    expect(e.droppedRecords).toBe(1);
  });

  it("reports loss separately from filtered records", () => {
    const filteredOnly = decodeCodexTelemetry([
      { ...envelope([]), filteredRecordCount: 9 },
      CLOSED,
    ]);
    expect(filteredOnly.filteredRecordCount).toBe(9);
    expect(filteredOnly.lossGaps).toEqual([]);
    for (const gap of ["records_truncated", "journal_full", "torn_line"] as const) {
      expect(decodeCodexTelemetry([{ gap }, CLOSED]).lossGaps).toEqual([{ reason: gap, count: 1 }]);
    }
    expect(decodeCodexTelemetry([envelope([])]).lossGaps).toEqual([
      { reason: "not_closed", count: 1 },
    ]);
  });
});

describe("telemetryObservations", () => {
  it("emits one request per completion with stable position ids", () => {
    const lines = load("codex-otlp-journal-launch1.jsonl");
    const { observations, excluded } = telemetryObservations(decodeCodexTelemetry(lines), {
      threadId: THREAD,
    });
    expect(excluded).toEqual([]);
    expect(observations.map((o) => o.observationId)).toEqual([
      `codex:otel:${THREAD}:0`,
      `codex:otel:${THREAD}:1`,
    ]);
    expect(observations[1]).toMatchObject({
      kind: "request",
      sessionId: THREAD,
      model: "gpt-5.5",
      source: "harness",
      inclusion: "self",
      counters: {
        inputTokens: 2007,
        cacheReadTokens: 1000,
        cacheWriteTokens: 0,
        outputTokens: 42,
        reasoningTokens: 20,
        inputIncludesCache: true,
      },
      provenance: { adapter: "codex", version: "0.155.1" },
    });
    expect(observations[0]).not.toHaveProperty("childRef");
    const again = telemetryObservations(decodeCodexTelemetry(lines), { threadId: THREAD });
    expect(again.observations.map((o) => o.observationId)).toEqual(
      observations.map((o) => o.observationId),
    );
    for (const o of observations) {
      expect(MeasurementObservationSchema.safeParse(stamp(o)).success).toBe(true);
    }
  });

  it("excludes a retried conversation's completions", () => {
    const e = decodeCodexTelemetry(load("codex-otlp-retry.jsonl"));
    expect(e.conversations[0]?.completions).toHaveLength(1);
    expect(e.conversations[0]?.retried).toBe(true);
    expect(telemetryObservations(e, { threadId: THREAD })).toEqual({
      observations: [],
      excluded: [{ conversation: THREAD, count: 1, reason: "retried" }],
    });
  });

  it("excludes an unverified transport unless it is verified", () => {
    const lines = [
      envelope([
        { "event.name": "codex.api_request", "conversation.id": THREAD, attempt: 0 },
        completed({ input_token_count: 5, output_token_count: 1 }, "codex.websocket.event"),
      ]),
      CLOSED,
    ];
    const e = decodeCodexTelemetry(lines);
    expect(e.conversations[0]?.transports).toEqual(["websocket"]);
    expect(telemetryObservations(e, { threadId: THREAD })).toEqual({
      observations: [],
      excluded: [{ conversation: THREAD, count: 1, reason: "unverified_transport" }],
    });
    const ok = telemetryObservations(e, {
      threadId: THREAD,
      verifiedTransports: ["sse", "websocket"],
    });
    expect(ok.observations).toHaveLength(1);
    expect(ok.observations[0]?.provenance.note).toContain("codex.websocket.event");
  });

  it("yields exactly one request for the cancelled fixture", () => {
    const e = decodeCodexTelemetry(load("codex-otlp-cancelled.jsonl"));
    expect(telemetryObservations(e, { threadId: THREAD }).observations).toHaveLength(1);
  });

  it("marks another conversation as a session child, and validates", () => {
    const e = decodeCodexTelemetry(load("codex-otlp-journal-launch2.jsonl"));
    const { observations } = telemetryObservations(e, { threadId: "other" });
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({ childRef: { kind: "session", id: THREAD } });
    expect(observations.every((o) => o.kind === "request")).toBe(true);
    for (const o of observations) {
      expect(MeasurementObservationSchema.safeParse(stamp(o)).success).toBe(true);
    }
  });
});

describe("the receiver allowlist", () => {
  it("has no free-text attribute and types every key", () => {
    const keys = CODEX_OTEL_ATTRIBUTES.map((a) => a.key);
    for (const banned of [
      "error.message",
      "endpoint",
      "prompt",
      "prompt_length",
      "tool_name",
      "call_id",
      "mcp_servers",
      "body",
    ]) {
      expect(keys).not.toContain(banned);
    }
    for (const a of CODEX_OTEL_ATTRIBUTES) {
      expect(a.type).toBeTruthy();
      if (a.type === "enum") expect(a.values?.length).toBeGreaterThan(0);
    }
    const identifiers = new Set([
      "event.kind",
      "model",
      "slug",
      "conversation.id",
      "app.version",
      "originator",
      "service.name",
      "service.version",
    ]);
    for (const a of CODEX_OTEL_ATTRIBUTES) {
      expect(a.type === "id", a.key).toBe(identifiers.has(a.key));
    }
  });

  it("filters on event.name and event.kind only", () => {
    for (const rule of CODEX_OTEL_RECORD_FILTER) {
      for (const k of Object.keys(rule)) expect(["event.name", "event.kind"]).toContain(k);
    }
    expect(CODEX_VERIFIED_TRANSPORTS).toEqual(["sse"]);
  });
});
