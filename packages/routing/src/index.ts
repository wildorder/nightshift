/**
 * `@nightshift/routing` — model and harness selection.
 *
 * P3 has exactly one rule (D-P3-08) and it is deliberately dull. What is not
 * dull is the record it produces: every option considered, whether it was
 * eligible, why not when it was not, and whether an orchestrator pinned the
 * choice. P7 replaces the rule; the record's shape is what it inherits.
 *
 * Depends on `@nightshift/contracts` and `@nightshift/core` only. It knows
 * nothing about how a harness is started.
 */
export {
  DEFAULT_MODEL,
  FIXED_RULE_ID,
  type FixedRouteInput,
  fixedRoute,
  P3_HARNESS,
  P3_PROVIDER,
  type RoutingRefusalCode,
  RoutingRefusedError,
} from "./fixed.js";
