/**
 * `@nightshift/routing` — model and harness selection.
 *
 * P8's rule, `ruleRoute` (D-P8-04 … D-P8-07): the first rule of an org's
 * policy that matches a job's classification names a ladder and a tier, and
 * the first eligible route from there, sideways then across then up, is the
 * choice. Eligible means the compatibility table can run it, the program's
 * model policy permits it, it is not unavailable, and it satisfies the
 * orchestrator's pins. Every option considered is recorded, with why not.
 *
 * P5's `configuredRoute` is retired: a run that recorded no policy is routed
 * over the seeded org default, narrowed by its contract (`policyOfRun`).
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
export { type RoutingRefusalCode, RoutingRefusedError } from "./errors.js";
export {
  firstMatchingRule,
  type PreviousAttempt,
  type RoutePins,
  type RuleRouteInput,
  ruleMatches,
  ruleRoute,
} from "./rules.js";
