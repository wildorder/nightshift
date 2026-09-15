/**
 * The sequencing port: how the Streams consumer numbers an event (A-22, T6).
 *
 * Separate from `EventStore` because nothing but the consumer may number an
 * event, and a method on the store every caller holds would invite a second
 * numberer.
 */
import type { EventId } from "@nightshift/contracts";
import type { RunScope } from "../rules/ownership.js";

export type StampOutcome =
  /** The event was unnumbered and now carries `sequence`. */
  | { readonly kind: "stamped"; readonly sequence: number }
  /** The event was already numbered, typically a redelivery. Nothing changed. */
  | { readonly kind: "already_numbered"; readonly sequence: number }
  /** No such event, for example one removed by cleanup. Nothing changed. */
  | { readonly kind: "missing" };

export interface SequenceLedger {
  /**
   * Numbers one event if it is still unnumbered.
   *
   * Stamping the event and advancing the run's counter happen **atomically**:
   * both or neither. That is what makes the A-22 claim true. If the counter were
   * advanced first and the stamp applied after, a crash between the two would
   * consume a number no event carries, and redelivery would consume another.
   */
  stamp(scope: RunScope, eventId: EventId): Promise<StampOutcome>;
}
