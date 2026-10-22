/**
 * The measurement channel: how an adapter reports what a launch consumed.
 *
 * Provider parsing stays in the adapter; what crosses this seam is the
 * contract's `MeasurementObservation`, metadata only. The execution layer
 * stamps the identity fields it owns, so an adapter cannot misattribute one.
 */
import type { MeasurementObservation } from "@nightshift/contracts";

/** Fields the execution layer stamps onto an observation; an adapter never supplies them. */
type StampedField =
  | "projectId"
  | "programId"
  | "runId"
  | "executionNodeId"
  | "agentId"
  | "launch"
  | "receivedAt";

/** Omit applied to each member of a union, which plain `Omit` would collapse. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/**
 * What an adapter supplies: the contract's observation minus the stamped
 * fields. The adapter provides `observationId`, the kind's own fields
 * (including `counterScope` on snapshots and terminals), `occurredAt?`,
 * `provenance`, `inclusion`, `childRef?` and `source: "harness"`.
 */
export type HarnessObservation = DistributiveOmit<MeasurementObservation, StampedField>;

/**
 * Where an adapter's observations go.
 *
 * **`observe` is not a receipt.** It enqueues synchronously and never throws or
 * blocks, so an adapter cannot stall its own stream parsing. Receipt is the
 * execution layer's durable journal append, which the recorder exposes as
 * `drain()`. An adapter that must know an observation is durable before it
 * acknowledges upstream (a receiver answering a provider's exporter) keeps its
 * own durable journal rather than inferring receipt from `observe` returning.
 */
export interface MeasurementSink {
  observe(observation: HarnessObservation): void;
}

/** A sink that drops everything. For a unit test that is not asserting on measurements. */
export const nullMeasurementSink: MeasurementSink = { observe: () => {} };

/** A sink that records what it was given, in order. For adapter tests. */
export const recordingMeasurementSink = (): MeasurementSink & {
  readonly observations: readonly HarnessObservation[];
} => {
  const observations: HarnessObservation[] = [];
  return { observations, observe: (observation) => void observations.push(observation) };
};
