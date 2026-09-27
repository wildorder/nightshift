/**
 * Why routing refused, as a typed error an orchestrator can act on (P5, P8).
 * Every option considered travels with it, so a refusal explains itself.
 */
import type { RouteOption } from "@nightshift/contracts";

export type RoutingRefusalCode =
  /** The pinned model is on the policy's forbidden list, or off its allowed one. */
  | "model_forbidden"
  /** No provider the policy allows can be routed to at all. */
  | "provider_not_allowed"
  /** The pinned harness is not one the table knows. */
  | "harness_unknown"
  /** The table says the pinned harness cannot run the pinned or permitted models. */
  | "harness_model_incompatible"
  /** The only compatible pairs belong to a later program. */
  | "route_not_yet_available"
  /** The policy and the table intersect in nothing. */
  | "no_eligible_route";

export class RoutingRefusedError extends Error {
  override readonly name = "RoutingRefusedError";

  constructor(
    readonly code: RoutingRefusalCode,
    message: string,
    /** Every option considered, so the refusal explains itself. */
    readonly eligibleOptions: readonly RouteOption[],
  ) {
    super(message);
  }
}
