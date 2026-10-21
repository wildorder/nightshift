/**
 * The opt-in Codex measurement probes (P20 S-03): their gates, the capability
 * matrix they write, and the offline machinery (a loopback Responses provider,
 * a launcher that points the real binary at it, and the fixture sanitizers).
 *
 * Follows `packages/harness-claude/src/conformance.ts`: a gate is pure, returns
 * `enabled` plus a prose reason, and a skipped suite says why it skipped.
 * **Nothing here spawns, listens or writes until a caller asks.** The two test
 * files (`probe-offline.test.ts`, `probe-live.test.ts`) wire the gates; plain
 * `npm test` on a machine without the binary or the variable skips both.
 *
 * Metadata only: the sanitizers keep identifiers, counters and timings and
 * replace every text field, so a regenerated fixture or matrix cannot carry a
 * prompt, a tool argument or a response body.
 */
import { execFileSync } from "node:child_process";
import { accessSync, chmodSync, constants, mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { delimiter, dirname, join } from "node:path";
import type { CliLauncher } from "@nightshift/harness";
import { VERIFIED_CODEX_VERSION } from "./command.js";
import type { CodexTelemetryEvidence, CodexTransport } from "./telemetry.js";

export type ProbeEnv = Readonly<Record<string, string | undefined>>;

export interface ProbeGate {
  readonly enabled: boolean;
  /** Why, in prose. Shown on a skipped suite so the skip is never silent. */
  readonly reason: string;
}

/** The variable that opts a machine in to the live probe: `NIGHTSHIFT_MEASUREMENT_PROBE=<harness>`. */
export const MEASUREMENT_PROBE_ENV = "NIGHTSHIFT_MEASUREMENT_PROBE";
export const MEASUREMENT_PROBE_VALUE = "codex";
/** Allows the offline probe on a `codex` that is not the verified version. */
export const PROBE_ALLOW_VERSION_ENV = "NIGHTSHIFT_MEASUREMENT_PROBE_ALLOW_VERSION";
/** `write` regenerates the sanitized fixtures and the offline capability matrix. */
export const MEASUREMENT_FIXTURES_ENV = "NIGHTSHIFT_MEASUREMENT_FIXTURES";

export interface OfflineProbeDeps {
  /** The absolute path of `name` on `PATH`, if it is there. */
  readonly findExecutable: (name: string, path: string | undefined) => string | undefined;
  /** What `<binary> --version` printed, if it ran. */
  readonly version: (binary: string) => string | undefined;
}

export const findExecutableOnPath = (
  name: string,
  path: string | undefined,
): string | undefined => {
  for (const dir of (path ?? "").split(delimiter)) {
    if (dir === "") continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not here
    }
  }
  return undefined;
};

export const runVersion = (binary: string): string | undefined => {
  try {
    return execFileSync(binary, ["--version"], {
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
};

/** `codex-cli 0.155.1` becomes `0.155.1`. */
export const parseCodexVersion = (output: string): string | undefined =>
  /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/.exec(output)?.[1];

const defaultDeps: OfflineProbeDeps = { findExecutable: findExecutableOnPath, version: runVersion };

/**
 * Whether the offline probe may run: a `codex` on `PATH` reporting the verified
 * version (or `NIGHTSHIFT_MEASUREMENT_PROBE_ALLOW_VERSION=1`). The probe talks
 * only to a loopback provider and a temporary `CODEX_HOME`.
 */
export const codexOfflineProbeGate = (
  env: ProbeEnv = process.env,
  deps: OfflineProbeDeps = defaultDeps,
): ProbeGate => {
  const binary = deps.findExecutable("codex", env.PATH);
  if (binary === undefined) {
    return {
      enabled: false,
      reason:
        "skipped: the offline Codex probe drives the real `codex` binary and no `codex` was found on PATH. " +
        `Install codex-cli ${VERIFIED_CODEX_VERSION} to run it. It is skipped, not passed.`,
    };
  }
  const printed = deps.version(binary);
  const version = printed === undefined ? undefined : parseCodexVersion(printed);
  if (version === undefined) {
    return {
      enabled: false,
      reason: `skipped: \`${binary} --version\` printed no version, so the verified ${VERIFIED_CODEX_VERSION} cannot be confirmed. It is skipped, not passed.`,
    };
  }
  if (version === VERIFIED_CODEX_VERSION) {
    return {
      enabled: true,
      reason: `codex ${version} at ${binary}: driving it against a loopback provider`,
    };
  }
  if (env[PROBE_ALLOW_VERSION_ENV] === "1") {
    return {
      enabled: true,
      reason: `codex ${version} at ${binary} is not the verified ${VERIFIED_CODEX_VERSION}; ${PROBE_ALLOW_VERSION_ENV}=1 allows it`,
    };
  }
  return {
    enabled: false,
    reason:
      `skipped: the codex binary at ${binary} is ${version}, but the probe is verified against ` +
      `${VERIFIED_CODEX_VERSION}. Set ${PROBE_ALLOW_VERSION_ENV}=1 to run it anyway. It is skipped, not passed.`,
  };
};

/** Whether the live probe (the operator's login, the real backend) is requested. */
export const codexLiveProbeGate = (env: ProbeEnv = process.env): ProbeGate => {
  const value = env[MEASUREMENT_PROBE_ENV];
  if (value === MEASUREMENT_PROBE_VALUE) {
    return {
      enabled: true,
      reason: `${MEASUREMENT_PROBE_ENV}=${MEASUREMENT_PROBE_VALUE}: driving the real Codex backend with the operator's login`,
    };
  }
  const seen = value === undefined ? "unset" : `set to ${JSON.stringify(value)}`;
  return {
    enabled: false,
    reason:
      `skipped: the live probe uses the operator's Codex login and the real backend, which CI does not have. ` +
      `${MEASUREMENT_PROBE_ENV} is ${seen}; set ${MEASUREMENT_PROBE_ENV}=${MEASUREMENT_PROBE_VALUE} to run it. It is skipped, not passed.`,
  };
};

// ---------------------------------------------------------------------------
// The capability matrix

export type DimensionStatus = "observed" | "not_observed" | "unverified" | "failed";

export interface CapabilityDimension {
  readonly name: string;
  readonly status: DimensionStatus;
  readonly note?: string;
}

export interface CapabilityMatrix {
  readonly harness: "codex";
  readonly harnessVersion: string;
  readonly producedAt: string;
  readonly mode: "offline" | "live";
  readonly transports: string[];
  /** As `codex.conversation_starts` reports it: the `auth.*` flags, or `unobserved`. */
  readonly authMode: string;
  readonly fieldsObserved: string[];
  readonly nativeChildren: "observed" | "not_observed" | "unverified";
  readonly dimensions: CapabilityDimension[];
  /** Prose for whoever reads the file: what it does and does not establish. */
  readonly notes?: string[];
}

export interface CapabilityFacts {
  readonly mode: "offline" | "live";
  readonly producedAt: string;
  /** Used when the telemetry carries no `app.version`. */
  readonly harnessVersion?: string;
  /** Rollout fields the run also showed (`response_id`, `thread_token_usage`, ...). */
  readonly rolloutFields?: readonly string[];
  /**
   * Wins over what the conversations imply. A matrix merged from several runs
   * must say it, since its conversations are not one run's children.
   */
  readonly nativeChildren?: CapabilityMatrix["nativeChildren"];
  /** Dimensions the probe itself established; they win over the derived ones. */
  readonly dimensions?: readonly CapabilityDimension[];
  readonly notes?: readonly string[];
}

/** The dimensions every matrix names; one nobody established is `unverified`, never absent. */
export const STANDARD_DIMENSIONS: readonly string[] = [
  "transport_sse",
  "transport_websocket",
  "request_counters",
  "cache_write_counter",
  "reasoning_counter",
  "native_children",
  "interrupted_run",
  "resume_continuation",
  "real_backend",
  "auth_mode",
];

const authModeOf = (evidence: CodexTelemetryEvidence): string => {
  for (const c of evidence.conversations) {
    const a = c.auth;
    if (a === undefined) continue;
    const parts = [
      a.openaiApiKeyPresent === undefined
        ? undefined
        : `auth.env_openai_api_key_present=${a.openaiApiKeyPresent}`,
      a.codexApiKeyPresent === undefined
        ? undefined
        : `auth.env_codex_api_key_present=${a.codexApiKeyPresent}`,
      a.providerKeyPresent === undefined
        ? undefined
        : `auth.env_provider_key_present=${a.providerKeyPresent}`,
    ].filter((p): p is string => p !== undefined);
    if (parts.length > 0) return parts.join(",");
  }
  return "unobserved";
};

const fieldsOf = (evidence: CodexTelemetryEvidence): string[] => {
  const fields = new Set<string>();
  for (const c of evidence.conversations) {
    if (c.appVersion !== undefined) fields.add("app.version");
    if (c.model !== undefined) fields.add("model");
    if (c.originator !== undefined) fields.add("originator");
    if (c.auth !== undefined) fields.add("auth");
    if (c.attempts.length > 0) fields.add("attempt");
    for (const a of c.attempts) {
      if (a.status !== undefined) fields.add("http.response.status_code");
      if (a.durationMs !== undefined) fields.add("duration_ms");
    }
    for (const r of c.completions) {
      if (r.inputTokens !== undefined) fields.add("input_token_count");
      if (r.outputTokens !== undefined) fields.add("output_token_count");
      if (r.cachedTokens !== undefined) fields.add("cached_token_count");
      if (r.cacheWriteTokens !== undefined) fields.add("cache_write_token_count");
      if (r.reasoningTokens !== undefined) fields.add("reasoning_token_count");
      if (r.totalTokens !== undefined) fields.add("tool_token_count");
      if (r.occurredAt !== undefined) fields.add("event.timestamp");
    }
  }
  return [...fields].sort();
};

export const buildCapabilityMatrix = (
  evidence: CodexTelemetryEvidence,
  facts: CapabilityFacts,
): CapabilityMatrix => {
  const transports = new Set<CodexTransport>();
  for (const c of evidence.conversations) for (const t of c.transports) transports.add(t);
  const fields = new Set([...fieldsOf(evidence), ...(facts.rolloutFields ?? [])]);
  const version =
    evidence.conversations.find((c) => c.appVersion !== undefined)?.appVersion ??
    facts.harnessVersion ??
    "unknown";
  const authMode = authModeOf(evidence);
  const nativeChildren: CapabilityMatrix["nativeChildren"] =
    facts.nativeChildren ?? (evidence.conversations.length > 1 ? "observed" : "not_observed");

  const completions = evidence.conversations.flatMap((c) => c.completions);
  const derived = new Map<string, CapabilityDimension>([
    [
      "transport_sse",
      transports.has("sse")
        ? { name: "transport_sse", status: "observed" }
        : { name: "transport_sse", status: "unverified", note: "no sse event seen" },
    ],
    [
      "transport_websocket",
      transports.has("websocket")
        ? { name: "transport_websocket", status: "observed" }
        : {
            name: "transport_websocket",
            status: "unverified",
            note: "not seen; extend CODEX_VERIFIED_TRANSPORTS only after a live observation",
          },
    ],
    [
      "request_counters",
      completions.length > 0
        ? { name: "request_counters", status: "observed" }
        : { name: "request_counters", status: "unverified", note: "no completed response seen" },
    ],
    [
      "cache_write_counter",
      fields.has("cache_write_token_count")
        ? { name: "cache_write_counter", status: "observed" }
        : { name: "cache_write_counter", status: "not_observed" },
    ],
    [
      "reasoning_counter",
      fields.has("reasoning_token_count")
        ? { name: "reasoning_counter", status: "observed" }
        : { name: "reasoning_counter", status: "not_observed" },
    ],
    [
      "native_children",
      nativeChildren === "observed"
        ? { name: "native_children", status: "observed", note: "a second conversation appeared" }
        : {
            name: "native_children",
            status: "unverified",
            note:
              facts.mode === "offline"
                ? "a scripted provider cannot make Codex spawn a child; only the live probe can"
                : "no child conversation or rollout was observed",
          },
    ],
    [
      "auth_mode",
      authMode === "unobserved"
        ? { name: "auth_mode", status: "unverified" }
        : { name: "auth_mode", status: "observed", note: authMode },
    ],
  ]);
  const given = new Map((facts.dimensions ?? []).map((d) => [d.name, d]));
  const names = [
    ...STANDARD_DIMENSIONS,
    ...[...given.keys(), ...derived.keys()].filter((n) => !STANDARD_DIMENSIONS.includes(n)),
  ];
  const dimensions = names.map(
    (name): CapabilityDimension =>
      given.get(name) ??
      derived.get(name) ?? { name, status: "unverified", note: "not exercised by this probe" },
  );

  return {
    harness: "codex",
    harnessVersion: version,
    producedAt: facts.producedAt,
    mode: facts.mode,
    transports: [...transports].sort(),
    authMode,
    fieldsObserved: [...fields].sort(),
    nativeChildren,
    dimensions,
    ...(facts.notes === undefined ? {} : { notes: [...facts.notes] }),
  };
};

/** Pretty JSON in the repository formatter's style: a short array of scalars stays on one line. */
const formatJson = (value: unknown, indent: string, prefix: string): string => {
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    if (value.every((v) => v === null || typeof v !== "object")) {
      const inline = `[${value.map((v) => JSON.stringify(v)).join(", ")}]`;
      if (indent.length + prefix.length + inline.length + 1 <= 80) return inline;
    }
    const inner = `${indent}  `;
    return `[\n${value.map((v) => `${inner}${formatJson(v, inner, "")}`).join(",\n")}\n${indent}]`;
  }
  if (value !== null && typeof value === "object") {
    const inner = `${indent}  `;
    const entries = Object.entries(value as Record<string, unknown>).map(([k, v]) => {
      const key = `${JSON.stringify(k)}: `;
      return `${inner}${key}${formatJson(v, inner, key)}`;
    });
    return entries.length === 0 ? "{}" : `{\n${entries.join(",\n")}\n${indent}}`;
  }
  return JSON.stringify(value);
};

export const writeCapabilityMatrix = (path: string, matrix: CapabilityMatrix): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${formatJson(matrix, "", "")}\n`);
};

// ---------------------------------------------------------------------------
// A loopback Responses API

export interface ProviderUsage {
  readonly input: number;
  readonly cached: number;
  readonly output: number;
  readonly reasoning: number;
}

export interface ProviderStep {
  /** An assistant message. The default when no `functionCall` is scripted. */
  readonly text?: string;
  /** A function call, which Codex refuses as unsupported yet answers with a second request. */
  readonly functionCall?: { readonly name: string; readonly arguments: string };
  /** Hold the response back, to leave a run mid-turn. */
  readonly delayMs?: number;
  readonly usage?: ProviderUsage;
}

export interface ServedRequest {
  /** 1-based, in arrival order. */
  readonly n: number;
  readonly path: string;
  /** The usage this response reported; absent for a path that is not `/responses`. */
  readonly usage?: ProviderUsage;
  /** Set once the response was written in full. */
  completed: boolean;
}

export interface FakeResponsesProvider {
  readonly port: number;
  /** Every `/responses` request seen, with what was served for it. */
  readonly requests: readonly ServedRequest[];
  /** How many `/responses` requests have been answered in full. */
  served(): number;
  close(): Promise<void>;
}

/** Synthetic usage that follows the arrival number, as the measured research provider did. */
export const syntheticUsage = (n: number): ProviderUsage => ({
  input: 1000 * n + 7,
  cached: 500 * n,
  output: 40 + n,
  reasoning: 10 * n,
});

const sseBody = (events: readonly Record<string, unknown>[]): string =>
  events.map((e) => `event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`).join("");

const responseEvents = (n: number, step: ProviderStep): Record<string, unknown>[] => {
  const u = step.usage ?? syntheticUsage(n);
  const id = `resp_${n}`;
  const usage = {
    input_tokens: u.input,
    input_tokens_details: { cached_tokens: u.cached },
    output_tokens: u.output,
    output_tokens_details: { reasoning_tokens: u.reasoning },
    total_tokens: u.input + u.output,
  };
  const created = { type: "response.created", response: { id, status: "in_progress", output: [] } };
  if (step.functionCall !== undefined) {
    const call = {
      id: `fc_${n}`,
      type: "function_call",
      call_id: `call_${n}`,
      name: step.functionCall.name,
      arguments: step.functionCall.arguments,
      status: "completed",
    };
    return [
      created,
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { ...call, status: "in_progress" },
      },
      { type: "response.output_item.done", output_index: 0, item: call },
      { type: "response.completed", response: { id, status: "completed", output: [call], usage } },
    ];
  }
  const text = step.text ?? `DONE ${n}`;
  const message = {
    id: `msg_${n}`,
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  return [
    created,
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...message, status: "in_progress", content: [] },
    },
    {
      type: "response.output_text.delta",
      output_index: 0,
      content_index: 0,
      item_id: message.id,
      delta: text,
    },
    { type: "response.output_item.done", output_index: 0, item: message },
    { type: "response.completed", response: { id, status: "completed", output: [message], usage } },
  ];
};

/**
 * A Responses-protocol server on `127.0.0.1`. Request `n` is answered with
 * `script[n - 1]`, and with a plain message once the script runs out. It keeps
 * no request body: only the path, the arrival number and what it served.
 */
export const fakeResponsesProvider = async (
  script: readonly ProviderStep[],
): Promise<FakeResponsesProvider> => {
  const requests: ServedRequest[] = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let arrivals = 0;
  const server: Server = createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      const path = req.url ?? "";
      if (!path.split("?")[0]?.endsWith("/responses")) {
        requests.push({ n: 0, path, completed: true });
        res.writeHead(404);
        res.end();
        return;
      }
      arrivals += 1;
      const n = arrivals;
      const step = script[n - 1] ?? {};
      const entry: ServedRequest = {
        n,
        path,
        usage: step.usage ?? syntheticUsage(n),
        completed: false,
      };
      requests.push(entry);
      const send = (): void => {
        timers.delete(timer);
        res.on("error", () => {});
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(sseBody(responseEvents(n, step)), () => {
          entry.completed = true;
        });
      };
      const timer = setTimeout(send, step.delayMs ?? 0);
      timers.add(timer);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    requests,
    served: () => requests.filter((r) => r.n > 0 && r.completed).length,
    close: () =>
      new Promise<void>((resolve) => {
        for (const timer of timers) clearTimeout(timer);
        timers.clear();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
};

// ---------------------------------------------------------------------------
// The launcher

const PROVIDER_ID = "nightshift_probe";
const PROVIDER_KEY_ENV = "NIGHTSHIFT_PROBE_PROVIDER_KEY";

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

/**
 * A `CliLauncher` for the adapter that runs the real `codex` against `provider`.
 * The provider key and the provider overrides live in a small wrapper script in
 * `tmpDir`, so the adapter's sanitized environment and argument list are left
 * exactly as production builds them.
 */
export const codexLauncherFor = (
  provider: { readonly port: number },
  options: { readonly tmpDir: string; readonly codex?: string },
): CliLauncher => {
  const base = `model_providers.${PROVIDER_ID}`;
  const overrides = [
    `model_provider=${PROVIDER_ID}`,
    `${base}.name="probe"`,
    `${base}.base_url="http://127.0.0.1:${provider.port}/v1"`,
    `${base}.env_key="${PROVIDER_KEY_ENV}"`,
    `${base}.wire_api="responses"`,
  ];
  const script = [
    "#!/bin/sh",
    "# Written by the Nightshift measurement probe: the real codex, aimed at a loopback provider.",
    `${PROVIDER_KEY_ENV}=sk-probe-not-a-credential`,
    `export ${PROVIDER_KEY_ENV}`,
    `exec ${shellQuote(options.codex ?? "codex")} "$@" ${overrides
      .map((o) => `-c ${shellQuote(o)}`)
      .join(" ")}`,
    "",
  ].join("\n");
  const file = join(options.tmpDir, `codex-probe-${provider.port}.sh`);
  writeFileSync(file, script);
  chmodSync(file, 0o755);
  return { file, args: [] };
};

// ---------------------------------------------------------------------------
// Sanitizers

const OMITTED = "<text omitted>";
const IDENT = /^[A-Za-z0-9_.:@+-]{1,96}$/;

/** String-valued rollout keys that are identifiers or enumerations, never prose. */
const ROLLOUT_KEEP = new Set([
  "type",
  "id",
  "session_id",
  "thread_id",
  "turn_id",
  "root_turn_id",
  "response_id",
  "call_id",
  "role",
  "model",
  "model_provider",
  "model_provider_id",
  "originator",
  "cli_version",
  "source",
  "thread_source",
  "name",
  "reason",
  "collaboration_mode_kind",
  "parent_thread_id",
  "new_thread_id",
  "child_thread_id",
  "receiver_thread_id",
  "agent_thread_id",
  "spawned_thread_id",
]);

const scrub = (value: unknown, keep: ReadonlySet<string>, key: string | undefined): unknown => {
  if (typeof value === "string") {
    return key !== undefined && keep.has(key) && IDENT.test(value) ? value : OMITTED;
  }
  if (Array.isArray(value)) return value.map((v) => scrub(v, keep, key));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, scrub(v, keep, k)]),
    );
  }
  return value;
};

/**
 * One rollout line with every text field replaced: messages, instructions,
 * tool arguments and outputs, error strings, `world_state`, working directories.
 * Counters, ordinals, identifiers and enumerations survive; the line type and
 * the attribute keys do too, so the metadata reader reads it as it read the
 * original. A line that is not JSON becomes a bare placeholder.
 */
export const sanitizeRolloutLine = (line: string): string => {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return JSON.stringify({ unparseable: OMITTED });
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return JSON.stringify({ unparseable: OMITTED });
  }
  const { timestamp, ordinal, type, payload, ...rest } = value as Record<string, unknown>;
  return JSON.stringify({
    timestamp:
      typeof timestamp === "string" && !Number.isNaN(Date.parse(timestamp)) ? timestamp : OMITTED,
    ordinal,
    type: typeof type === "string" && IDENT.test(type) ? type : OMITTED,
    payload: scrub(payload, ROLLOUT_KEEP, undefined),
    ...(scrub(rest, ROLLOUT_KEEP, undefined) as object),
  });
};

/** Journal attribute strings that are identifiers or enumerations. */
const JOURNAL_KEEP = new Set([
  "event.name",
  "event.kind",
  "event.timestamp",
  "conversation.id",
  "app.version",
  "model",
  "slug",
  "originator",
  "service.name",
  "service.version",
]);
const COUNT_STRING = /^\d{1,15}$/;
const EFFORTS = new Set(["minimal", "low", "medium", "high", "xhigh"]);

const journalValue = (key: string, value: unknown): unknown => {
  if (typeof value !== "string") return value;
  if (COUNT_STRING.test(value)) return value;
  if (key === "model_reasoning_effort") return EFFORTS.has(value) ? value : OMITTED;
  return JOURNAL_KEEP.has(key) && IDENT.test(value) ? value : OMITTED;
};

const journalAttributes = (attributes: unknown): unknown =>
  attributes !== null && typeof attributes === "object" && !Array.isArray(attributes)
    ? Object.fromEntries(
        Object.entries(attributes as Record<string, unknown>).map(([k, v]) => [
          k,
          journalValue(k, v),
        ]),
      )
    : {};

/**
 * One receiver-journal line with every attribute string that is not an
 * identifier, an enumeration or a decimal count replaced. The receiver already
 * allowlists attributes; this is the second lock before a line is committed.
 */
export const sanitizeJournalLine = (line: string): string => {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return JSON.stringify({ unparseable: OMITTED });
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return JSON.stringify({ unparseable: OMITTED });
  }
  const envelope = value as Record<string, unknown>;
  if (!Array.isArray(envelope.records)) return JSON.stringify(envelope);
  return JSON.stringify({
    ...envelope,
    records: envelope.records.map((r) => {
      const record = (r !== null && typeof r === "object" ? r : {}) as Record<string, unknown>;
      return {
        ...record,
        attributes: journalAttributes(record.attributes),
        resourceAttributes: journalAttributes(record.resourceAttributes),
      };
    }),
  });
};
