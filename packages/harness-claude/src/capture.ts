/**
 * Claude Code request capture (P20 S-02): per-request usage from OTLP logs.
 *
 * The CLI's stream reports usage only in aggregate; the per-request
 * `api_request` log event exists only on its OpenTelemetry export. So the
 * adapter starts the loopback receiver (`@nightshift/harness`), points the
 * child's OTLP/HTTP logs exporter at it, and this module tails the receiver's
 * reduced-envelope journal and turns each `api_request` record into a
 * `request` observation for the measurement sink.
 *
 * Verified live against Claude Code 2.1.286 (2026-10-20/21, unauthenticated
 * sandbox): the transport (POST /v1/logs, application/json, Authorization
 * header honoured), the resource attribute keys, the event names and the
 * `api_error` attribute set. The `otelHeadersHelper` setting delivered from a
 * `--settings` file with `--setting-sources ""` was also verified live on
 * 2.1.286 on 2026-10-21. The `api_request` attribute set is taken from vendor
 * documentation and is NOT verified live; see
 * `__fixtures__/telemetry/README.md`.
 *
 * Boundaries: metadata only (the receiver keeps only
 * `CLAUDE_TELEMETRY_ATTRIBUTES`; nothing outside it is ever copied), and
 * `cost_usd` is Claude Code's client-side estimate, never billed spend.
 *
 * The capability never enters the child environment on a machine, where the
 * adapter's env becomes `sudo … env K=V` argv: it travels in a 0600 headers
 * file that `otelHeadersHelper` prints. Only on win32 (where runAs never
 * applies) is it passed as `OTEL_EXPORTER_OTLP_HEADERS`.
 */
import { open, stat } from "node:fs/promises";
import type { HarnessObservation, MeasurementSink, ReceiverRecord } from "@nightshift/harness";
import {
  type Duration,
  type LocalReceiver,
  millis,
  receiverEnvelopeSchema,
  receiverGapSchema,
  startLocalReceiver,
} from "@nightshift/harness";

/** The only attributes the receiver may journal. Nothing user-, org-, prompt-, tool- or error-text-shaped. */
export const CLAUDE_TELEMETRY_ATTRIBUTES: readonly string[] = [
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
];

/** The header-free child environment that turns on the logs exporter toward `endpoint`. */
export const claudeTelemetryEnv = (
  endpoint: string,
  opts: { exportIntervalMs?: number } = {},
): Record<string, string> => ({
  CLAUDE_CODE_ENABLE_TELEMETRY: "1",
  OTEL_LOGS_EXPORTER: "otlp",
  OTEL_METRICS_EXPORTER: "none",
  OTEL_TRACES_EXPORTER: "none",
  OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
  OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
  OTEL_LOGS_EXPORT_INTERVAL: String(opts.exportIntervalMs ?? 1000),
  OTEL_METRICS_INCLUDE_VERSION: "true",
  OTEL_METRICS_INCLUDE_SESSION_ID: "true",
  OTEL_METRICS_INCLUDE_ACCOUNT_UUID: "false",
});

/** The headers file text (the adapter writes it 0600 in its private config directory). */
export const claudeTelemetryHeadersFile = (capability: string): string =>
  JSON.stringify({ Authorization: `Bearer ${capability}` });

const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * The `otelHeadersHelper` command line printing the headers file, or undefined
 * on win32 where `claudeTelemetryHeaderEnv` is used instead.
 */
export const claudeTelemetryHeadersHelper = (
  path: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined => (platform === "win32" ? undefined : `cat ${shellQuote(path)}`);

/** win32 only: the capability as an exporter header (runAs never applies there). */
export const claudeTelemetryHeaderEnv = (capability: string): Record<string, string> => ({
  OTEL_EXPORTER_OTLP_HEADERS: `Authorization=Bearer ${capability}`,
});

// ---------------------------------------------------------------------------
// Decoding

export type DecodeSkip = "not_api_request" | "unidentified" | "no_counters";

export interface DecodeContext {
  readonly fallbackVersion?: string;
}

const MAX_STRING = 200;
const COST_NOTE =
  "cost_usd is Claude Code's client-side estimate, not billed spend; api_request from OTLP logs";

const text = (v: unknown): string | undefined =>
  typeof v === "string" && v !== "" ? v.slice(0, MAX_STRING) : undefined;
const count = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : undefined;
const nonNegative = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;

const eventNameOf = (record: ReceiverRecord): string | undefined =>
  record.eventName?.replace(/^claude_code\./, "");

const isoFromNano = (nano: string | undefined): string | undefined => {
  if (nano === undefined || !/^\d+$/.test(nano)) return undefined;
  const ms = Number(BigInt(nano) / 1_000_000n);
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
};

const isoFromText = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
};

export const decodeClaudeTelemetryRecord = (
  record: ReceiverRecord,
  ctx: DecodeContext = {},
): { observation: HarnessObservation } | { skipped: DecodeSkip } => {
  if (record.kind !== "log" || eventNameOf(record) !== "api_request")
    return { skipped: "not_api_request" };
  const a = record.attributes;

  const requestId = text(a.request_id);
  const clientRequestId = text(a.client_request_id);
  const sessionId = text(a["session.id"]);
  const sequence = count(a["event.sequence"]);
  const observationId = requestId
    ? `claude:api_request:${requestId}`
    : clientRequestId
      ? `claude:api_request:${clientRequestId}`
      : sessionId !== undefined && sequence !== undefined
        ? `claude:api_request:${sessionId}:${sequence}`
        : undefined;
  if (observationId === undefined) return { skipped: "unidentified" };

  const inputTokens = count(a.input_tokens);
  const outputTokens = count(a.output_tokens);
  const cacheReadTokens = count(a.cache_read_tokens);
  const cacheWriteTokens = count(a.cache_creation_tokens);
  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    cacheReadTokens === undefined &&
    cacheWriteTokens === undefined
  )
    return { skipped: "no_counters" };

  const micros = nonNegative(a.cost_usd_micros);
  const reportedCostUsd =
    nonNegative(a.cost_usd) ?? (micros === undefined ? undefined : micros / 1e6);
  const agentName = text(a["agent.name"]);
  const querySource = text(a.query_source);
  const childId = agentName ?? (querySource === "subagent" ? querySource : undefined);
  const occurredAt = isoFromText(a["event.timestamp"]) ?? isoFromNano(record.timeUnixNano);
  const durationMs = count(a.duration_ms);
  const model = text(a.model);

  const observation: HarnessObservation = {
    schemaVersion: 1,
    kind: "request",
    observationId,
    source: "harness",
    inclusion: "self",
    provenance: {
      adapter: "claude",
      ...((text(a["app.version"]) ?? ctx.fallbackVersion) !== undefined
        ? { version: text(a["app.version"]) ?? ctx.fallbackVersion }
        : {}),
      note: COST_NOTE,
    },
    counters: {
      ...(inputTokens !== undefined ? { inputTokens } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
      ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
      ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
      inputIncludesCache: false,
    },
    ...(requestId !== undefined ? { requestId } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(reportedCostUsd !== undefined ? { reportedCostUsd } : {}),
    ...(occurredAt !== undefined ? { occurredAt } : {}),
    ...(childId !== undefined ? { childRef: { kind: "agent" as const, id: childId } } : {}),
  };
  return { observation };
};

// ---------------------------------------------------------------------------
// Capture

export type CaptureIncompleteReason =
  | "no_api_request"
  | "receiver_lost"
  | "stopped_before_flush"
  | "journal_full"
  | "records_truncated"
  | "torn_tail"
  | "unidentified_request_dropped"
  | "records_dropped";

type ValueType = "string" | "number" | "boolean";

const PRESENCE_KEYS = [
  "request_id",
  "client_request_id",
  "session.id",
  "cost_usd",
  "cost_usd_micros",
  "duration_ms",
  "effort",
  "speed",
  "agent.name",
  "query_source",
  "event.timestamp",
  "event.sequence",
] as const;
type PresenceKey = (typeof PRESENCE_KEYS)[number];

/** Sanitized metadata about what was seen; never identifier values or text. */
export interface ClaudeCaptureDiagnostics {
  transport: { paths: string[]; contentTypes: string[] };
  resourceAttributeKeys: string[];
  appVersions: string[];
  eventCounts: Record<string, number>;
  apiRequest: {
    attributeTypes: Record<string, ValueType>;
    present: Record<PresenceKey, boolean>;
    querySourceClasses: { main: number; child: number; compact: number; other: number };
  };
  droppedAttributeCount: number;
}

export interface ClaudeCaptureResult {
  requests: number;
  apiErrors: number;
  droppedRecords: number;
  droppedAttributes: number;
  unidentifiedRequests: number;
  gap?: "receiver_lost" | "stopped_before_flush";
  complete: boolean;
  reasons: CaptureIncompleteReason[];
  diagnostics: ClaudeCaptureDiagnostics;
}

export interface ClaudeCapture {
  readonly endpoint: string;
  readonly capability: string;
  /** The receiver child's pid (for supervision and tests). */
  readonly pid: number;
  /** `claudeTelemetryEnv(endpoint)`: header-free; deliver the capability separately. */
  readonly env: Record<string, string>;
  /** Idempotent; never throws. */
  stop(grace?: Duration): Promise<ClaudeCaptureResult>;
}

export interface ClaudeCaptureInput {
  /**
   * Engine-owned storage OUTSIDE any directory handed to `runAs.grant`, so the
   * agent's user can neither read nor tamper with the journal. The adapter chooses it.
   */
  readonly journalPath: string;
  readonly sink: MeasurementSink;
  readonly exportIntervalMs?: number;
  readonly pollMs?: number;
  readonly node?: string;
  readonly fallbackVersion?: string;
}

const MAX_KEYS = 32;
const MAX_KEY_CHARS = 64;
const MAX_SEEN_IDS = 100_000;
const STOP_SLACK_MS = 3000;

const addBounded = (set: Set<string>, value: string): void => {
  if (set.size < MAX_KEYS) set.add(value.slice(0, MAX_KEY_CHARS));
};

const valueType = (v: unknown): ValueType | undefined =>
  typeof v === "string" || typeof v === "number" || typeof v === "boolean"
    ? (typeof v as ValueType)
    : undefined;

export const startClaudeCapture = async (input: ClaudeCaptureInput): Promise<ClaudeCapture> => {
  const receiver: LocalReceiver = await startLocalReceiver({
    journalPath: input.journalPath,
    allowedAttributes: CLAUDE_TELEMETRY_ATTRIBUTES,
    ...(input.node !== undefined ? { node: input.node } : {}),
  });

  const paths = new Set<string>();
  const contentTypes = new Set<string>();
  const resourceKeys = new Set<string>();
  const appVersions = new Set<string>();
  const eventCounts = new Map<string, number>();
  const attributeTypes = new Map<string, ValueType>();
  const present = Object.fromEntries(PRESENCE_KEYS.map((k) => [k, false])) as Record<
    PresenceKey,
    boolean
  >;
  const classes = { main: 0, child: 0, compact: 0, other: 0 };
  const seenIds = new Set<string>();
  let apiErrors = 0;
  let droppedRecords = 0;
  let droppedAttributes = 0;
  let unidentified = 0;
  let closed = false;
  const gaps = new Set<"journal_full" | "records_truncated" | "torn_line">();
  let offset = 0;
  let carry = "";
  let tornTail = false;

  const note = (record: ReceiverRecord): void => {
    droppedAttributes += record.droppedAttributeCount;
    for (const key of Object.keys(record.resourceAttributes)) addBounded(resourceKeys, key);
    const name = eventNameOf(record);
    if (name !== undefined) {
      const key = name.slice(0, MAX_KEY_CHARS);
      if (eventCounts.has(key) || eventCounts.size < MAX_KEYS)
        eventCounts.set(key, (eventCounts.get(key) ?? 0) + 1);
    }
    const version = record.attributes["app.version"];
    if (typeof version === "string") addBounded(appVersions, version);
    if (name === "api_error") apiErrors++;
  };

  const noteApiRequest = (record: ReceiverRecord): void => {
    const a = record.attributes;
    for (const [key, value] of Object.entries(a)) {
      const type = valueType(value);
      if (type !== undefined && CLAUDE_TELEMETRY_ATTRIBUTES.includes(key))
        attributeTypes.set(key, type);
    }
    for (const key of PRESENCE_KEYS) if (a[key] !== undefined) present[key] = true;
    const source = a.query_source;
    if (a["agent.name"] !== undefined || source === "subagent") classes.child++;
    else if (source === "compact") classes.compact++;
    else if (source === "main" || source === "sdk" || source === "repl_main_thread") classes.main++;
    else classes.other++;
  };

  const handleLine = (line: string): void => {
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      gaps.add("torn_line");
      return;
    }
    const envelope = receiverEnvelopeSchema.safeParse(json);
    if (envelope.success) {
      const e = envelope.data;
      addBounded(paths, e.path);
      addBounded(contentTypes, e.contentType);
      droppedRecords += e.droppedRecordCount;
      for (const parsed of e.records) {
        const record = parsed as unknown as ReceiverRecord; // validated by receiverEnvelopeSchema
        note(record);
        if (record.kind !== "log" || eventNameOf(record) !== "api_request") continue;
        noteApiRequest(record);
        const decoded = decodeClaudeTelemetryRecord(record, {
          ...(input.fallbackVersion !== undefined
            ? { fallbackVersion: input.fallbackVersion }
            : {}),
        });
        if ("skipped" in decoded) {
          if (decoded.skipped === "unidentified") unidentified++;
          continue;
        }
        const id = decoded.observation.observationId;
        if (seenIds.has(id)) continue;
        if (seenIds.size < MAX_SEEN_IDS) seenIds.add(id);
        try {
          input.sink.observe(decoded.observation);
        } catch {
          // observe never throws by contract; a sink that does must not stop capture.
        }
      }
      return;
    }
    const gap = receiverGapSchema.safeParse(json);
    if (!gap.success) {
      gaps.add("torn_line");
      return;
    }
    if ("closed" in gap.data) closed = true;
    else gaps.add(gap.data.gap);
  };

  /** Reads the journal's new complete lines; a final read also judges the unterminated tail. */
  const readOnce = async (final: boolean): Promise<void> => {
    try {
      const size = (await stat(input.journalPath)).size;
      if (size > offset) {
        const handle = await open(input.journalPath, "r");
        try {
          const buffer = Buffer.alloc(size - offset);
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
          offset += bytesRead;
          carry += buffer.subarray(0, bytesRead).toString("utf8");
        } finally {
          await handle.close();
        }
        let newline = carry.indexOf("\n");
        while (newline >= 0) {
          const line = carry.slice(0, newline);
          carry = carry.slice(newline + 1);
          if (line !== "") handleLine(line);
          newline = carry.indexOf("\n");
        }
      }
    } catch {
      // No journal yet, or unreadable: nothing to read this tick.
    }
    if (final && carry !== "") tornTail = true;
  };

  let reading: Promise<void> = Promise.resolve();
  const poll = (final: boolean): Promise<void> => {
    reading = reading.then(() => readOnce(final));
    return reading;
  };
  const timer = setInterval(() => void poll(false), Math.max(50, input.pollMs ?? 1000));
  timer.unref();

  let stopping: Promise<ClaudeCaptureResult> | undefined;
  const stop = (grace: Duration = millis(2000)): Promise<ClaudeCaptureResult> => {
    stopping ??= (async () => {
      let gap: "receiver_lost" | "stopped_before_flush" | undefined;
      try {
        const bound = grace.ms + STOP_SLACK_MS;
        let timeout: NodeJS.Timeout | undefined;
        const outcome = await Promise.race([
          receiver.stop(grace),
          new Promise<{ gap: "stopped_before_flush" }>((resolve) => {
            timeout = setTimeout(() => resolve({ gap: "stopped_before_flush" }), bound);
          }),
        ]);
        clearTimeout(timeout);
        gap = outcome.gap;
      } catch {
        gap = "receiver_lost";
      }
      clearInterval(timer);
      try {
        await poll(true);
      } catch {
        // readOnce does not throw.
      }
      return finish(gap);
    })();
    return stopping;
  };

  const finish = (
    gap: "receiver_lost" | "stopped_before_flush" | undefined,
  ): ClaudeCaptureResult => {
    const requests = seenIds.size;
    const reasons: CaptureIncompleteReason[] = [];
    if (gap !== undefined) reasons.push(gap);
    else if (!closed) reasons.push("stopped_before_flush");
    if (gaps.has("journal_full")) reasons.push("journal_full");
    if (gaps.has("records_truncated")) reasons.push("records_truncated");
    if (gaps.has("torn_line") || tornTail) reasons.push("torn_tail");
    if (droppedRecords > 0) reasons.push("records_dropped");
    if (unidentified > 0) reasons.push("unidentified_request_dropped");
    if (requests === 0) reasons.push("no_api_request");
    return {
      requests,
      apiErrors,
      droppedRecords,
      droppedAttributes,
      unidentifiedRequests: unidentified,
      ...(gap !== undefined ? { gap } : {}),
      complete: reasons.length === 0,
      reasons,
      diagnostics: {
        transport: { paths: [...paths].sort(), contentTypes: [...contentTypes].sort() },
        resourceAttributeKeys: [...resourceKeys].sort(),
        appVersions: [...appVersions].sort(),
        eventCounts: Object.fromEntries([...eventCounts].sort(([x], [y]) => x.localeCompare(y))),
        apiRequest: {
          attributeTypes: Object.fromEntries(
            [...attributeTypes].sort(([x], [y]) => x.localeCompare(y)),
          ),
          present: { ...present },
          querySourceClasses: { ...classes },
        },
        droppedAttributeCount: droppedAttributes,
      },
    };
  };

  return {
    endpoint: receiver.endpoint,
    capability: receiver.capability,
    pid: receiver.pid,
    env: claudeTelemetryEnv(receiver.endpoint, {
      ...(input.exportIntervalMs !== undefined ? { exportIntervalMs: input.exportIntervalMs } : {}),
    }),
    stop,
  };
};
