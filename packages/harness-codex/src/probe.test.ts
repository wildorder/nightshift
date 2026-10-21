import { mkdtempSync, readFileSync, readFileSync as readText, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReceiverEnvelope, ReceiverGap } from "@nightshift/harness";
import { describe, expect, it } from "vitest";
import { VERIFIED_CODEX_VERSION } from "./command.js";
import {
  buildCapabilityMatrix,
  codexLauncherFor,
  codexLiveProbeGate,
  codexOfflineProbeGate,
  fakeResponsesProvider,
  sanitizeJournalLine,
  sanitizeRolloutLine,
  writeCapabilityMatrix,
} from "./probe.js";
import { decodeCodexTelemetry } from "./telemetry.js";

type Line = ReceiverEnvelope | ReceiverGap;
const load = (name: string): Line[] =>
  readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as Line);

const SENTINEL = "SENTINEL-4f9c1d7a-do-not-leak";

describe("codexOfflineProbeGate", () => {
  const found = { findExecutable: () => "/usr/local/bin/codex" };
  it("is enabled for the verified version", () => {
    const gate = codexOfflineProbeGate(
      { PATH: "/x" },
      { ...found, version: () => `codex-cli ${VERIFIED_CODEX_VERSION}` },
    );
    expect(gate.enabled).toBe(true);
    expect(gate.reason).toContain(VERIFIED_CODEX_VERSION);
  });
  it("is disabled, naming the binary, when codex is not on PATH", () => {
    const gate = codexOfflineProbeGate(
      { PATH: "/x" },
      { findExecutable: () => undefined, version: () => undefined },
    );
    expect(gate.enabled).toBe(false);
    expect(gate.reason).toContain("`codex`");
    expect(gate.reason).toContain("skipped, not passed");
  });
  it("is disabled, naming both versions, for another version", () => {
    const gate = codexOfflineProbeGate({}, { ...found, version: () => "codex-cli 0.200.0" });
    expect(gate.enabled).toBe(false);
    expect(gate.reason).toContain("0.200.0");
    expect(gate.reason).toContain(VERIFIED_CODEX_VERSION);
  });
  it("lets NIGHTSHIFT_MEASUREMENT_PROBE_ALLOW_VERSION=1 allow another version", () => {
    const gate = codexOfflineProbeGate(
      { NIGHTSHIFT_MEASUREMENT_PROBE_ALLOW_VERSION: "1" },
      { ...found, version: () => "codex-cli 0.200.0" },
    );
    expect(gate.enabled).toBe(true);
  });
  it("is disabled when the version cannot be read", () => {
    const gate = codexOfflineProbeGate({}, { ...found, version: () => undefined });
    expect(gate.enabled).toBe(false);
    expect(gate.reason).toContain("--version");
  });
});

describe("codexLiveProbeGate", () => {
  it("is enabled only for NIGHTSHIFT_MEASUREMENT_PROBE=codex", () => {
    expect(codexLiveProbeGate({ NIGHTSHIFT_MEASUREMENT_PROBE: "codex" }).enabled).toBe(true);
    const off = codexLiveProbeGate({});
    expect(off.enabled).toBe(false);
    expect(off.reason).toContain("NIGHTSHIFT_MEASUREMENT_PROBE");
    const other = codexLiveProbeGate({ NIGHTSHIFT_MEASUREMENT_PROBE: "claude" });
    expect(other.enabled).toBe(false);
    expect(other.reason).toContain('"claude"');
  });
});

describe("buildCapabilityMatrix", () => {
  const evidence = decodeCodexTelemetry(load("codex-otlp-journal-launch1.jsonl"));
  const matrix = buildCapabilityMatrix(evidence, {
    mode: "offline",
    producedAt: "2026-10-21T00:00:00.000Z",
  });
  it("reports what the committed telemetry shows", () => {
    expect(matrix.harness).toBe("codex");
    expect(matrix.harnessVersion).toBe("0.155.1");
    expect(matrix.transports).toEqual(["sse"]);
    expect(matrix.nativeChildren).toBe("not_observed");
    expect(matrix.fieldsObserved).toEqual(
      expect.arrayContaining(["cache_write_token_count", "reasoning_token_count"]),
    );
    expect(matrix.authMode).toContain("auth.env_provider_key_present=true");
  });
  it("lists every dimension nobody established as unverified", () => {
    const status = Object.fromEntries(matrix.dimensions.map((d) => [d.name, d.status]));
    expect(status).toMatchObject({
      transport_sse: "observed",
      transport_websocket: "unverified",
      native_children: "unverified",
      interrupted_run: "unverified",
      resume_continuation: "unverified",
      real_backend: "unverified",
    });
  });
  it("lets the probe's own dimensions win, and names an unobserved auth mode", () => {
    const empty = buildCapabilityMatrix(
      { conversations: [], lossGaps: [], filteredRecordCount: 0, droppedRecords: 0 },
      {
        mode: "live",
        producedAt: "2026-10-21T00:00:00.000Z",
        harnessVersion: "9.9.9",
        dimensions: [{ name: "real_backend", status: "failed", note: "no login" }],
      },
    );
    expect(empty.authMode).toBe("unobserved");
    expect(empty.harnessVersion).toBe("9.9.9");
    expect(empty.dimensions.find((d) => d.name === "real_backend")?.status).toBe("failed");
  });
  it("writes the matrix as JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-matrix-"));
    try {
      const path = join(dir, "nested", "m.json");
      writeCapabilityMatrix(path, matrix);
      expect(JSON.parse(readText(path, "utf8"))).toEqual(matrix);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("sanitizers", () => {
  it("removes sentinels from every kind of rollout text", () => {
    const lines = [
      { type: "session_meta", payload: { id: "t1", base_instructions: { text: SENTINEL } } },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: SENTINEL }],
        },
      },
      {
        type: "response_item",
        payload: { type: "function_call", name: "shell_command", arguments: SENTINEL },
      },
      {
        type: "response_item",
        payload: { type: "function_call_output", call_id: "c1", output: SENTINEL },
      },
      { type: "world_state", payload: { full: true, state: { agents_md: { text: SENTINEL } } } },
      { type: "event_msg", payload: { type: "error", message: SENTINEL } },
    ].map((l, ordinal) => JSON.stringify({ timestamp: "2026-10-21T00:00:00.000Z", ordinal, ...l }));
    const out = lines.map(sanitizeRolloutLine).join("\n");
    expect(out).not.toContain(SENTINEL);
    expect(out).toContain("shell_command");
    expect(out).toContain('"id":"t1"');
    expect(sanitizeRolloutLine(`not json ${SENTINEL}`)).not.toContain(SENTINEL);
  });
  it("keeps the counters the reader consumes", () => {
    const line = JSON.stringify({
      timestamp: "2026-10-21T00:00:00.000Z",
      ordinal: 3,
      type: "token_usage_record",
      payload: { response_id: "resp_1", usage: { input_tokens: 1007, cached_input_tokens: 500 } },
    });
    expect(JSON.parse(sanitizeRolloutLine(line))).toEqual(JSON.parse(line));
  });
  it("removes a sentinel from a journal attribute value and keeps the rest", () => {
    const line = JSON.stringify({
      receivedAt: "2026-10-21T00:00:00.000Z",
      records: [
        {
          kind: "log",
          attributes: {
            "event.name": "codex.api_request",
            "conversation.id": "c1",
            duration_ms: "120",
            attempt: 0,
            model_reasoning_effort: SENTINEL,
            "http.response.status_code": SENTINEL,
          },
          resourceAttributes: { "service.name": "codex_exec", "host.name": SENTINEL },
        },
      ],
    });
    const out = sanitizeJournalLine(line);
    expect(out).not.toContain(SENTINEL);
    const parsed = JSON.parse(out) as { records: { attributes: Record<string, unknown> }[] };
    expect(parsed.records[0]?.attributes).toMatchObject({
      "event.name": "codex.api_request",
      duration_ms: "120",
      attempt: 0,
    });
  });
});

/** A small reader for the Responses SSE body. */
const parseSse = (body: string): { type: string; data: Record<string, unknown> }[] =>
  body
    .split("\n\n")
    .filter((b) => b !== "")
    .map((block) => {
      const type = /^event: (.*)$/m.exec(block)?.[1] ?? "";
      const data = JSON.parse(/^data: (.*)$/m.exec(block)?.[1] ?? "{}") as Record<string, unknown>;
      return { type, data };
    });

describe("fakeResponsesProvider", () => {
  it("serves the scripted outputs per request, counts them, and 404s other paths", async () => {
    const provider = await fakeResponsesProvider([
      { functionCall: { name: "shell_command", arguments: '{"command":"true"}' } },
      { text: "hello", usage: { input: 11, cached: 5, output: 3, reasoning: 1 } },
    ]);
    try {
      const url = `http://127.0.0.1:${provider.port}/v1/responses`;
      const first = parseSse(await (await fetch(url, { method: "POST", body: "{}" })).text());
      expect(first.map((e) => e.type)).toEqual([
        "response.created",
        "response.output_item.added",
        "response.output_item.done",
        "response.completed",
      ]);
      expect((first[2]?.data.item as { name: string } | undefined)?.name).toBe("shell_command");
      const second = parseSse(await (await fetch(url, { method: "POST", body: "{}" })).text());
      expect(second.map((e) => e.type)).toContain("response.output_text.delta");
      const completed = second.at(-1)?.data.response as {
        usage: Record<string, unknown>;
      };
      expect(completed.usage).toEqual({
        input_tokens: 11,
        input_tokens_details: { cached_tokens: 5 },
        output_tokens: 3,
        output_tokens_details: { reasoning_tokens: 1 },
        total_tokens: 14,
      });
      const other = await fetch(`http://127.0.0.1:${provider.port}/v1/analytics`, {
        method: "POST",
        body: "{}",
      });
      expect(other.status).toBe(404);
      expect(provider.served()).toBe(2);
      expect(provider.requests.filter((r) => r.n > 0).map((r) => r.usage?.input)).toEqual([
        1007, 11,
      ]);
    } finally {
      await provider.close();
    }
  });
});

describe("codexLauncherFor", () => {
  it("writes a wrapper that sets the key and appends the provider overrides", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-launcher-"));
    try {
      const launcher = codexLauncherFor({ port: 4321 }, { tmpDir: dir, codex: "/opt/codex" });
      expect(launcher.args).toEqual([]);
      const text = readText(launcher.file, "utf8");
      expect(text).toContain("exec '/opt/codex' \"$@\"");
      expect(text).toContain("http://127.0.0.1:4321/v1");
      expect(text).toContain("wire_api");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
