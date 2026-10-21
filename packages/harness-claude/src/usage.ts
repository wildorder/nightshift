/**
 * Pure decoding of Claude Code's usage figures into measurement counters.
 *
 * Metadata only: this module reads numbers and model names and nothing else.
 * What the figures mean on the pinned 2.1.286:
 *
 * - A `result` frame's `usage` covers that turn's main loop only (sub-agents
 *   excluded). It is deliberately not read here.
 * - `modelUsage` and `total_cost_usd` are whole-tree running totals for the
 *   session, and since 2.1.277 a `--resume` restores the earlier session's
 *   totals into them, so they are session-cumulative.
 * - An assistant message repeats one `message.id` for parallel tool calls, and
 *   its `usage.output_tokens` is a placeholder from `message_start`.
 * - `input_tokens` excludes cache tokens.
 * - Dollar figures are Claude Code's client-side estimates, never billed spend.
 */
import type { MeasurementCounters, RouteUsage } from "@nightshift/contracts";

type Json = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;

const field = <K extends string>(key: K, value: number | undefined): { [P in K]?: number } =>
  (value === undefined ? {} : { [key]: value }) as { [P in K]?: number };

export const CLAUDE_ADAPTER = "claude";

const RESULT_NOTE =
  "modelUsage is the whole tree and session-cumulative on resume since 2.1.277; total_cost_usd is Claude Code's client-side estimate, not billed spend";
const REQUEST_NOTE =
  "output_tokens on an assistant message is a streaming placeholder and is not reported; input_tokens excludes cache tokens";

/** Provenance for an observation decoded from a `result` frame. */
export const resultProvenance = (version: string | undefined) => ({
  adapter: CLAUDE_ADAPTER,
  ...(version === undefined ? {} : { version }),
  note: RESULT_NOTE,
});

/** Provenance for an observation decoded from an assistant message. */
export const requestProvenance = (version: string | undefined) => ({
  adapter: CLAUDE_ADAPTER,
  ...(version === undefined ? {} : { version }),
  note: REQUEST_NOTE,
});

/** A `result` frame's `modelUsage`, summed over models. */
export interface ModelUsageTotals {
  readonly counters: MeasurementCounters;
  /** `contextWindow` per model, where the frame gave one. */
  readonly contextWindows: ReadonlyMap<string, number>;
}

/**
 * Sum `modelUsage` over its models. Returns undefined when it is absent, empty
 * or reports nothing but zeros (the shape of a crashed run's result), because
 * such a frame is not evidence of any usage.
 */
export const sumModelUsage = (
  modelUsage: unknown,
  totalCostUsd: unknown,
): ModelUsageTotals | undefined => {
  if (!isRecord(modelUsage)) return undefined;
  const sum = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, thinking: 0 };
  let thinkingSeen = false;
  let models = 0;
  const contextWindows = new Map<string, number>();
  for (const [model, entry] of Object.entries(modelUsage)) {
    if (!isRecord(entry)) continue;
    models += 1;
    sum.input += count(entry.inputTokens) ?? 0;
    sum.cacheRead += count(entry.cacheReadInputTokens) ?? 0;
    sum.cacheWrite += count(entry.cacheCreationInputTokens) ?? 0;
    sum.output += count(entry.outputTokens) ?? 0;
    const thinking = count(entry.thinkingTokens);
    if (thinking !== undefined) {
      thinkingSeen = true;
      sum.thinking += thinking;
    }
    const window = count(entry.contextWindow);
    if (window !== undefined && window > 0) contextWindows.set(model, window);
  }
  if (models === 0) return undefined;
  if (sum.input + sum.cacheRead + sum.cacheWrite + sum.output + sum.thinking === 0) {
    return undefined;
  }
  const cost =
    typeof totalCostUsd === "number" && Number.isFinite(totalCostUsd) && totalCostUsd >= 0
      ? totalCostUsd
      : undefined;
  const counters: MeasurementCounters = {
    inputTokens: sum.input,
    cacheReadTokens: sum.cacheRead,
    cacheWriteTokens: sum.cacheWrite,
    outputTokens: sum.output,
    ...(thinkingSeen ? { reasoningTokens: sum.thinking } : {}),
    inputIncludesCache: false,
    ...(cost === undefined ? {} : { reportedUsd: cost }),
  };
  return { counters, contextWindows };
};

/** The route usage form of session counters, with the turn latency the stream already tracks. */
export const countersToRouteUsage = (
  counters: MeasurementCounters,
  latencyMs: number | undefined,
): RouteUsage => ({
  ...field("inputTokens", counters.inputTokens),
  ...field("outputTokens", counters.outputTokens),
  ...field("cacheReadTokens", counters.cacheReadTokens),
  ...field("cacheWriteTokens", counters.cacheWriteTokens),
  inputIncludesCache: false,
  ...field("actualCostUsd", counters.reportedUsd),
  ...field("latencyMs", latencyMs),
});

/**
 * One assistant message's request counters. `output_tokens` is never read.
 * Undefined when the message has no usage object or reports no counter.
 */
export const requestCounters = (usage: unknown): MeasurementCounters | undefined => {
  if (!isRecord(usage)) return undefined;
  const input = count(usage.input_tokens);
  const read = count(usage.cache_read_input_tokens);
  const write = count(usage.cache_creation_input_tokens);
  if (input === undefined && read === undefined && write === undefined) return undefined;
  return {
    ...field("inputTokens", input),
    ...field("cacheReadTokens", read),
    ...field("cacheWriteTokens", write),
    inputIncludesCache: false,
  };
};

/** The most frequent key of a tally; ties go to the first seen. */
export const mostFrequent = (tally: ReadonlyMap<string, number>): string | undefined => {
  let best: string | undefined;
  let bestCount = 0;
  for (const [key, n] of tally) {
    if (n > bestCount) {
      best = key;
      bestCount = n;
    }
  }
  return best;
};
