/**
 * Routing policy — where a job goes, as an organisation's standing choice (P8,
 * D-P8-02 … D-P8-07).
 *
 * An org holds **ladders**, one or more, each an ordered list of **rungs**. A rung
 * is one or more **routes** in preference order, and carries a **tier**
 * (`cheap`, `standard`, `frontier`), so rules and examiners can speak across
 * ladders of different lengths without pretending they are the same. A route is
 * a harness and a model, with an optional reasoning **effort** the adapter passes
 * to its harness.
 *
 * **Rules** say where a job starts: the first rule whose `when` matches the
 * job's classification names a ladder and a tier. Nothing here chooses a route;
 * `packages/routing` does, from this and nothing else, deterministically.
 *
 * A repository's `nightshift.config.json` and a program's contract may **narrow**
 * this policy and never widen it (D-P8-03). `core`'s `effectivePolicy` decides
 * which is which.
 */
import { z } from "zod";
import { AmbiguityLevelSchema, RiskLevelSchema } from "./common.js";

/** How hard a model is asked to think. The harness's own default applies when absent. */
export const EffortSchema = z.enum(["low", "medium", "high", "xhigh", "max"]);
export type Effort = z.infer<typeof EffortSchema>;

/** A rung's standing, comparable across ladders. Ordered: cheap < standard < frontier. */
export const TierSchema = z.enum(["cheap", "standard", "frontier"]);
export type Tier = z.infer<typeof TierSchema>;

export const TIER_ORDER: readonly Tier[] = ["cheap", "standard", "frontier"];

/** Position of a tier, for comparing: cheap 0, standard 1, frontier 2. */
export const tierRank = (tier: Tier): number => TIER_ORDER.indexOf(tier);

/** Whether a job is proven by the contract's own checks (D-P8-01). */
export const TestabilitySchema = z.enum(["strong", "weak", "none"]);
export type Testability = z.infer<typeof TestabilitySchema>;

/** What kind of work a job is (D-P8-01). `orchestrate` is a strand's or sub-program's orchestrator. */
export const JobKindSchema = z.enum([
  "implement",
  "fix",
  "refactor",
  "test",
  "docs",
  "orchestrate",
]);
export type JobKind = z.infer<typeof JobKindSchema>;

/**
 * What routing matched a job on (D-P8-01), with every conservative default
 * already filled in. Recorded on each routing decision, so the decision explains
 * itself and the dataset needs no join (SC-11).
 */
export const ClassificationSchema = z.strictObject({
  risk: RiskLevelSchema,
  ambiguity: AmbiguityLevelSchema,
  testability: TestabilitySchema,
  /** Absent when the delegator said nothing: a rule on `kind` then does not match. */
  kind: JobKindSchema.optional(),
});
export type Classification = z.infer<typeof ClassificationSchema>;

/** A harness, a model, and optionally the effort to run it at. The provider follows from the harness. */
export const RouteSpecSchema = z.strictObject({
  harness: z.string().min(1),
  model: z.string().min(1),
  effort: EffortSchema.optional(),
});
export type RouteSpec = z.infer<typeof RouteSpecSchema>;

export const RungSchema = z.strictObject({
  tier: TierSchema,
  /** In preference order. A rung's later routes are its fallbacks (D-P8-06). */
  routes: z.array(RouteSpecSchema).min(1),
});
export type Rung = z.infer<typeof RungSchema>;

/** Cheapest first. Tiers never go down as the ladder climbs. */
export const LadderSchema = z
  .array(RungSchema)
  .min(1)
  .refine(
    (rungs) =>
      rungs.every(
        (rung, index) =>
          index === 0 || tierRank(rung.tier) >= tierRank(rungs[index - 1]?.tier ?? "cheap"),
      ),
    { message: "a ladder's tiers must not go down as it climbs" },
  );
export type Ladder = z.infer<typeof LadderSchema>;

/** The classification a rule matches on. A field absent from `when` matches anything. */
export const RuleConditionSchema = z.strictObject({
  risk: z.array(RiskLevelSchema).min(1).optional(),
  ambiguity: z.array(AmbiguityLevelSchema).min(1).optional(),
  testability: z.array(TestabilitySchema).min(1).optional(),
  kind: z.array(JobKindSchema).min(1).optional(),
});
export type RuleCondition = z.infer<typeof RuleConditionSchema>;

export const RoutingRuleSchema = z.strictObject({
  id: z.string().min(1),
  when: RuleConditionSchema,
  start: z.strictObject({ ladder: z.string().min(1), tier: TierSchema }),
});
export type RoutingRule = z.infer<typeof RoutingRuleSchema>;

/** Dollars per million tokens, for an **estimate** when a harness reports no cost (D-P8-08). */
export const ModelPriceSchema = z.strictObject({
  inputPerMTok: z.number().min(0),
  outputPerMTok: z.number().min(0),
  cacheReadPerMTok: z.number().min(0).optional(),
  cacheWritePerMTok: z.number().min(0).optional(),
});
export type ModelPrice = z.infer<typeof ModelPriceSchema>;

const isUnconditional = (condition: RuleCondition): boolean =>
  Object.values(condition).every((value) => value === undefined);

export const RoutingPolicySchema = z
  .strictObject({
    /** Ladder name → rungs. Object order is the order ladders are tried in a fallback. */
    ladders: z.record(z.string().min(1), LadderSchema),
    rules: z.array(RoutingRuleSchema).min(1),
    /** Routes nobody may start this run (D-P8-06). Matched on harness and model. */
    unavailable: z.array(RouteSpecSchema),
    prices: z.record(z.string().min(1), ModelPriceSchema),
  })
  .refine((policy) => Object.keys(policy.ladders).length > 0, {
    message: "a routing policy needs at least one ladder",
    path: ["ladders"],
  })
  .refine((policy) => new Set(policy.rules.map((rule) => rule.id)).size === policy.rules.length, {
    message: "rule ids must be unique",
    path: ["rules"],
  })
  .refine((policy) => isUnconditional(policy.rules.at(-1)?.when ?? {}), {
    message: "the last rule must match everything (an empty `when`), so every job has a route",
    path: ["rules"],
  })
  .refine(
    (policy) => policy.rules.every((rule) => policy.ladders[rule.start.ladder] !== undefined),
    {
      message: "every rule must start on a ladder the policy has",
      path: ["rules"],
    },
  );
export type RoutingPolicy = z.infer<typeof RoutingPolicySchema>;

/** Whether two route specs name the same harness and model. Effort is not identity. */
export const sameRoute = (
  a: Pick<RouteSpec, "harness" | "model">,
  b: Pick<RouteSpec, "harness" | "model">,
): boolean => a.harness === b.harness && a.model === b.model;

/**
 * What a repository or a program may say about routing (D-P8-03): **only ever
 * less** than the org allows. Keep some ladders, forbid some routes, start no
 * job below a tier. Anything that would add a model, a harness or a ladder is a
 * widening, and `effectivePolicy` in `core` refuses it by name.
 */
export const RoutingNarrowingSchema = z.strictObject({
  /** Keep only these of the org's ladders. Naming one the org lacks is a widening. */
  ladders: z.array(z.string().min(1)).min(1).optional(),
  /** Never start these routes, whatever the rung. Effort is not matched. */
  forbid: z
    .array(z.strictObject({ harness: z.string().min(1), model: z.string().min(1) }))
    .optional(),
  /** Start no job below this tier: every rule's starting tier is raised to it. */
  minimumTier: TierSchema.optional(),
});
export type RoutingNarrowing = z.infer<typeof RoutingNarrowingSchema>;

/**
 * Two narrowings as one, each keeping everything the other took away: the
 * ladders both keep, every route either forbids, the higher minimum tier.
 */
const keptByBoth = (
  a: readonly string[] | undefined,
  b: readonly string[] | undefined,
): string[] | undefined => {
  if (a === undefined) return b === undefined ? undefined : [...b];
  if (b === undefined) return [...a];
  return a.filter((name) => b.includes(name));
};

const higherTier = (a: Tier | undefined, b: Tier | undefined): Tier | undefined => {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return tierRank(a) >= tierRank(b) ? a : b;
};

export const combineNarrowings = (
  a: RoutingNarrowing | undefined,
  b: RoutingNarrowing | undefined,
): RoutingNarrowing | undefined => {
  if (a === undefined) return b;
  if (b === undefined) return a;
  const ladders = keptByBoth(a.ladders, b.ladders);
  const forbid = [...(a.forbid ?? []), ...(b.forbid ?? [])];
  const minimumTier = higherTier(a.minimumTier, b.minimumTier);
  return {
    ...(ladders === undefined ? {} : { ladders }),
    ...(forbid.length === 0 ? {} : { forbid }),
    ...(minimumTier === undefined ? {} : { minimumTier }),
  };
};
