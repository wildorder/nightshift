/**
 * Pure reconciliation of Codex measurement sources, and the coverage rule (P20 S-03).
 *
 * Sources, strongest first: the rollout (request ids, ordinals, the thread
 * total), the OTLP telemetry (completions, no request id), and the stream's
 * thread-cumulative usage (carried on the exit, not here). Per conversation
 * the rollout's requests after the launch boundary are THE requests; OTLP
 * completions only corroborate them, by position and count. Only a
 * conversation with no readable rollout is decided by `telemetryObservations`.
 * No I/O: the adapter reads, this decides.
 */
import type { HarnessObservation } from "@nightshift/harness";
import {
  type LaunchBoundary,
  type RolloutFacts,
  type RolloutRecord,
  rolloutObservations,
} from "./rollout.js";
import {
  CODEX_VERIFIED_NATIVE_CHILDREN,
  CODEX_VERIFIED_TRANSPORTS,
  type CodexConversationEvidence,
  type CodexTelemetryEvidence,
  type CodexTransport,
  telemetryObservations,
} from "./telemetry.js";

const MAX_GAPS = 12;
const MAX_CHILDREN = 16;
const shortId = (id: string): string => id.slice(0, 8);

// ---------------------------------------------------------------------------
// The coverage rule

export interface CoverageInput {
  /** Which sources reported anything at all. */
  readonly sources: {
    readonly stream: boolean;
    readonly otlp: boolean;
    readonly rollout: boolean;
  };
  /** The launch ended with a clean `completed`. */
  readonly turnCompletedCleanly: boolean;
  /** How the parent rollout was bounded; undefined when it was not read. */
  readonly parentBoundary: LaunchBoundary["kind"] | undefined;
  readonly receiver: {
    readonly started: boolean;
    readonly stopGap: boolean;
    /** The journal was read and carries a loss gap (or never closed). */
    readonly journalLoss: boolean;
    readonly journalRead: boolean;
  };
  /** Every transport observed in the telemetry. */
  readonly transports: readonly CodexTransport[];
  /** Rollout and OTLP agree on every count, for every conversation. */
  readonly countsAgree: boolean;
  /** Some conversation's requests came from telemetry alone. */
  readonly telemetryOnly: boolean;
  /** The parent rollout's spawn evidence; undefined when it was not read. */
  readonly spawned: boolean | undefined;
  /** The telemetry shows a conversation other than the parent. */
  readonly otherConversations: boolean;
  readonly verifiedTransports?: readonly CodexTransport[];
  readonly nativeChildrenVerified?: boolean;
}

export interface CoverageVerdict {
  readonly coverage: "complete" | "partial" | "unknown";
  /** One short string per failed condition; empty when complete. */
  readonly gaps: readonly string[];
}

export const codexCoverage = (input: CoverageInput): CoverageVerdict => {
  const { sources, receiver } = input;
  if (!sources.stream && !sources.otlp && !sources.rollout) {
    return { coverage: "unknown", gaps: ["no measurement source reported"] };
  }
  const verified = input.verifiedTransports ?? CODEX_VERIFIED_TRANSPORTS;
  const gaps: string[] = [];
  if (!input.turnCompletedCleanly) gaps.push("turn did not complete cleanly");
  if (input.parentBoundary === undefined) gaps.push("rollout unread");
  else if (input.parentBoundary === "time") gaps.push("launch boundary by time");
  if (!receiver.started) gaps.push("receiver unavailable");
  else {
    if (receiver.stopGap) gaps.push("receiver stopped with a gap");
    if (!receiver.journalRead) gaps.push("telemetry absent");
    else if (receiver.journalLoss) gaps.push("telemetry journal loss");
  }
  for (const transport of input.transports) {
    if (!verified.includes(transport)) gaps.push(`transport ${transport} unverified`);
  }
  if (input.telemetryOnly) gaps.push("telemetry only: replay cannot be excluded");
  if (!input.countsAgree) gaps.push("rollout and telemetry counts do not agree");
  const children = input.spawned !== false || input.otherConversations;
  if (children && !(input.nativeChildrenVerified ?? CODEX_VERIFIED_NATIVE_CHILDREN)) {
    gaps.push("native children spawned; capture unverified");
  }
  return { coverage: gaps.length === 0 ? "complete" : "partial", gaps };
};

// ---------------------------------------------------------------------------
// Reconciliation

export interface CaptureInput {
  /** The launch's thread id: given for a resume, else from `thread.started`. */
  readonly threadId: string | undefined;
  readonly boundary: LaunchBoundary;
  /** The parent rollout's records; undefined when it could not be read. */
  readonly parent: readonly RolloutRecord[] | undefined;
  /** Rollouts of other conversations, by thread id, read in full. */
  readonly children: ReadonlyMap<string, readonly RolloutRecord[]>;
  /** The decoded journal; undefined when there is none. */
  readonly telemetry: CodexTelemetryEvidence | undefined;
  readonly verifiedTransports?: readonly CodexTransport[];
}

export interface CaptureResult {
  readonly observations: HarnessObservation[];
  readonly requestCount: number;
  readonly excludedBeforeBoundary: number;
  readonly excludedTelemetry: number;
  readonly childConversations: number;
  readonly transports: readonly CodexTransport[];
  readonly gaps: readonly string[];
  readonly model?: string;
  readonly facts: {
    readonly countsAgree: boolean;
    readonly telemetryOnly: boolean;
    readonly spawned: boolean | undefined;
    readonly otherConversations: boolean;
    readonly rolloutRead: boolean;
    readonly otlpSeen: boolean;
  };
}

/** The parent's thread id: the given one, else the telemetry's only conversation. */
export const parentThreadId = (
  threadId: string | undefined,
  telemetry: CodexTelemetryEvidence | undefined,
): string | undefined =>
  threadId ??
  (telemetry?.conversations.length === 1 ? telemetry.conversations[0]?.conversationId : undefined);

/** Every other thread to look for: telemetry's other conversations and the rollout's spawn evidence. */
export const childThreadIds = (input: {
  readonly threadId: string | undefined;
  readonly boundary: LaunchBoundary;
  readonly parent: readonly RolloutRecord[] | undefined;
  readonly telemetry: CodexTelemetryEvidence | undefined;
}): string[] => {
  const parentId = parentThreadId(input.threadId, input.telemetry);
  const ids = new Set<string>();
  for (const c of input.telemetry?.conversations ?? []) {
    if (c.conversationId !== parentId) ids.add(c.conversationId);
  }
  if (input.parent !== undefined && parentId !== undefined) {
    const { facts } = rolloutObservations(input.parent, {
      threadId: parentId,
      launchBoundary: input.boundary,
    });
    for (const id of facts.spawnEvidence.childThreadIds) ids.add(id);
  }
  return [...ids].slice(0, MAX_CHILDREN);
};

const COUNTER_PAIRS = [
  ["inputTokens", "inputTokens"],
  ["outputTokens", "outputTokens"],
  ["cacheReadTokens", "cacheReadTokens"],
  ["cacheWriteTokens", "cacheWriteTokens"],
  ["reasoningTokens", "reasoningTokens"],
] as const;

type Request = HarnessObservation & { kind: "request" };
const isRequest = (o: HarnessObservation): o is Request => o.kind === "request";

/** Position-matches a conversation's OTLP completions to its rollout requests; the disagreements, named. */
const disagreements = (
  id: string,
  requests: readonly Request[],
  evidence: CodexConversationEvidence | undefined,
  telemetryPresent: boolean,
): string[] => {
  if (!telemetryPresent) return [];
  const completions = evidence?.completions ?? [];
  if (completions.length !== requests.length) {
    return [
      `discrepancy ${shortId(id)}: rollout ${requests.length} requests, otlp ${completions.length} completions`,
    ];
  }
  const out: string[] = [];
  requests.forEach((request, index) => {
    const completion = completions[index];
    if (completion === undefined) return;
    const otlp = {
      inputTokens: completion.inputTokens,
      outputTokens: completion.outputTokens,
      cacheReadTokens: completion.cachedTokens,
      cacheWriteTokens: completion.cacheWriteTokens,
      reasoningTokens: completion.reasoningTokens,
    };
    for (const [key, otlpKey] of COUNTER_PAIRS) {
      const a = request.counters[key];
      const b = otlp[otlpKey];
      if (a !== undefined && b !== undefined && a !== b) {
        out.push(`discrepancy ${shortId(id)}: request ${index} ${key} rollout ${a}, otlp ${b}`);
      }
    }
  });
  return out;
};

export const reconcileCapture = (input: CaptureInput): CaptureResult => {
  const { telemetry } = input;
  const parentId = parentThreadId(input.threadId, telemetry);
  const observations: HarnessObservation[] = [];
  const gaps: string[] = [];
  const byConversation = new Map<string, CodexConversationEvidence>(
    (telemetry?.conversations ?? []).map((c) => [c.conversationId, c]),
  );
  const lacking = new Set<string>();
  let countsAgree = telemetry !== undefined;
  let excludedBeforeBoundary = 0;
  let spawned: boolean | undefined;
  let requestCount = 0;
  let model: string | undefined;
  let facts: RolloutFacts | undefined;

  const take = (
    id: string,
    requests: readonly Request[],
    evidence: CodexConversationEvidence | undefined,
  ): void => {
    const problems = disagreements(id, requests, evidence, telemetry !== undefined);
    if (problems.length > 0) countsAgree = false;
    gaps.push(...problems);
    observations.push(...requests);
    requestCount += requests.length;
  };

  if (parentId !== undefined && input.parent !== undefined) {
    const parent = rolloutObservations(input.parent, {
      threadId: parentId,
      launchBoundary: input.boundary,
    });
    facts = parent.facts;
    excludedBeforeBoundary = parent.facts.excludedBeforeBoundary;
    spawned = parent.facts.spawnEvidence.spawned;
    const requests = parent.observations.filter(isRequest);
    take(parentId, requests, byConversation.get(parentId));
    observations.push(...parent.observations.filter((o) => o.kind === "cumulative_snapshot"));
    model = requests
      .map((r) => r.model)
      .filter((m) => m !== undefined)
      .at(-1);
  } else if (parentId !== undefined) {
    lacking.add(parentId);
  }

  const others = new Set<string>(
    [
      ...byConversation.keys(),
      ...input.children.keys(),
      ...(facts?.spawnEvidence.childThreadIds ?? []),
    ].filter((id) => id !== parentId),
  );
  for (const id of others) {
    const records = input.children.get(id);
    if (records === undefined) {
      lacking.add(id);
      continue;
    }
    const child = rolloutObservations(records, {
      threadId: id,
      launchBoundary: { kind: "ordinal", fromOrdinal: 0 },
      childOf: id,
    });
    take(id, child.observations.filter(isRequest), byConversation.get(id));
  }

  // A conversation with no readable rollout: telemetry decides, under its replay policy.
  let excludedTelemetry = 0;
  let telemetryOnly = false;
  if (telemetry !== undefined) {
    const rest = telemetry.conversations.filter((c) => lacking.has(c.conversationId));
    const decided = telemetryObservations(
      { ...telemetry, conversations: rest },
      {
        threadId: parentId ?? "",
        ...(input.verifiedTransports === undefined
          ? {}
          : { verifiedTransports: input.verifiedTransports }),
      },
    );
    for (const o of decided.observations) {
      observations.push(o);
      requestCount += 1;
      if (isRequest(o) && o.model !== undefined) model ??= o.model;
    }
    for (const x of decided.excluded) {
      excludedTelemetry += x.count;
      gaps.push(
        `${x.count} completions excluded in ${shortId(x.conversation)} (${x.reason === "retried" ? "retry; replay cannot be excluded" : "transport unverified"})`,
      );
    }
    telemetryOnly = rest.some((c) => c.completions.length > 0);
    if (telemetryOnly) gaps.push("telemetry only: replay cannot be excluded");
    for (const c of rest) model ??= c.model;
    // Telemetry alone has nothing to agree with.
    if (telemetryOnly) countsAgree = false;
  }
  // A thread named by the rollout whose rollout could not be read.
  for (const id of lacking) {
    if (telemetry === undefined || !byConversation.has(id))
      gaps.push(`rollout unread ${shortId(id)}`);
  }
  if (telemetry === undefined) gaps.push("telemetry absent");

  const transports = [
    ...new Set((telemetry?.conversations ?? []).flatMap((c) => c.transports)),
  ] as CodexTransport[];
  const model_ =
    model ?? (parentId === undefined ? undefined : byConversation.get(parentId)?.model);
  return {
    observations,
    requestCount,
    excludedBeforeBoundary,
    excludedTelemetry,
    childConversations: others.size,
    transports,
    gaps: [...new Set(gaps)],
    ...(model_ === undefined ? {} : { model: model_ }),
    facts: {
      countsAgree,
      telemetryOnly,
      spawned,
      otherConversations: others.size > 0,
      rolloutRead: facts !== undefined,
      otlpSeen: (telemetry?.conversations ?? []).some((c) => c.completions.length > 0),
    },
  };
};

/** Bounded for the ending hook payload. */
export const boundedGaps = (gaps: readonly string[]): string[] => {
  const kept = gaps.slice(0, MAX_GAPS).map((g) => (g.length > 160 ? `${g.slice(0, 159)}…` : g));
  return gaps.length > MAX_GAPS ? [...kept, `…and ${gaps.length - MAX_GAPS} more`] : kept;
};
