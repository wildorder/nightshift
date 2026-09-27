/**
 * Who examines and who arbitrates (P8, D-P8-10, D-P8-13).
 *
 * Both are chosen from the run's own ladders, by the same eligibility as any
 * route (the compatibility table, the program's model policy, what is
 * unavailable), and then by what independence asks:
 *
 * - An **examiner** runs a different model from the implementer when the
 *   policy says `mustDifferModel`, and comes from another provider when it
 *   says `mustDifferProvider` (in practice, another provider's ladder). At high
 *   risk it is that ladder's frontier tier; otherwise the standard tier, and
 *   the nearest tier above when there is none.
 * - An **arbiter** runs on the highest tier the ladders offer, never lower to
 *   avoid a side's model (the owner's ruling, 2026-09-26). On that tier it
 *   prefers a third provider's model, then any model neither side used, then
 *   the examiner's model, then the implementer's: a fresh invocation either way,
 *   so it is never either side's agent. Sharing the examiner's leans towards
 *   upholding, the direction the owner can cheaply reverse; the report counts
 *   how often an arbiter agrees with the side whose model it shares.
 *
 * Deterministic like the rest of routing: the same inputs, the same choice.
 */
import type {
  JobContract,
  ModelPolicy,
  RouteChoice,
  RouteOption,
  RouteSpec,
  RouteTarget,
  RoutingPolicy,
  Tier,
} from "@nightshift/contracts";
import { tierRank } from "@nightshift/contracts";
import { RoutingRefusedError } from "./errors.js";
import { type Candidate, everyRoute, judge, type RuleRouteInput } from "./rules.js";

export interface HelperRouteInput {
  readonly policy: RoutingPolicy;
  readonly policyVersion: number;
  readonly modelPolicy: ModelPolicy;
  readonly unavailable?: readonly Pick<RouteSpec, "harness" | "model">[] | undefined;
}

/** The eligibility a helper's route is judged by: any route's, with no pins. */
const eligible = (
  input: HelperRouteInput,
  candidate: Candidate,
): { readonly target: RouteTarget; readonly reason?: string } => {
  const judged = judge(
    {
      policy: input.policy,
      policyVersion: input.policyVersion,
      modelPolicy: input.modelPolicy,
      classification: { risk: "low", ambiguity: "low", testability: "weak" },
      unavailable: input.unavailable,
    } satisfies RuleRouteInput,
    candidate,
  );
  return "reason" in judged ? judged : { target: judged.target };
};

/** Candidates ordered by closeness to `tier`, at or above it first, then below. */
const byTier = (candidates: readonly Candidate[], tier: Tier): readonly Candidate[] => {
  const distance = (candidate: Candidate): number => {
    const gap = tierRank(candidate.tier) - tierRank(tier);
    return gap >= 0 ? gap : 10 - gap;
  };
  return [...candidates].sort((a, b) => distance(a) - distance(b));
};

const choose = (
  input: HelperRouteInput,
  ruleId: string,
  ordered: readonly Candidate[],
  refuse: (candidate: Candidate, target: RouteTarget) => string | undefined,
): RouteChoice => {
  const options: RouteOption[] = [];
  for (const candidate of ordered) {
    const judged = eligible(input, candidate);
    const reason = judged.reason ?? refuse(candidate, judged.target);
    if (reason !== undefined) {
      options.push({ target: judged.target, eligible: false, reason });
      continue;
    }
    options.push({ target: judged.target, eligible: true });
    return {
      target: judged.target,
      eligibleOptions: options,
      ruleId,
      wasOverride: false,
      ladder: candidate.ladder,
      rung: { tier: candidate.tier, index: candidate.rungIndex },
      policyVersion: input.policyVersion,
    };
  }
  throw new RoutingRefusedError(
    "no_eligible_route",
    `no route on this run's ladders is independent enough to serve (${ruleId}): ` +
      (options.map((option) => `${option.target.model}: ${option.reason ?? "?"}`).join("; ") ||
        "no route at all"),
    options,
  );
};

/** The examiner's route (D-P8-10). */
export const examinerRoute = (
  input: HelperRouteInput & {
    readonly job: Pick<JobContract, "risk">;
    readonly implementer: RouteTarget;
    readonly mustDifferModel: boolean;
    readonly mustDifferProvider: boolean;
  },
): RouteChoice => {
  const tier: Tier = input.job.risk === "high" ? "frontier" : "standard";
  // Ladders that do not hold the implementer's model come first: more independent.
  const all = everyRoute(input.policy);
  const ownLadders = new Set(
    all.filter((c) => c.route.model === input.implementer.model).map((c) => c.ladder),
  );
  const ordered = byTier(
    [
      ...all.filter((c) => !ownLadders.has(c.ladder)),
      ...all.filter((c) => ownLadders.has(c.ladder)),
    ],
    tier,
  );
  return choose(input, `examiner-${tier}`, ordered, (_candidate, target) => {
    if (input.mustDifferModel && target.model === input.implementer.model) {
      return `the policy requires a different model from the implementer's ${input.implementer.model}`;
    }
    if (input.mustDifferProvider && target.provider === input.implementer.provider) {
      return `the policy requires a different provider from the implementer's ${input.implementer.provider}`;
    }
    return undefined;
  });
};

/** Which side of a dispute an arbiter on `target` shares a model with, if either. */
export const arbiterSharesModelWith = (
  target: Pick<RouteTarget, "model">,
  sides: {
    readonly implementer: Pick<RouteTarget, "model">;
    readonly examiner: Pick<RouteTarget, "model">;
  },
): "examiner" | "implementer" | undefined =>
  target.model === sides.examiner.model
    ? "examiner"
    : target.model === sides.implementer.model
      ? "implementer"
      : undefined;

/**
 * The arbiter's route (D-P8-13, as amended 2026-09-26): the highest tier first,
 * and on it a third provider, then a model neither side used, then the
 * examiner's, then the implementer's.
 */
export const arbiterRoute = (
  input: HelperRouteInput & { readonly implementer: RouteTarget; readonly examiner: RouteTarget },
): RouteChoice => {
  const sides = new Set([input.implementer.provider, input.examiner.provider]);
  const preference = (candidate: Candidate): number => {
    const target = eligible(input, candidate).target;
    const shares = arbiterSharesModelWith(target, input);
    if (shares === "examiner") return 2;
    if (shares === "implementer") return 3;
    return sides.has(target.provider) ? 1 : 0;
  };
  const ordered = [...everyRoute(input.policy)].sort(
    (a, b) => tierRank(b.tier) - tierRank(a.tier) || preference(a) - preference(b),
  );
  return choose(input, "arbiter", ordered, () => undefined);
};
