/**
 * Lifecycle vocabulary (P20): the well-known phase, blocker, reference and
 * start-reason names carried by `LifecycleObservation`, and the pure readers
 * that recover observations from `lifecycle.observed` events.
 *
 * The observation fields stay free strings so a later phase is not a breaking
 * change; these tuples say what the engine emits today.
 */
import type { Event } from "./event.js";
import { type LifecycleObservation, MeasurementObservationSchema } from "./measurement.js";

export const LIFECYCLE_PHASES = [
  "provisioning",
  "startup",
  "setup",
  "wait",
  "work",
  "examination",
  "answer",
  "arbitration",
  "plan_review",
  "queue",
  "integration",
] as const;
export type LifecyclePhase = (typeof LIFECYCLE_PHASES)[number];

/** What a wait can be waiting on (`blockers[].kind`). */
export const LIFECYCLE_BLOCKER_KINDS = [
  "job",
  "strand",
  "parent_slot",
  "parent_inactive",
  "wall_clock",
  "budget",
  "queue_predecessor",
] as const;
export type LifecycleBlockerKind = (typeof LIFECYCLE_BLOCKER_KINDS)[number];

/** What a causal reference points at (`refs[].kind`). */
export const LIFECYCLE_REF_KINDS = [
  "routing_decision",
  "agent",
  "commit",
  "verification",
  "examination",
  "finding",
  "decision",
  "node",
  "dispatch",
] as const;
export type LifecycleRefKind = (typeof LIFECYCLE_REF_KINDS)[number];

/**
 * Why a `start` was observed. A `start` whose reason is `recovered` continues
 * an occurrence whose end was never observed; any other start after a closed
 * occurrence is a new occurrence of the same operation, for example
 * `readmitted`.
 */
export const LIFECYCLE_START_REASONS = ["recovered", "readmitted"] as const;
export type LifecycleStartReason = (typeof LIFECYCLE_START_REASONS)[number];

/** The stable operation id: `phase:nodeId`, plus `:key` to tell apart several in one node. */
export const lifecycleOperationId = (phase: string, nodeId: string, key?: string): string =>
  key === undefined ? `${phase}:${nodeId}` : `${phase}:${nodeId}:${key}`;

/** The lifecycle observation a `lifecycle.observed` event carries, when it carries one. */
export const lifecycleOf = (event: Event): LifecycleObservation | undefined => {
  if (event.type !== "lifecycle.observed") return undefined;
  const parsed = MeasurementObservationSchema.safeParse(event.payload);
  return parsed.success && parsed.data.kind === "lifecycle" ? parsed.data : undefined;
};

/**
 * Parsed lifecycle observations, deduplicated by `observationId` (earliest
 * `receivedAt` kept), in event order: sequence when present, else `recordedAt`.
 */
export const lifecycleObservationsOf = (events: readonly Event[]): LifecycleObservation[] => {
  const ordered = events
    .map((event, index) => ({ event, index }))
    .sort((a, b) => {
      const sa = a.event.sequence;
      const sb = b.event.sequence;
      if (sa !== null && sa !== undefined && sb !== null && sb !== undefined && sa !== sb) {
        return sa - sb;
      }
      if (a.event.recordedAt !== b.event.recordedAt) {
        return a.event.recordedAt < b.event.recordedAt ? -1 : 1;
      }
      return a.index - b.index;
    });
  const kept = new Map<string, LifecycleObservation>();
  const order: string[] = [];
  for (const { event } of ordered) {
    const observation = lifecycleOf(event);
    if (observation === undefined) continue;
    const seen = kept.get(observation.observationId);
    if (seen === undefined) {
      kept.set(observation.observationId, observation);
      order.push(observation.observationId);
    } else if (observation.receivedAt < seen.receivedAt) {
      kept.set(observation.observationId, observation);
    }
  }
  return order.flatMap((id) => kept.get(id) ?? []);
};
