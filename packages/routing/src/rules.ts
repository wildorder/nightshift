/**
 * Routing, P8: a first-match rule table over an org's ladders (D-P8-04 …
 * D-P8-07, SC-P8-01, SC-P8-10).
 *
 * The effective policy's rules say where a job **starts**: the first rule whose
 * `when` matches its classification names a ladder and a tier. From there the
 * order of everything that could run it is fixed, and the first eligible route
 * in that order is the choice:
 *
 * ```text
 * for each rung of the job's ladder, from the starting rung up:
 *   the rung's own routes, in order
 *   then the same tier on every other ladder, in policy order      (D-P8-06)
 * ```
 *
 * A route is eligible when the harness can run it (the compatibility table), the
 * program's `modelPolicy` permits it, nobody has marked it unavailable, and it
 * satisfies what the orchestrator pinned. So an unavailable route falls back
 * sideways, then to the other provider at the same tier, then up; never down.
 *
 * A **retry** passes the attempt it replaces. After a failure that says
 * something about the model (D-P8-07) the search starts one rung above it on the
 * same ladder, and the top rung stays the top rung; after one that does not, the
 * same route is tried first.
 *
 * Pure and synchronous: no clock, no randomness, no I/O. The same inputs give
 * the same route, which is SC-P8-01.
 */
import type {
  Classification,
  ModelPolicy,
  RouteChoice,
  RouteOption,
  RouteSpec,
  RouteTarget,
  RoutingPolicy,
  RoutingRule,
  Tier,
} from "@nightshift/contracts";
import { sameRoute, tierRank } from "@nightshift/contracts";
import { compatiblePairs, matchesModelPattern } from "./compatibility.js";
import { RoutingRefusedError } from "./errors.js";

/** What an orchestrator may pin on a delegation (D-P8-05). Every pin is within policy. */
export interface RoutePins {
  readonly ladder?: string | undefined;
  readonly tier?: Tier | undefined;
  readonly harness?: string | undefined;
  readonly model?: string | undefined;
  readonly effort?: RouteSpec["effort"] | undefined;
}

/** The attempt a retry replaces, and whether its failure says anything about the model. */
export interface PreviousAttempt {
  readonly target: RouteTarget;
  readonly ladder?: string | undefined;
  readonly rungIndex?: number | undefined;
  /** True after a verification, worker or examination failure; false after a conflict, stale base or interrupt. */
  readonly climb: boolean;
}

export interface RuleRouteInput {
  readonly policy: RoutingPolicy;
  /** The org configuration version the policy was narrowed from, for the record. */
  readonly policyVersion: number;
  readonly modelPolicy: ModelPolicy;
  readonly classification: Classification;
  readonly pins?: RoutePins | undefined;
  /** Routes found unavailable in this run (D-P8-06), on top of the policy's own. */
  readonly unavailable?: readonly Pick<RouteSpec, "harness" | "model">[] | undefined;
  readonly previous?: PreviousAttempt | undefined;
}

/** Whether `rule` matches `classification`. An absent field matches anything; `kind` absent in the job matches no kind rule. */
export const ruleMatches = (rule: RoutingRule, classification: Classification): boolean => {
  const { when } = rule;
  if (when.risk !== undefined && !when.risk.includes(classification.risk)) return false;
  if (when.ambiguity !== undefined && !when.ambiguity.includes(classification.ambiguity))
    return false;
  if (when.testability !== undefined && !when.testability.includes(classification.testability)) {
    return false;
  }
  if (
    when.kind !== undefined &&
    (classification.kind === undefined || !when.kind.includes(classification.kind))
  ) {
    return false;
  }
  return true;
};

/** The first rule that matches. The last rule is unconditional (the schema says so), so there always is one. */
export const firstMatchingRule = (
  policy: RoutingPolicy,
  classification: Classification,
): RoutingRule => {
  const rule = policy.rules.find((candidate) => ruleMatches(candidate, classification));
  if (rule === undefined)
    throw new Error("a routing policy's last rule matches everything; this one matched nothing");
  return rule;
};

/** One route in the search order, and where it sits. */
interface Candidate {
  readonly ladder: string;
  readonly rungIndex: number;
  readonly tier: Tier;
  readonly route: RouteSpec;
}

/** The lowest rung on `ladder` at or above `tier`; the top rung when none is. */
const startingIndex = (policy: RoutingPolicy, ladder: string, tier: Tier): number => {
  const rungs = policy.ladders[ladder] ?? [];
  const index = rungs.findIndex((rung) => tierRank(rung.tier) >= tierRank(tier));
  return index >= 0 ? index : Math.max(0, rungs.length - 1);
};

/** Every route from `(ladder, from)` upward, each level followed by the same tier on the other ladders. */
const searchOrder = (policy: RoutingPolicy, ladder: string, from: number): readonly Candidate[] => {
  const own = policy.ladders[ladder] ?? [];
  const others = Object.keys(policy.ladders).filter((name) => name !== ladder);
  const order: Candidate[] = [];
  for (let index = from; index < own.length; index += 1) {
    const rung = own[index];
    if (rung === undefined) continue;
    for (const route of rung.routes)
      order.push({ ladder, rungIndex: index, tier: rung.tier, route });
    for (const other of others) {
      (policy.ladders[other] ?? []).forEach((otherRung, otherIndex) => {
        if (otherRung.tier !== rung.tier) return;
        for (const route of otherRung.routes) {
          order.push({ ladder: other, rungIndex: otherIndex, tier: otherRung.tier, route });
        }
      });
    }
  }
  return order;
};

/** Every route on every ladder, cheapest first within each ladder, ladders in policy order. */
const everyRoute = (policy: RoutingPolicy): readonly Candidate[] =>
  Object.entries(policy.ladders).flatMap(([ladder, rungs]) =>
    rungs.flatMap((rung, rungIndex) =>
      rung.routes.map((route) => ({ ladder, rungIndex, tier: rung.tier, route })),
    ),
  );

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

/** Why a candidate may not be chosen, or its target when it may. */
const judge = (
  input: RuleRouteInput,
  candidate: Candidate,
): { readonly target: RouteTarget } | { readonly target: RouteTarget; readonly reason: string } => {
  const { route } = candidate;
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
    return { target, reason: "this route could not start earlier in this run" };
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

const wasPinned = (pins: RoutePins | undefined): boolean =>
  pins !== undefined && Object.values(pins).some((value) => value !== undefined);

/** Where the search begins: the rule's start, a pin's, or one above the attempt a climbing retry replaces. */
const startOf = (
  input: RuleRouteInput,
  rule: RoutingRule,
): { readonly ladder: string; readonly index: number } => {
  const previous = input.previous;
  if (
    previous?.climb === true &&
    previous.ladder !== undefined &&
    previous.rungIndex !== undefined
  ) {
    const rungs = input.policy.ladders[previous.ladder];
    if (rungs !== undefined) {
      return { ladder: previous.ladder, index: Math.min(previous.rungIndex + 1, rungs.length - 1) };
    }
  }
  const pinnedLadder = input.pins?.ladder;
  const ladder =
    pinnedLadder !== undefined && input.policy.ladders[pinnedLadder] !== undefined
      ? pinnedLadder
      : rule.start.ladder;
  const tier = input.pins?.tier ?? rule.start.tier;
  return { ladder, index: startingIndex(input.policy, ladder, tier) };
};

/**
 * Whether the program permits anything at all in `order`, ignoring what is
 * unavailable in this run: the question is whether its policy leaves room above,
 * not whether that room is free now.
 */
const permitsAny = (input: RuleRouteInput, order: readonly Candidate[]): boolean =>
  order.some(
    (candidate) =>
      !(
        "reason" in
        judge(
          {
            ...input,
            unavailable: [],
            pins: undefined,
            policy: { ...input.policy, unavailable: [] },
          },
          candidate,
        )
      ),
  );

/**
 * The rungs below the start, nearest first, each with the same tier on the
 * other ladders. Searched only when the program's own policy permits nothing at
 * or above the start: a program that caps the ladder lowers its ceiling. A
 * route that is merely unavailable never sends a job down (D-P8-06).
 */
const belowStart = (policy: RoutingPolicy, ladder: string, start: number): readonly Candidate[] =>
  Array.from({ length: start }, (_, offset) => start - 1 - offset).flatMap((index) =>
    searchOrder(policy, ladder, index).filter((candidate) => {
      const own = policy.ladders[ladder]?.[index];
      return own !== undefined && candidate.tier === own.tier;
    }),
  );

/** The search order for this request: from the start, or every route when a harness or model is pinned. */
const orderFor = (input: RuleRouteInput, rule: RoutingRule): readonly Candidate[] => {
  const pinnedRoute = input.pins?.harness !== undefined || input.pins?.model !== undefined;
  const start = startOf(input, rule);
  const upward = searchOrder(input.policy, start.ladder, start.index);
  const ordered = pinnedRoute
    ? everyRoute(input.policy)
    : permitsAny(input, upward)
      ? upward
      : [...upward, ...belowStart(input.policy, start.ladder, start.index)];
  const previous = input.previous;
  if (previous === undefined || previous.climb) return ordered;
  // A failure that says nothing about the model: the same route first.
  const same = ordered.filter((candidate) => sameRoute(candidate.route, previous.target));
  return [...same, ...ordered.filter((candidate) => !sameRoute(candidate.route, previous.target))];
};

/**
 * The route for one attempt at one job (D-P8-04 … D-P8-07). Throws
 * {@link RoutingRefusedError} when nothing on the effective policy's ladders can
 * run it, with every option considered.
 */
export const ruleRoute = (input: RuleRouteInput): RouteChoice => {
  if (input.pins?.ladder !== undefined && input.policy.ladders[input.pins.ladder] === undefined) {
    throw new RoutingRefusedError(
      "no_eligible_route",
      `"${input.pins.ladder}" is not a ladder of this run's policy (${Object.keys(input.policy.ladders).join(", ")})`,
      [],
    );
  }
  const rule = firstMatchingRule(input.policy, input.classification);
  const options: RouteOption[] = [];
  for (const candidate of orderFor(input, rule)) {
    const verdict = judge(input, candidate);
    if ("reason" in verdict) {
      options.push({ target: verdict.target, eligible: false, reason: verdict.reason });
      continue;
    }
    options.push({ target: verdict.target, eligible: true });
    return {
      target: verdict.target,
      eligibleOptions: options,
      ruleId: rule.id,
      wasOverride: wasPinned(input.pins),
      ladder: candidate.ladder,
      rung: { tier: candidate.tier, index: candidate.rungIndex },
      classification: input.classification,
      policyVersion: input.policyVersion,
    };
  }
  throw new RoutingRefusedError(
    "no_eligible_route",
    `nothing on this run's ladders can run the job (rule ${rule.id}, starting on ${rule.start.ladder} at ${rule.start.tier}): ` +
      (options.map((option) => `${option.target.model}: ${option.reason ?? "?"}`).join("; ") ||
        "no route at all"),
    options,
  );
};
