/**
 * The opt-in, real-invocation capture probe (P20 S-02, J5).
 *
 * `capture.ts` is proven offline against hand-built OTLP bodies; this module is
 * how a machine with a Claude Code sign-in finds out what the installed CLI
 * really emits. It drives the real adapter, with request capture on, through
 * four dimensions (main work, delegated child work, compaction, an interrupted
 * capture) and reduces each ending to a sanitized evidence record.
 *
 * **Nothing here spawns anything by itself.** The gate decides; `probe.test.ts`
 * is skipped by name, with the reason, unless `NIGHTSHIFT_CLAUDE_CAPTURE_PROBE=1`.
 *
 * **Evidence is metadata only.** Versions, attribute names and types, presence
 * booleans, counts, kinds and reasons. Never an identifier value, a prompt, a
 * tool argument or a response. The journal copy kept with
 * `NIGHTSHIFT_CLAUDE_CAPTURE_KEEP` has its identifier values replaced by stable
 * placeholders and its text fields redacted.
 */
import { readFileSync } from "node:fs";
import type { HarnessExit, HarnessObservation, HookEvent } from "@nightshift/harness";
import { millis, recordingHookSink, recordingMeasurementSink } from "@nightshift/harness";
import { type ClaudeCaptureReport, createClaudeHarness } from "./adapter.js";
import type { ClaudeCaptureDiagnostics } from "./capture.js";
import { claudeConformanceFixture } from "./conformance.js";

/** The variable that opts a machine in to the probe. */
export const CLAUDE_CAPTURE_PROBE_ENV = "NIGHTSHIFT_CLAUDE_CAPTURE_PROBE";
/** Where evidence files are written; absent, they are printed. */
export const CLAUDE_CAPTURE_KEEP_ENV = "NIGHTSHIFT_CLAUDE_CAPTURE_KEEP";

export interface ClaudeCaptureProbeGate {
  readonly enabled: boolean;
  /** Why, in prose. Shown on a skipped suite so the skip is never silent. */
  readonly reason: string;
}

/** Whether the real-invocation probe is enabled, and why not when it is not. */
export const claudeCaptureProbeGate = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): ClaudeCaptureProbeGate => {
  const value = env[CLAUDE_CAPTURE_PROBE_ENV];
  if (value === "1") {
    return {
      enabled: true,
      reason: `${CLAUDE_CAPTURE_PROBE_ENV}=1: driving the installed Claude Code CLI`,
    };
  }
  const seen = value === undefined ? "unset" : `set to ${JSON.stringify(value)}`;
  return {
    enabled: false,
    reason:
      `skipped: this probe drives the installed Claude Code CLI, which needs a Claude Code ` +
      `sign-in, a model and network access, none of which CI has. ` +
      `${CLAUDE_CAPTURE_PROBE_ENV} is ${seen}; set ${CLAUDE_CAPTURE_PROBE_ENV}=1 to run it. ` +
      `It is skipped, not passed.`,
  };
};

export type ClaudeProbeDimension = "main" | "child" | "compaction" | "interrupted";

export const CLAUDE_PROBE_DIMENSIONS: readonly ClaudeProbeDimension[] = [
  "main",
  "child",
  "compaction",
  "interrupted",
];

/** What each dimension asks the model to do. */
export const claudeProbeObjective = (dimension: ClaudeProbeDimension): string => {
  switch (dimension) {
    case "main":
      return "Reply with one short sentence about the weather in general. Do not call any tool.";
    case "child":
      return (
        "Use the Agent tool exactly once, with subagent_type Explore, to list the files in " +
        "your current directory. When it returns, reply with one short sentence."
      );
    case "compaction":
      return "Run /compact, and then reply with the single word DONE. Do not call any tool.";
    case "interrupted":
      return (
        "Write a 20000 word essay on the history of the semicolon in programming " +
        "languages. Do not call any tool; write it out in full in your reply."
      );
  }
};

// ---------------------------------------------------------------------------
// Evidence

export interface ClaudeProbeEvidence {
  dimension: ClaudeProbeDimension;
  observedAt: string;
  claudeCodeVersion?: string;
  captureMode: string;
  transport?: ClaudeCaptureDiagnostics["transport"];
  resourceAttributeKeys: string[];
  appVersions: string[];
  eventCounts: Record<string, number>;
  apiRequest?: ClaudeCaptureDiagnostics["apiRequest"];
  requests?: number;
  apiErrors?: number;
  dropped?: { records: number; attributes: number; unidentifiedRequests: number };
  complete?: boolean;
  reasons: string[];
  gap?: string;
  exit: {
    kind: string;
    coverage?: string;
    usageScope?: string;
    inclusion?: string;
    hasUsage: boolean;
    observedModel?: string;
  };
  stream: {
    snapshotCount: number;
    streamRequestCount: number;
    sawCompactBoundary: boolean;
    sawSubagent: boolean;
  };
  unverified?: string;
}

export interface ClaudeProbeEvidenceInput {
  readonly dimension: ClaudeProbeDimension;
  readonly observedAt: string;
  readonly report: ClaudeCaptureReport | undefined;
  readonly hookEvents: readonly HookEvent[];
  readonly exit: HarnessExit;
  readonly observations: readonly HarnessObservation[];
  readonly unverified?: string;
}

const SAFE_TOKEN = /^[A-Za-z0-9._\-+<>[\]:/]{1,64}$/;
const SAFE_NAME = /^[a-z_.]{1,64}$/;
const safe = (value: unknown): string | undefined =>
  typeof value === "string" && SAFE_TOKEN.test(value) ? value : undefined;

/** Reduces one dimension's ending to evidence: no identifier values, no text. */
export const buildClaudeProbeEvidence = (input: ClaudeProbeEvidenceInput): ClaudeProbeEvidence => {
  const started = input.hookEvents.find((event) => event.type === "agent.started");
  const version = safe(started?.payload.harnessVersion);
  const result = input.report?.result;
  const diagnostics = result?.diagnostics;
  const eventCounts: Record<string, number> = {};
  for (const [name, count] of Object.entries(diagnostics?.eventCounts ?? {})) {
    if (SAFE_NAME.test(name) && Number.isFinite(count)) eventCounts[name] = count;
  }
  const model = safe(input.exit.observedModel);
  const evidence: ClaudeProbeEvidence = {
    dimension: input.dimension,
    observedAt: input.observedAt,
    ...(version === undefined ? {} : { claudeCodeVersion: version }),
    captureMode: input.report?.mode ?? "none",
    ...(diagnostics === undefined ? {} : { transport: diagnostics.transport }),
    resourceAttributeKeys: (diagnostics?.resourceAttributeKeys ?? []).filter((k) =>
      /^[A-Za-z0-9_.-]{1,64}$/.test(k),
    ),
    appVersions: (diagnostics?.appVersions ?? []).filter((v) => safe(v) !== undefined),
    eventCounts,
    ...(diagnostics === undefined ? {} : { apiRequest: diagnostics.apiRequest }),
    ...(result === undefined
      ? {}
      : {
          requests: result.requests,
          apiErrors: result.apiErrors,
          dropped: {
            records: result.droppedRecords,
            attributes: result.droppedAttributes,
            unidentifiedRequests: result.unidentifiedRequests,
          },
          complete: result.complete,
        }),
    reasons: [...(result?.reasons ?? [])],
    ...(result?.gap === undefined ? {} : { gap: result.gap }),
    exit: {
      kind: input.exit.kind,
      ...(input.exit.coverage === undefined ? {} : { coverage: input.exit.coverage }),
      ...(input.exit.usageScope === undefined ? {} : { usageScope: input.exit.usageScope }),
      ...(input.exit.inclusion === undefined ? {} : { inclusion: input.exit.inclusion }),
      hasUsage: input.exit.usage !== undefined,
      ...(model === undefined ? {} : { observedModel: model }),
    },
    stream: {
      snapshotCount: input.observations.filter((o) => o.kind === "cumulative_snapshot").length,
      streamRequestCount: input.observations.filter(
        (o) => o.kind === "request" && o.observationId.startsWith("claude:assistant:"),
      ).length,
      sawCompactBoundary: input.hookEvents.some((e) => e.type === "agent.context_compacted"),
      sawSubagent: input.hookEvents.some((e) => e.type === "agent.subagent_created"),
    },
    ...(input.unverified === undefined ? {} : { unverified: input.unverified }),
  };
  return evidence;
};

// ---------------------------------------------------------------------------
// Journal sanitizer

/** Keys whose values identify a session, request, prompt or user. */
export const PROBE_IDENTIFIER_KEYS: readonly string[] = [
  "session.id",
  "request_id",
  "client_request_id",
  "prompt.id",
  "user.id",
];

/** Keys that can carry free text; redacted so a kept journal holds none. */
export const PROBE_TEXT_KEYS: readonly string[] = [
  "error",
  "prompt",
  "response",
  "message",
  "tool_input",
  "tool_result",
];

/**
 * Replaces identifier values with stable placeholders (the same value maps to
 * the same placeholder, so duplicates stay duplicates) and redacts text fields.
 * A line that is not JSON (a torn tail) is dropped and counted.
 */
export const sanitizeClaudeProbeJournal = (
  journal: string,
): { readonly text: string; readonly droppedLines: number } => {
  const placeholders = new Map<string, string>();
  const placeholderFor = (key: string, value: unknown): string => {
    const mapKey = `${key}\u0000${String(value)}`;
    let placeholder = placeholders.get(mapKey);
    if (placeholder === undefined) {
      const ordinal = [...placeholders.keys()].filter((k) => k.startsWith(`${key}\u0000`)).length;
      placeholder = `<${key}#${ordinal + 1}>`;
      placeholders.set(mapKey, placeholder);
    }
    return placeholder;
  };
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (typeof value !== "object" || value === null) return value;
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      if (PROBE_IDENTIFIER_KEYS.includes(key) && inner !== null && typeof inner !== "object") {
        out[key] = placeholderFor(key, inner);
      } else if (PROBE_TEXT_KEYS.includes(key) && inner !== null && typeof inner !== "object") {
        out[key] = "<redacted>";
      } else {
        out[key] = walk(inner);
      }
    }
    return out;
  };
  const lines: string[] = [];
  let droppedLines = 0;
  for (const line of journal.split("\n")) {
    if (line.trim() === "") continue;
    try {
      lines.push(JSON.stringify(walk(JSON.parse(line))));
    } catch {
      droppedLines += 1;
    }
  }
  return { text: lines.length === 0 ? "" : `${lines.join("\n")}\n`, droppedLines };
};

// ---------------------------------------------------------------------------
// Running

export interface ClaudeProbeRunOptions {
  /** An existing directory the worker may use as its worktree. */
  readonly worktree: string;
  /** Model alias; `sonnet` by default. */
  readonly model?: string;
  /** Bound on the whole dimension. */
  readonly timeoutMs?: number;
  /** Interrupted dimension: how long after the first assistant frame to cancel. */
  readonly cancelAfterMs?: number;
  readonly now?: () => Date;
}

export interface ClaudeProbeRun {
  readonly evidence: ClaudeProbeEvidence;
  /** The sanitized reduced journal, when `onCapture` could read one. */
  readonly journal?: string;
  /** Every observation the adapter reported, for the caller to validate once stamped. */
  readonly observations: readonly HarnessObservation[];
  /** Adapter faults: any entry means the case must fail. */
  readonly faults: readonly string[];
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Why a live capability could not be verified, or undefined when the provider answered. */
export const claudeProbeUnverifiedReason = (input: {
  readonly exit: HarnessExit;
  readonly hookEvents: readonly HookEvent[];
  readonly report: ClaudeCaptureReport | undefined;
}): string | undefined => {
  const { exit, hookEvents, report } = input;
  if (exit.kind === "failed" && exit.unavailable !== undefined) {
    return `live capability unverified: ${exit.unavailable.slice(0, 200)}`;
  }
  const failed = hookEvents.find((e) => e.type === "agent.failed");
  const failure = JSON.stringify(failed?.payload ?? {}).toLowerCase();
  if (failure.includes("api_error") || failure.includes("auth")) {
    return "live capability unverified: the provider refused the request (api_error / authentication)";
  }
  const result = report?.result;
  if (result !== undefined && result.requests === 0 && exit.kind === "failed") {
    return "live capability unverified: the session errored before any api_request was exported";
  }
  return undefined;
};

/** Drives the real adapter through one dimension and reduces it to evidence. */
export const runClaudeProbeDimension = async (
  dimension: ClaudeProbeDimension,
  options: ClaudeProbeRunOptions,
): Promise<ClaudeProbeRun> => {
  const now = options.now ?? (() => new Date());
  const timeoutMs = options.timeoutMs ?? 240_000;
  let report: ClaudeCaptureReport | undefined;
  let journalRaw: string | undefined;
  const harness = createClaudeHarness({
    requestCapture: { enabled: true },
    onCapture: (r) => {
      report = r;
      if (r.journalPath !== undefined) {
        try {
          journalRaw = readFileSync(r.journalPath, "utf8");
        } catch {
          journalRaw = undefined;
        }
      }
    },
  });
  const fixture = claudeConformanceFixture({
    worktree: options.worktree,
    model: { harness: "claude", provider: "anthropic", model: options.model ?? "sonnet" },
    completingObjective: claudeProbeObjective(dimension),
  });
  const measurements = recordingMeasurementSink();
  const sink = recordingHookSink();
  const faults: string[] = [];

  const handle = await harness.start({ ...fixture.completing(), sink, measurements });

  const deadline = Date.now() + timeoutMs;
  const settled = (async () => {
    if (dimension === "interrupted") {
      while (Date.now() < deadline - 20_000) {
        if (measurements.observations.some((o) => o.kind === "request")) break;
        if (sink.events.some((e) => e.type === "agent.completed" || e.type === "agent.failed")) {
          break;
        }
        await sleep(250);
      }
      await sleep(options.cancelAfterMs ?? 3_000);
      await harness.cancel(handle, millis(5_000));
    }
    return handle.exit;
  })();
  const timeout = new Promise<undefined>((resolve) =>
    setTimeout(() => resolve(undefined), timeoutMs),
  );
  const exit = await Promise.race([settled, timeout]);
  if (exit === undefined) {
    await harness.cancel(handle, millis(5_000)).catch(() => {});
    faults.push("the exit never settled within the bound");
  }
  const finalExit: HarnessExit = exit ?? { kind: "failed", exitCode: -1 };
  if (report === undefined) faults.push("onCapture was not called");

  const hookEvents = sink.events;
  const unverified = claudeProbeUnverifiedReason({ exit: finalExit, hookEvents, report });
  const evidence = buildClaudeProbeEvidence({
    dimension,
    observedAt: now().toISOString(),
    report,
    hookEvents,
    exit: finalExit,
    observations: measurements.observations,
    ...(unverified === undefined ? {} : { unverified }),
  });

  const serialized = JSON.stringify(evidence);
  for (const secret of [options.worktree, handle.agentId, claudeProbeObjective(dimension)]) {
    if (secret.length > 0 && serialized.includes(secret)) {
      faults.push("evidence contains text or an identifier it must not");
    }
  }

  return {
    evidence,
    observations: measurements.observations,
    ...(journalRaw === undefined ? {} : { journal: sanitizeClaudeProbeJournal(journalRaw).text }),
    faults,
  };
};
