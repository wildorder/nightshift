/**
 * Routing by role (D-RR-01, 2026-10-12, replacing P8's ladders and rules).
 *
 * Each role has an ordered list of routes in the org's policy. A job's route is
 * the first one on its role's list that is **eligible**: the harness can run it
 * (the compatibility table), the program's `modelPolicy` permits it, nobody has
 * marked it unavailable, and it satisfies what the orchestrator pinned.
 *
 * A **retry** passes the attempt it replaces. After a failure that says
 * something about the model (D-P8-07) the search starts one place below it on
 * the list, so a list that starts cheap escalates, and the last place stays the
 * last; after one that does not, the same route is tried first. When nothing
 * from the start down can run, the places above it are tried nearest first: a
 * usage limit should leave the job the strongest route that can run, not stop
 * it, and not send it back to the top of the list.
 *
 * Pure and synchronous: no clock, no randomness, no I/O. The same inputs give
 * the same route.
 */
import type {
  Classification,
  ModelPolicy,
  RouteChoice,
  RouteOption,
  RouteSpec,
  RouteTarget,
  RoutingPolicy,
  RoutingRole,
} from "@nightshift/contracts";
import { ROUTING_ROLES, sameRoute } from "@nightshift/contracts";
import { compatiblePairs, matchesModelPattern } from "./compatibility.js";
import { RoutingRefusedError } from "./errors.js";

/** What an orchestrator may pin on a delegation (D-P8-05). Every pin is within policy. */
export interface RoutePins {
  readonly harness?: string | undefined;
  readonly model?: string | undefined;
  readonly effort?: RouteSpec["effort"] | undefined;
}

/** The attempt a retry replaces, and whether its failure says anything about the model. */
export interface PreviousAttempt {
  readonly target: RouteTarget;
  /** Its place on the role's list, when a role list chose it. */
  readonly position?: number | undefined;
  /** True after a verification, worker or examination failure; false after a conflict, stale base or interrupt. */
  readonly climb: boolean;
}

export interface RoleRouteInput {
  readonly policy: RoutingPolicy;
  /** The org configuration version the policy was narrowed from, for the record. */
  readonly policyVersion: number;
  readonly modelPolicy: ModelPolicy;
  readonly role: RoutingRole;
  /** What the job says about itself, recorded on the decision. */
  readonly classification?: Classification | undefined;
  readonly pins?: RoutePins | undefined;
  /** Routes that cannot serve now (D-P8-06), on top of the policy's own. */
  readonly unavailable?: readonly Pick<RouteSpec, "harness" | "model">[] | undefined;
  readonly previous?: PreviousAttempt | undefined;
}

/** One route in the search order, and where it sits on the role's list. */
export interface Candidate {
  readonly route: RouteSpec;
  /** Its place on the role's list; absent for a route only another role lists. */
  readonly position?: number;
}

/** The provider a harness runs `model` through, or why it cannot. */
const providerFor = (
  harness: string,
  model: string,
): { readonly provider: string } | { readonly reason: string } => {
  const pairs = compatiblePairs().filter((pair) => pair.harness === harness);
  if (pairs.length === 0) return { reason: `"${harness}" is not a harness Nightshift knows` };
  const runnable = pairs.filter((pair) =>
    pair.models.some((pattern) => matchesModelPattern(pattern, model)),
  );
  if (runnable.length === 0) return { reason: `the ${harness} harness cannot run "${model}"` };
  const now = runnable.find((pair) => pair.availableFrom === undefined);
  if (now === undefined) {
    return {
      reason: `${harness} running "${model}" arrives in ${runnable[0]?.availableFrom ?? "a later program"}`,
    };
  }
  return { provider: now.provider };
};

/** What decides whether a route may serve, whoever it is for. */
export interface Eligibility {
  readonly policy: RoutingPolicy;
  readonly modelPolicy: ModelPolicy;
  readonly unavailable?: readonly Pick<RouteSpec, "harness" | "model">[] | undefined;
  readonly pins?: RoutePins | undefined;
}

/** Why a route may not serve, or its target when it may. */
export const judge = (
  input: Eligibility,
  route: RouteSpec,
): { readonly target: RouteTarget } | { readonly target: RouteTarget; readonly reason: string } => {
  const effort = input.pins?.effort ?? route.effort;
  const resolved = providerFor(route.harness, route.model);
  const provider = "provider" in resolved ? resolved.provider : "unknown";
  const target: RouteTarget = {
    harness: route.harness,
    provider,
    model: route.model,
    ...(effort === undefined ? {} : { effort }),
  };
  if ("reason" in resolved) return { target, reason: resolved.reason };

  const policy = input.modelPolicy;
  if (!policy.allowedProviders.includes(provider)) {
    return { target, reason: `the program's modelPolicy does not allow ${provider}` };
  }
  if (policy.forbiddenModels.includes(route.model)) {
    return { target, reason: `the program's modelPolicy forbids "${route.model}"` };
  }
  if (policy.allowedModels.length > 0 && !policy.allowedModels.includes(route.model)) {
    return {
      target,
      reason: `the program's modelPolicy allows only [${policy.allowedModels.join(", ")}]`,
    };
  }
  if (input.policy.unavailable.some((spec) => sameRoute(spec, route))) {
    return { target, reason: "the org's policy marks this route unavailable" };
  }
  if ((input.unavailable ?? []).some((spec) => sameRoute(spec, route))) {
    return { target, reason: "this route cannot serve now (a usage limit, or it could not start)" };
  }
  const pins = input.pins;
  if (pins?.harness !== undefined && route.harness !== pins.harness) {
    return { target, reason: `the orchestrator pinned the ${pins.harness} harness` };
  }
  if (pins?.model !== undefined && route.model !== pins.model) {
    return { target, reason: `the orchestrator pinned "${pins.model}"` };
  }
  return { target };
};

/** `role`'s list, each route with its place. */
export const listOf = (policy: RoutingPolicy, role: RoutingRole): readonly Candidate[] =>
  policy.roles[role].map((route, position) => ({ route, position }));

/** Every route the policy names, `role`'s own first, each once. */
const everyRoute = (policy: RoutingPolicy, role: RoutingRole): readonly Candidate[] => {
  const order: Candidate[] = [...listOf(policy, role)];
  for (const other of ROUTING_ROLES) {
    if (other === role) continue;
    for (const route of policy.roles[other]) {
      if (!order.some((seen) => sameRoute(seen.route, route))) order.push({ route });
    }
  }
  return order;
};

/**
 * `role`'s list, and after it the org's other listed routes when the
 * program's own model policy permits nothing on the list: a program that
 * narrows below a role's choices still runs, on what it allows. A route that
 * is merely unavailable now does not open the other lists.
 */
export const candidatesFor = (
  input: Pick<Eligibility, "policy" | "modelPolicy">,
  role: RoutingRole,
): readonly Candidate[] => {
  const list = listOf(input.policy, role);
  const permitted = (candidate: Candidate): boolean =>
    !(
      "reason" in
      judge(
        { policy: { ...input.policy, unavailable: [] }, modelPolicy: input.modelPolicy },
        candidate.route,
      )
    );
  return list.some(permitted) ? list : everyRoute(input.policy, role);
};

const wasPinned = (pins: RoutePins | undefined): boolean =>
  pins !== undefined && Object.values(pins).some((value) => value !== undefined);

/** Where a retry's search begins: one place below a failed attempt, or the top. */
const startOf = (list: readonly Candidate[], previous: PreviousAttempt | undefined): number => {
  if (previous?.climb !== true) return 0;
  const at =
    previous.position ?? list.findIndex((candidate) => sameRoute(candidate.route, previous.target));
  if (at < 0) return 0;
  return Math.min(at + 1, list.length - 1);
};

/** The search order for this request. */
const orderFor = (input: RoleRouteInput): readonly Candidate[] => {
  if (input.pins?.harness !== undefined || input.pins?.model !== undefined) {
    return everyRoute(input.policy, input.role);
  }
  const list = candidatesFor(input, input.role);
  const start = startOf(list, input.previous);
  const ordered = [...list.slice(start), ...list.slice(0, start).reverse()];
  const previous = input.previous;
  if (previous === undefined || previous.climb) return ordered;
  // A failure that says nothing about the model: the same route first.
  const same = ordered.filter((candidate) => sameRoute(candidate.route, previous.target));
  return [...same, ...ordered.filter((candidate) => !sameRoute(candidate.route, previous.target))];
};

/** The first of `ordered` that may serve and that `refuse` lets through, with every option considered. */
export const firstEligible = (
  input: Eligibility & { readonly policyVersion: number; readonly role: RoutingRole },
  ruleId: string,
  ordered: readonly Candidate[],
  refuse: (candidate: Candidate, target: RouteTarget) => string | undefined = () => undefined,
  extra: Pick<RouteChoice, "classification"> = {},
): RouteChoice => {
  const options: RouteOption[] = [];
  for (const candidate of ordered) {
    const verdict = judge(input, candidate.route);
    const reason = "reason" in verdict ? verdict.reason : refuse(candidate, verdict.target);
    if (reason !== undefined) {
      options.push({ target: verdict.target, eligible: false, reason });
      continue;
    }
    options.push({ target: verdict.target, eligible: true });
    return {
      target: verdict.target,
      eligibleOptions: options,
      ruleId,
      wasOverride: wasPinned(input.pins),
      role: input.role,
      ...(candidate.position === undefined ? {} : { position: candidate.position }),
      ...extra,
      policyVersion: input.policyVersion,
    };
  }
  throw new RoutingRefusedError(
    "no_eligible_route",
    `nothing on the ${input.role}'s list can run now (${ruleId}): ` +
      (options.map((option) => `${option.target.model}: ${option.reason ?? "?"}`).join("; ") ||
        "no route at all"),
    options,
  );
};

/**
 * The route for one attempt in one role (D-RR-01). Throws
 * {@link RoutingRefusedError} when nothing on the list can run it, with every
 * option considered.
 */
export const roleRoute = (input: RoleRouteInput): RouteChoice =>
  firstEligible(
    input,
    input.role,
    orderFor(input),
    undefined,
    input.classification === undefined ? {} : { classification: input.classification },
  );
