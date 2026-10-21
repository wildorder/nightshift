import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MeasurementObservationSchema } from "@nightshift/contracts";
import {
  type HarnessObservation,
  millis,
  type ReceiverRecord,
  receiverEnvelopeSchema,
  recordingMeasurementSink,
} from "@nightshift/harness";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CLAUDE_TELEMETRY_ATTRIBUTES,
  type ClaudeCapture,
  claudeTelemetryEnv,
  claudeTelemetryHeaderEnv,
  claudeTelemetryHeadersFile,
  claudeTelemetryHeadersHelper,
  decodeClaudeTelemetryRecord,
  startClaudeCapture,
} from "./capture.js";

const fixture = (name: string): string =>
  fileURLToPath(new URL(`./__fixtures__/telemetry/${name}`, import.meta.url));

const U = "01HF7YAT00GGGGGGGGGGGGGGGG";
const stamp = (o: HarnessObservation) => ({
  ...o,
  projectId: `proj_${U}`,
  programId: `prog_${U}`,
  runId: `run_${U}`,
  executionNodeId: `node_${U}`,
  receivedAt: "2026-10-21T10:00:10.000Z",
});
const parses = (o: HarnessObservation) => MeasurementObservationSchema.safeParse(stamp(o));

const journalRecords = (): ReceiverRecord[] =>
  readFileSync(fixture("journal-reduced.ndjson"), "utf8")
    .split("\n")
    .filter((l) => l.endsWith("}"))
    .flatMap(
      (l) => receiverEnvelopeSchema.parse(JSON.parse(l)).records as unknown as ReceiverRecord[],
    );

const byRequest = (id: string): ReceiverRecord => {
  const r = journalRecords().find((x) => x.attributes.request_id === id);
  if (!r) throw new Error(`no fixture record ${id}`);
  return r;
};
const decodeOk = (r: ReceiverRecord): HarnessObservation => {
  const d = decodeClaudeTelemetryRecord(r, {});
  if ("skipped" in d) throw new Error(`skipped ${d.skipped}`);
  return d.observation;
};

describe("decodeClaudeTelemetryRecord", () => {
  it("turns a main api_request into one request observation", () => {
    const o = decodeOk(byRequest("req_main_0001"));
    expect(o).toEqual({
      schemaVersion: 1,
      kind: "request",
      observationId: "claude:api_request:req_main_0001",
      source: "harness",
      inclusion: "self",
      provenance: {
        adapter: "claude",
        version: "2.1.286",
        note: "cost_usd is Claude Code's client-side estimate, not billed spend; api_request from OTLP logs",
      },
      counters: {
        inputTokens: 120,
        outputTokens: 45,
        cacheReadTokens: 3000,
        cacheWriteTokens: 200,
        inputIncludesCache: false,
      },
      requestId: "req_main_0001",
      sessionId: "sess-0001",
      model: "model-x",
      durationMs: 2310,
      reportedCostUsd: 0.0123,
      occurredAt: "2026-10-21T10:00:01.000Z",
    });
    expect(parses(o).success).toBe(true);
  });

  it("carries childRef for a sub-agent and not for a compaction", () => {
    const sub = decodeOk(byRequest("req_sub_0003"));
    expect("childRef" in sub && sub.childRef).toEqual({ kind: "agent", id: "Explore" });
    const compact = decodeOk(byRequest("req_compact_0002"));
    expect("childRef" in compact).toBe(false);
    expect(parses(sub).success && parses(compact).success).toBe(true);
  });

  it("produces no observation for other events", () => {
    const others = journalRecords().filter((r) => r.eventName !== "api_request");
    expect(others.map((r) => r.eventName).sort()).toEqual(["api_error", "user_prompt"]);
    for (const r of others)
      expect(decodeClaudeTelemetryRecord(r, {})).toEqual({ skipped: "not_api_request" });
    const plugin = { ...others[0], eventName: "plugin_loaded" } as ReceiverRecord;
    expect(decodeClaudeTelemetryRecord(plugin, {})).toEqual({ skipped: "not_api_request" });
  });

  it("gives a redelivered record the same observationId", () => {
    const all = journalRecords().filter((r) => r.attributes.request_id === "req_main_0001");
    expect(all).toHaveLength(2);
    expect(decodeOk(all[0] as ReceiverRecord).observationId).toBe(
      decodeOk(all[1] as ReceiverRecord).observationId,
    );
  });

  it("falls back through identity sources and skips an unidentified record", () => {
    const base = byRequest("req_main_0001");
    const attrs = (extra: Record<string, string | number>, drop: string[]) => {
      const a: Record<string, string | number | boolean> = { ...base.attributes, ...extra };
      for (const k of drop) delete a[k];
      return { ...base, attributes: a };
    };
    expect(decodeOk(attrs({}, ["request_id"])).observationId).toBe(
      "claude:api_request:00000000-0000-4000-8000-000000000001",
    );
    const bySeq = decodeOk(attrs({}, ["request_id", "client_request_id"]));
    expect(bySeq.observationId).toBe("claude:api_request:sess-0001:1");
    expect("requestId" in bySeq).toBe(false);
    expect(
      decodeClaudeTelemetryRecord(
        attrs({}, ["request_id", "client_request_id", "event.sequence"]),
        {},
      ),
    ).toEqual({
      skipped: "unidentified",
    });
  });

  it("derives cost from micros, time from timeUnixNano and version from the fallback", () => {
    const base = byRequest("req_main_0001");
    const a: Record<string, string | number | boolean> = {
      ...base.attributes,
      cost_usd_micros: 2500,
    };
    for (const k of ["cost_usd", "event.timestamp", "app.version"]) delete a[k];
    const o = decodeClaudeTelemetryRecord({ ...base, attributes: a }, { fallbackVersion: "9.9.9" });
    if ("skipped" in o) throw new Error("skipped");
    expect(o.observation).toMatchObject({
      reportedCostUsd: 0.0025,
      occurredAt: new Date(1792000000000).toISOString(),
      provenance: { version: "9.9.9" },
    });
    delete a.cost_usd_micros;
    const none = decodeClaudeTelemetryRecord(
      { ...base, timeUnixNano: undefined, attributes: a } as unknown as ReceiverRecord,
      {},
    );
    if ("skipped" in none) throw new Error("skipped");
    expect("reportedCostUsd" in none.observation).toBe(false);
    expect("occurredAt" in none.observation).toBe(false);
  });

  it("skips a record with no usable counters and rejects negative counters", () => {
    const base = byRequest("req_main_0001");
    const a: Record<string, string | number | boolean> = { ...base.attributes };
    for (const k of ["input_tokens", "output_tokens", "cache_read_tokens", "cache_creation_tokens"])
      delete a[k];
    expect(decodeClaudeTelemetryRecord({ ...base, attributes: a }, {})).toEqual({
      skipped: "no_counters",
    });
    const neg = decodeOk({
      ...base,
      attributes: { ...base.attributes, input_tokens: -4, output_tokens: 7.6 },
    });
    expect(neg).toMatchObject({ counters: { outputTokens: 8 } });
    expect("inputTokens" in (neg as { counters: object }).counters).toBe(false);
  });

  it("copies nothing outside the allowlist", () => {
    const base = byRequest("req_main_0001");
    const o = decodeOk({
      ...base,
      attributes: { ...base.attributes, "user.id": "SECRET-USER", prompt: "SECRET-PROMPT" },
    });
    expect(JSON.stringify(o)).not.toMatch(/SECRET/);
    for (const r of journalRecords())
      for (const k of Object.keys(r.attributes)) expect(CLAUDE_TELEMETRY_ATTRIBUTES).toContain(k);
  });
});

describe("telemetry transport", () => {
  it("lists exactly the allowed attributes", () => {
    expect(CLAUDE_TELEMETRY_ATTRIBUTES).toEqual([
      "event.name",
      "event.timestamp",
      "event.sequence",
      "session.id",
      "app.version",
      "model",
      "input_tokens",
      "output_tokens",
      "cache_read_tokens",
      "cache_creation_tokens",
      "cost_usd",
      "cost_usd_micros",
      "duration_ms",
      "request_id",
      "client_request_id",
      "query_source",
      "agent.name",
      "speed",
      "effort",
      "status_code",
      "attempt",
    ]);
  });

  it("builds the header-free environment key by key", () => {
    const env = claudeTelemetryEnv("http://127.0.0.1:1234");
    expect(env).toEqual({
      CLAUDE_CODE_ENABLE_TELEMETRY: "1",
      OTEL_LOGS_EXPORTER: "otlp",
      OTEL_METRICS_EXPORTER: "none",
      OTEL_TRACES_EXPORTER: "none",
      OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:1234",
      OTEL_LOGS_EXPORT_INTERVAL: "1000",
      OTEL_METRICS_INCLUDE_VERSION: "true",
      OTEL_METRICS_INCLUDE_SESSION_ID: "true",
      OTEL_METRICS_INCLUDE_ACCOUNT_UUID: "false",
    });
    expect(Object.keys(env).filter((k) => k.startsWith("OTEL_LOG_"))).toEqual([]);
    expect("OTEL_EXPORTER_OTLP_HEADERS" in env).toBe(false);
    expect(
      claudeTelemetryEnv("http://x", { exportIntervalMs: 250 }).OTEL_LOGS_EXPORT_INTERVAL,
    ).toBe("250");
  });

  it("writes the headers file and the helper command", () => {
    expect(claudeTelemetryHeadersFile("cap123")).toBe('{"Authorization":"Bearer cap123"}');
    expect(claudeTelemetryHeadersHelper("/tmp/a b/h.json", "linux")).toBe("cat '/tmp/a b/h.json'");
    expect(claudeTelemetryHeadersHelper("/tmp/it's/h.json", "darwin")).toBe(
      `cat '/tmp/it'\\''s/h.json'`,
    );
    expect(claudeTelemetryHeadersHelper("C:\\h.json", "win32")).toBeUndefined();
    expect(claudeTelemetryHeaderEnv("cap123")).toEqual({
      OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer cap123",
    });
  });
});

describe("startClaudeCapture", () => {
  let dir: string;
  const live: ClaudeCapture[] = [];
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "claude-capture-"));
  });
  afterEach(async () => {
    await Promise.all(live.splice(0).map((c) => c.stop(millis(500))));
    rmSync(dir, { recursive: true, force: true });
  });

  const begin = async (seed?: string) => {
    const journalPath = join(dir, "journal.ndjson");
    if (seed) copyFileSync(fixture(seed), journalPath);
    const sink = recordingMeasurementSink();
    const capture = await startClaudeCapture({ journalPath, sink, pollMs: 50 });
    live.push(capture);
    return { capture, sink };
  };
  const post = (c: ClaudeCapture, body: string) =>
    fetch(`${c.endpoint}/v1/logs`, {
      method: "POST",
      headers: { authorization: `Bearer ${c.capability}`, "content-type": "application/json" },
      body,
    });
  const until = async (ok: () => boolean) => {
    for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 50));
    expect(ok()).toBe(true);
  };

  it("captures the fixture export end to end and completes", async () => {
    const { capture, sink } = await begin();
    expect(capture.env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe(capture.endpoint);
    const res = await post(capture, readFileSync(fixture("otlp-logs-export.json"), "utf8"));
    expect(res.status).toBe(200);
    await until(() => sink.observations.length === 1);
    expect(sink.observations[0]).toMatchObject({
      kind: "request",
      observationId: "claude:api_request:req_placeholder_0001",
      counters: { inputTokens: 120, cacheReadTokens: 3000, inputIncludesCache: false },
      reportedCostUsd: 0.0123,
    });
    for (const o of sink.observations) expect(parses(o).success).toBe(true);

    const result = await capture.stop();
    expect(await capture.stop()).toBe(result);
    expect(result).toMatchObject({
      requests: 1,
      apiErrors: 1,
      droppedRecords: 0,
      unidentifiedRequests: 0,
      complete: true,
      reasons: [],
    });
    expect(result.gap).toBeUndefined();
    expect(result.droppedAttributes).toBeGreaterThan(0);
    const d = result.diagnostics;
    expect(d.transport).toEqual({ paths: ["/v1/logs"], contentTypes: ["application/json"] });
    expect(d.appVersions).toEqual(["2.1.286"]);
    expect(d.eventCounts).toEqual({
      api_error: 1,
      api_request: 1,
      plugin_loaded: 1,
      user_prompt: 1,
    });
    expect(d.apiRequest.attributeTypes).toMatchObject({
      input_tokens: "number",
      cost_usd: "number",
      request_id: "string",
      query_source: "string",
    });
    expect(d.apiRequest.present).toMatchObject({
      request_id: true,
      client_request_id: true,
      "session.id": true,
      cost_usd: true,
      cost_usd_micros: true,
      duration_ms: true,
      effort: true,
      speed: true,
      "agent.name": false,
      query_source: true,
      "event.timestamp": true,
      "event.sequence": true,
    });
    expect(d.apiRequest.querySourceClasses).toEqual({ main: 1, child: 0, compact: 0, other: 0 });
    const json = JSON.stringify(result);
    expect(json).not.toMatch(/req_placeholder|00000000-0000|sess-0001|PLACEHOLDER/);
  });

  it("reports receiver_lost when the receiver is killed before stop", async () => {
    const { capture, sink } = await begin();
    await post(capture, readFileSync(fixture("otlp-logs-export.json"), "utf8"));
    await until(() => sink.observations.length === 1);
    process.kill(capture.pid, "SIGKILL");
    await new Promise((r) => setTimeout(r, 200));
    const result = await capture.stop(millis(500));
    expect(result.complete).toBe(false);
    expect(result.gap).toBe("receiver_lost");
    expect(result.reasons).toContain("receiver_lost");
    expect(result.requests).toBe(1);
  });

  it("reports torn_tail for a journal ending in a torn line", async () => {
    const { capture, sink } = await begin("journal-reduced.ndjson");
    await until(() => sink.observations.length === 3);
    const result = await capture.stop();
    expect(sink.observations.map((o) => o.observationId).sort()).toEqual([
      "claude:api_request:req_compact_0002",
      "claude:api_request:req_main_0001",
      "claude:api_request:req_sub_0003",
    ]);
    expect(result.complete).toBe(false);
    expect(result.reasons).toContain("torn_tail");
    expect(result.requests).toBe(3);
    expect(result.apiErrors).toBe(1);
    expect(result.diagnostics.apiRequest.querySourceClasses).toEqual({
      main: 2,
      child: 1,
      compact: 1,
      other: 0,
    });
    for (const o of sink.observations) expect(parses(o).success).toBe(true);
  });

  it("reports no_api_request when nothing usable arrived", async () => {
    const { capture } = await begin();
    const result = await capture.stop();
    expect(result.complete).toBe(false);
    expect(result.reasons).toEqual(["no_api_request"]);
    expect(result.requests).toBe(0);
  });
});
