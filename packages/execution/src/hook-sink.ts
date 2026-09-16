/**
 * `HookSink` over the outbox (D-P3-09, A-30).
 *
 * This is the join between the two halves of the observability model. An adapter
 * watches a harness process and calls `emit` with an `EventType`; this turns it
 * into an `Event` with `source: "hook"` and hands it to the outbox, which
 * delivers it in order with retry.
 *
 * Three properties matter, and all three are why the adapter does not write to
 * the control plane itself:
 *
 * - **`emit` cannot block.** An adapter parsing a JSON stream that awaited a
 *   network write would stall its own parsing and lose events during an outage.
 * - **`emit` cannot throw.** A stream parser is not a place to handle a 503.
 * - **The source cannot be forged.** An adapter cannot label its observation
 *   `mcp`, and a worker's tool call cannot label itself `hook`, because neither
 *   holds the writer that sets the field. That is what makes "the worker never
 *   reported" a detectable gap rather than an indistinguishable silence.
 */

import type { AgentId, EventType, ExecutionNodeId } from "@nightshift/contracts";
import type { HookSink } from "@nightshift/harness";
import { isHookEventType } from "@nightshift/harness";
import type { EventOutbox } from "./outbox.js";

/**
 * The four ways an agent can end.
 *
 * Named here because the sink has to recognise one: see
 * {@link RecordingHookSink.sawEnding}.
 */
const ENDINGS: ReadonlySet<EventType> = new Set<EventType>([
  "agent.completed",
  "agent.failed",
  "agent.cancelled",
  "agent.interrupted",
]);

export interface HookSinkOptions {
  readonly outbox: EventOutbox;
  readonly executionNodeId: ExecutionNodeId;
  readonly agentId: AgentId;
  /**
   * Told about an event an adapter emitted that is not in the hook-sourced set.
   * Dropped rather than stored: the `EventType` union is closed, and an adapter
   * emitting `node.integrated` would be claiming an authority it does not have.
   */
  readonly onUnexpected?: (type: string) => void;
}

export interface RecordingHookSink extends HookSink {
  /**
   * Whether an adapter has already emitted one of {@link ENDINGS}.
   *
   * The runner emits an ending of its own after awaiting `handle.exit`, because
   * D-P3-09 requires terminal state from **observing a process** rather than
   * from an adapter's cooperation — a harness that emits nothing at all must
   * still leave `agent.failed` behind. A well-behaved adapter emits one too,
   * from the same `hookTypeForExit` mapping and with far more in its payload,
   * and the exit gate (T10) found the consequence: the first integrated run
   * carried two `agent.completed` events, sequences 30 and 31, the second one
   * empty.
   *
   * So the runner asks. This is the only way it can tell the difference between
   * an adapter that reported and one that did not, and the answer decides
   * whether its own emit is a backstop or a duplicate.
   */
  readonly sawEnding: () => boolean;
}

export const createHookSink = (options: HookSinkOptions): RecordingHookSink => {
  let sawEnding = false;
  return {
    sawEnding: () => sawEnding,
    emit: (event) => {
      if (!isHookEventType(event.type)) {
        options.onUnexpected?.(event.type);
        return;
      }
      if (ENDINGS.has(event.type)) sawEnding = true;
      options.outbox.emit({
        type: event.type,
        source: "hook",
        payload: event.payload,
        executionNodeId: options.executionNodeId,
        agentId: options.agentId,
        occurredAt: event.occurredAt,
      });
    },
  };
};
