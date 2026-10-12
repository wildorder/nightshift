/**
 * `@nightshift/routing` — model and harness selection.
 *
 * `roleRoute` (D-RR-01, replacing P8's ladders and rules): the first eligible
 * route on the role's list in the org's policy is the choice, and a retry after
 * the work failed starts one place further down. Eligible means the
 * compatibility table can run it, the program's model policy permits it, it is
 * not unavailable, and it satisfies the orchestrator's pins. Every option
 * considered is recorded, with why not.
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
  arbiterRoute,
  arbiterSharesModelWith,
  examinerRoute,
  type HelperRouteInput,
  strongestExaminerRoute,
} from "./examiners.js";
export {
  type Candidate,
  type PreviousAttempt,
  type RoleRouteInput,
  type RoutePins,
  roleRoute,
} from "./roles.js";
