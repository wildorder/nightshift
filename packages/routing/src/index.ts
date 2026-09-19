/**
 * `@nightshift/routing` — model and harness selection.
 *
 * P5 has one rule, `configuredRoute` (D-P5-04): the Program Contract's model
 * policy intersected with the harness compatibility table. It is still
 * deliberately dull, with no cost and no capability reasoning; P7 replaces the
 * rule. What is not dull is the record it produces: every option considered,
 * whether it was eligible, why not when it was not, and whether an orchestrator
 * pinned the choice. That shape is what P7 inherits.
 *
 * Depends on `@nightshift/contracts` and `@nightshift/core` only. It knows which
 * harnesses exist by name, and nothing about how one is started.
 */
export {
  type CompatibleProvider,
  canRunModel,
  compatiblePairs,
  HARNESS_COMPATIBILITY,
  type HarnessCompatibility,
  KNOWN_HARNESSES,
  matchesModelPattern,
  type RouteAuthentication,
} from "./compatibility.js";
export {
  CONFIGURED_RULE_ID,
  type ConfiguredRouteInput,
  configuredRoute,
  type RouteOverride,
  type RoutingRefusalCode,
  RoutingRefusedError,
} from "./configured.js";
