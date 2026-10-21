/**
 * Codex OTLP log telemetry as measurement evidence (P20 S-03).
 *
 * Pure and offline: it reads the receiver journal's reduced lines (after the
 * allowlist and record filter) and never touches the network or the disk.
 * **Measured on codex-cli 0.155.1 over SSE.** The WebSocket event names are in
 * the binary but were not observed; a `websocket` transport is therefore not
 * verified (`CODEX_VERIFIED_TRANSPORTS`).
 *
 * ## What the telemetry does and does not say
 *
 * - `codex.sse_event` with `event.kind=response.completed` has two records; the
 *   one carrying token counts is the usage. `input_token_count` INCLUDES
 *   `cached_token_count`. `tool_token_count` equals total tokens.
 * - No record carries a request id or a turn id. A completion is identified by
 *   its position among the conversation's completions in one launch's journal.
 * - Telemetry cannot prove a completion was not replayed after a transport
 *   reconnect. Completions become request observations only when the
 *   conversation saw no retry and used only verified transports; otherwise they
 *   are returned as `excluded` for the caller to corroborate.
 */
import type { HarnessObservation, ReceiverEnvelope, ReceiverGap } from "@nightshift/harness";

type AttributeType = "count" | "number" | "boolean" | "enum" | "id" | "timestamp";
interface AttributeSpec {
  readonly key: string;
  readonly type: AttributeType;
  readonly values?: readonly string[];
}

/** The receiver allowlist, with types. Nothing free-text: no prompt, error message, tool name or call id. */
export const CODEX_OTEL_ATTRIBUTES: readonly AttributeSpec[] = [
  {
    key: "event.name",
    type: "enum",
    values: [
      "codex.conversation_starts",
      "codex.api_request",
      "codex.sse_event",
      "codex.websocket.event",
      "codex.websocket_request",
      "codex.turn_ttft",
    ],
  },
  { key: "event.kind", type: "id" },
  { key: "input_token_count", type: "count" },
  { key: "output_token_count", type: "count" },
  { key: "cached_token_count", type: "count" },
  { key: "cache_write_token_count", type: "count" },
  { key: "reasoning_token_count", type: "count" },
  { key: "tool_token_count", type: "count" },
  { key: "attempt", type: "count" },
  { key: "http.response.status_code", type: "count" },
  { key: "duration_ms", type: "count" },
  { key: "ttft_ms", type: "count" },
  { key: "model", type: "id" },
  { key: "slug", type: "id" },
  {
    key: "model_reasoning_effort",
    type: "enum",
    values: ["minimal", "low", "medium", "high", "xhigh"],
  },
  { key: "conversation.id", type: "id" },
  { key: "app.version", type: "id" },
  { key: "originator", type: "id" },
  { key: "event.timestamp", type: "timestamp" },
  { key: "success", type: "boolean" },
  { key: "auth.env_openai_api_key_present", type: "boolean" },
  { key: "auth.env_codex_api_key_present", type: "boolean" },
  { key: "auth.env_provider_key_present", type: "boolean" },
  { key: "service.name", type: "id" },
  { key: "service.version", type: "id" },
];

/** Rules of exact pairs; a record is kept when any rule matches. */
export const CODEX_OTEL_RECORD_FILTER: readonly Readonly<Record<string, string>>[] = [
  { "event.name": "codex.conversation_starts" },
  { "event.name": "codex.api_request" },
  { "event.name": "codex.sse_event", "event.kind": "response.completed" },
  { "event.name": "codex.websocket.event", "event.kind": "response.completed" },
  { "event.name": "codex.sse_event", "event.kind": "response.failed" },
  { "event.name": "codex.websocket.event", "event.kind": "response.failed" },
  { "event.name": "codex.sse_event", "event.kind": "error" },
  { "event.name": "codex.websocket.event", "event.kind": "error" },
];

export type CodexTransport = "sse" | "websocket" | "unknown";

/**
 * Transports whose completions are trusted to be unreplayed when no retry was
 * seen. 'websocket' is added only after a committed live capability matrix
 * observed it.
 */
export const CODEX_VERIFIED_TRANSPORTS: readonly CodexTransport[] = ["sse"] as const;

export interface CodexCompletedResponse {
  /** Position of this completion among the conversation's completions in the journal. */
  readonly position: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cachedTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly reasoningTokens?: number;
  /** `tool_token_count`, which equals total tokens. */
  readonly totalTokens?: number;
  readonly occurredAt?: string;
  readonly model?: string;
  /** The event name the completion arrived on. */
  readonly eventName?: string;
  /** The attempt number of the api_request that preceded this completion. */
  readonly attempt?: number;
}

export interface CodexApiAttempt {
  readonly attempt: number;
  readonly status?: number;
  readonly durationMs?: number;
}

export interface CodexConversationEvidence {
  readonly conversationId: string;
  readonly completions: readonly CodexCompletedResponse[];
  readonly attempts: readonly CodexApiAttempt[];
  readonly transports: readonly CodexTransport[];
  readonly retried: boolean;
  readonly appVersion?: string;
  readonly model?: string;
  readonly originator?: string;
  readonly auth?: {
    readonly openaiApiKeyPresent?: boolean;
    readonly codexApiKeyPresent?: boolean;
    readonly providerKeyPresent?: boolean;
  };
}

export type CodexLossReason = "torn_line" | "journal_full" | "records_truncated" | "not_closed";

export interface CodexTelemetryEvidence {
  readonly conversations: readonly CodexConversationEvidence[];
  /** Real evidence loss. Never includes records filtered on purpose. */
  readonly lossGaps: readonly { readonly reason: CodexLossReason; readonly count: number }[];
  /** Informational: records the receiver excluded by its filter. Not a loss. */
  readonly filteredRecordCount: number;
  /** Records dropped by the receiver or lacking a conversation id. */
  readonly droppedRecords: number;
}

const count = (value: unknown): number | undefined => {
  if (typeof value === "number")
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  if (typeof value === "string" && /^\d{1,15}$/.test(value)) return Number(value);
  return undefined;
};
const str = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;
const bool = (value: unknown): boolean | undefined =>
  typeof value === "boolean" ? value : undefined;
const iso = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
};

interface Builder {
  completions: CodexCompletedResponse[];
  attempts: CodexApiAttempt[];
  transports: Set<CodexTransport>;
  currentAttempt: number | undefined;
  facts: {
    appVersion?: string | undefined;
    model?: string | undefined;
    originator?: string | undefined;
    auth: {
      openaiApiKeyPresent?: boolean;
      codexApiKeyPresent?: boolean;
      providerKeyPresent?: boolean;
    };
  };
}

const withDefined = <T extends object>(value: T): T =>
  Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;

export const decodeCodexTelemetry = (
  lines: Iterable<ReceiverEnvelope | ReceiverGap>,
): CodexTelemetryEvidence => {
  const builders = new Map<string, Builder>();
  const loss = new Map<CodexLossReason, number>();
  let closed = false;
  let filtered = 0;
  let dropped = 0;

  for (const line of lines) {
    if ("closed" in line) {
      closed = true;
      continue;
    }
    if ("gap" in line) {
      loss.set(line.gap, (loss.get(line.gap) ?? 0) + 1);
      continue;
    }
    filtered += line.filteredRecordCount ?? 0;
    dropped += line.droppedRecordCount;
    for (const record of line.records) {
      const a = record.attributes;
      const conversation = str(a["conversation.id"]);
      if (conversation === undefined) {
        dropped += 1;
        continue;
      }
      let b = builders.get(conversation);
      if (b === undefined) {
        b = {
          completions: [],
          attempts: [],
          transports: new Set(),
          currentAttempt: undefined,
          facts: { auth: {} },
        };
        builders.set(conversation, b);
      }
      const name = str(a["event.name"]) ?? record.eventName;
      const kind = str(a["event.kind"]);
      switch (name) {
        case "codex.conversation_starts": {
          b.facts.appVersion ??=
            str(a["app.version"]) ?? str(record.resourceAttributes["service.version"]);
          b.facts.model ??= str(a.model);
          b.facts.originator ??= str(a.originator);
          const o = bool(a["auth.env_openai_api_key_present"]);
          const c = bool(a["auth.env_codex_api_key_present"]);
          const p = bool(a["auth.env_provider_key_present"]);
          if (o !== undefined) b.facts.auth.openaiApiKeyPresent = o;
          if (c !== undefined) b.facts.auth.codexApiKeyPresent = c;
          if (p !== undefined) b.facts.auth.providerKeyPresent = p;
          break;
        }
        case "codex.api_request": {
          const attempt = count(a.attempt) ?? 0;
          b.currentAttempt = attempt;
          b.attempts.push(
            withDefined({
              attempt,
              status: count(a["http.response.status_code"]),
              durationMs: count(a.duration_ms),
            }) as CodexApiAttempt,
          );
          break;
        }
        case "codex.sse_event":
        case "codex.websocket.event":
        case "codex.websocket_request": {
          b.transports.add(name === "codex.sse_event" ? "sse" : "websocket");
          if (kind !== "response.completed" || name === "codex.websocket_request") break;
          const inputTokens = count(a.input_token_count);
          const outputTokens = count(a.output_token_count);
          const cachedTokens = count(a.cached_token_count);
          const cacheWriteTokens = count(a.cache_write_token_count);
          const reasoningTokens = count(a.reasoning_token_count);
          const totalTokens = count(a.tool_token_count);
          // The duration-only twin carries no usage.
          if (
            [
              inputTokens,
              outputTokens,
              cachedTokens,
              cacheWriteTokens,
              reasoningTokens,
              totalTokens,
            ].every((v) => v === undefined)
          )
            break;
          b.completions.push(
            withDefined({
              position: b.completions.length,
              inputTokens,
              outputTokens,
              cachedTokens,
              cacheWriteTokens,
              reasoningTokens,
              totalTokens,
              occurredAt: iso(a["event.timestamp"]),
              model: str(a.model),
              eventName: name,
              attempt: b.currentAttempt,
            }) as CodexCompletedResponse,
          );
          break;
        }
        default:
          // An event this adapter does not know: its transport is unknown.
          if (kind === "response.completed") b.transports.add("unknown");
      }
    }
  }

  const lossGaps: { reason: CodexLossReason; count: number }[] = [...loss].map(([reason, n]) => ({
    reason,
    count: n,
  }));
  if (!closed) lossGaps.push({ reason: "not_closed", count: 1 });

  return {
    conversations: [...builders].map(
      ([conversationId, b]) =>
        withDefined({
          conversationId,
          completions: b.completions,
          attempts: b.attempts,
          transports: [...b.transports],
          retried: b.attempts.some((x) => x.attempt > 0),
          appVersion: b.facts.appVersion,
          model: b.facts.model,
          originator: b.facts.originator,
          auth: Object.keys(b.facts.auth).length > 0 ? b.facts.auth : undefined,
        }) as CodexConversationEvidence,
    ),
    lossGaps,
    filteredRecordCount: filtered,
    droppedRecords: dropped,
  };
};

export interface ExcludedCompletions {
  readonly conversation: string;
  readonly count: number;
  readonly reason: "retried" | "unverified_transport";
}

export const telemetryObservations = (
  evidence: CodexTelemetryEvidence,
  options: { readonly threadId: string; readonly verifiedTransports?: readonly CodexTransport[] },
): { observations: HarnessObservation[]; excluded: ExcludedCompletions[] } => {
  const verified = options.verifiedTransports ?? CODEX_VERIFIED_TRANSPORTS;
  const observations: HarnessObservation[] = [];
  const excluded: ExcludedCompletions[] = [];
  for (const c of evidence.conversations) {
    if (c.completions.length === 0) continue;
    if (c.retried || c.attempts.some((x) => x.attempt > 0)) {
      excluded.push({
        conversation: c.conversationId,
        count: c.completions.length,
        reason: "retried",
      });
      continue;
    }
    if (c.transports.length === 0 || c.transports.some((t) => !verified.includes(t))) {
      excluded.push({
        conversation: c.conversationId,
        count: c.completions.length,
        reason: "unverified_transport",
      });
      continue;
    }
    for (const r of c.completions) {
      const model = r.model ?? c.model;
      observations.push({
        observationId: `codex:otel:${c.conversationId}:${r.position}`,
        kind: "request",
        sessionId: c.conversationId,
        ...(model === undefined ? {} : { model }),
        counters: withDefined({
          inputTokens: r.inputTokens,
          cacheReadTokens: r.cachedTokens,
          cacheWriteTokens: r.cacheWriteTokens,
          outputTokens: r.outputTokens,
          reasoningTokens: r.reasoningTokens,
          inputIncludesCache: r.inputTokens === undefined ? undefined : true,
        }),
        ...(r.occurredAt === undefined ? {} : { occurredAt: r.occurredAt }),
        source: "harness",
        provenance: withDefined({
          adapter: "codex",
          version: c.appVersion,
          note: `otlp ${r.eventName ?? "codex.sse_event"} response.completed; no request id in telemetry; position-identified`,
        }) as { adapter: string; version?: string; note: string },
        inclusion: "self",
        ...(c.conversationId === options.threadId
          ? {}
          : { childRef: { kind: "session" as const, id: c.conversationId } }),
      } as HarnessObservation);
    }
  }
  return { observations, excluded };
};
