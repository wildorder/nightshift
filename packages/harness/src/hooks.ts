/**
 * The hook channel: how an adapter reports ground truth (D-P3-09, A-30).
 *
 * Nightshift observes a worker through two channels, and the difference between
 * them is the whole point of this module.
 *
 * - **MCP** carries *intent*. A worker calls `job.progress` because it decided
 *   to. If it never calls anything, nothing is reported.
 * - **Hooks** carry *ground truth*. The adapter produces these by watching the
 *   harness process — its output stream, its configured hooks, its exit — and
 *   **must produce them without any cooperation from the worker**. A worker that
 *   edits a file and exits without saying a word still yields `agent.started`
 *   and `agent.failed`.
 *
 * An adapter that can only emit these when the worker plays along is not
 * conformant, and `describeHarnessConformance` (in `@nightshift/test`) is where
 * that is checked.
 *
 * Hook events carry `EventType` values from `@nightshift/contracts`, never a
 * harness's own event names. Translating "assistant message with tool_use" into
 * `tool.called` is the adapter's job; nothing above the adapter layer should
 * ever learn what a provider calls its events.
 */
import type { EventType, IsoTimestamp } from "@nightshift/contracts";

/**
 * The hook-sourced subset of `EventType` for P3 (contract §4.7), plus
 * `agent.interrupted` for the killed-worker path in §4.3.
 *
 * Exported as a value because an adapter's tests enumerate it, and because the
 * execution layer refuses an event outside the set rather than trusting the type
 * checker to have been run.
 */
export const HOOK_EVENT_TYPES = [
  "agent.started",
  "agent.completed",
  "agent.failed",
  "agent.cancelled",
  "agent.interrupted",
  "agent.subagent_created",
  "agent.context_compacted",
  "tool.called",
  "tool.completed",
] as const;

export type HookEventType = (typeof HOOK_EVENT_TYPES)[number];

/**
 * Compile-time proof that every hook event type is a real `EventType`. A typo in
 * the list above fails the build here rather than at the first append.
 */
const _hookTypesAreEventTypes: readonly EventType[] = HOOK_EVENT_TYPES;
void _hookTypesAreEventTypes;

/** Whether `value` is a type an adapter is allowed to emit through a `HookSink`. */
export const isHookEventType = (value: string): value is HookEventType =>
  (HOOK_EVENT_TYPES as readonly string[]).includes(value);

/**
 * One observation about the harness process.
 *
 * `payload` is small structured metadata — a tool name, an exit code, a bounded
 * summary. Anything large belongs in an artifact; the execution layer enforces
 * the inline bound when it turns this into an `Event`, so an adapter that
 * over-shares gets a loud failure rather than a silently truncated record.
 */
export interface HookEvent {
  readonly type: HookEventType;
  readonly occurredAt: IsoTimestamp;
  readonly payload: Readonly<Record<string, unknown>>;
}

/**
 * Where an adapter's observations go.
 *
 * **Ordered and non-blocking.** `emit` returns immediately and never throws:
 * delivery, retry and durability are the execution layer's outbox (T5), because
 * an adapter that awaited a network write would stall its own stream parsing and
 * lose events during an outage. Order is preserved per sink.
 */
export interface HookSink {
  emit(event: HookEvent): void;
}

/** A sink that drops everything. For a unit test that is not asserting on events. */
export const nullHookSink: HookSink = { emit: () => {} };

/** A sink that records what it was given, in order. For adapter tests. */
export const recordingHookSink = (): HookSink & { readonly events: readonly HookEvent[] } => {
  const events: HookEvent[] = [];
  return { events, emit: (event) => void events.push(event) };
};
