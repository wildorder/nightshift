/**
 * Routing policy — who runs each role, as an organisation's standing choice
 * (P8, D-P8-02; replaced by per-role preferences on 2026-10-12, D-RR-01).
 *
 * An org holds one ordered list of routes per **role**: the orchestrator, the
 * implementer that does a job's work, the examiner, and the arbiter. A route is
 * a harness and a model, with an optional reasoning **effort** the adapter
 * passes to its harness. The first route in a role's list that can run now is
 * the one it runs on; a route that cannot (a usage limit, not signed in, a
 * model not offered) is passed over for the next. A retry after the work failed
 * moves one place down the list, so a list that starts cheap escalates.
 *
 * Nothing here chooses a route: `packages/routing` does, from this and nothing
 * else, deterministically.
 *
 * Ladders, tiers and first-match rules (D-P8-02 … D-P8-07 as first built) are
 * gone. A configuration or a run recorded with them is read as the role lists
 * their search order meant ({@link rolesFromLadders}), so nothing stored needs
 * rewriting.
 *
 * A repository's `nightshift.config.json` and a program's contract may
 * **narrow** this policy and never widen it (D-P8-03). `core`'s
 * `effectivePolicy` decides which is which.
 */
import { z } from "zod";
import { AmbiguityLevelSchema, RiskLevelSchema } from "./common.js";

/** How hard a model is asked to think. The harness's own default applies when absent. */
export const EffortSchema = z.enum(["low", "medium", "high", "xhigh", "max"]);
export type Effort = z.infer<typeof EffortSchema>;

/**
 * A rung's standing under the ladders routing replaced. Kept only so a routing
 * decision recorded under them still parses and reads.
 */
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
 * What a job says about itself (D-P8-01), with every conservative default
 * already filled in. Recorded on each routing decision for the dataset; no
 * longer what picks a route.
 */
export const ClassificationSchema = z.strictObject({
  risk: RiskLevelSchema,
  ambiguity: AmbiguityLevelSchema,
  testability: TestabilitySchema,
  /** Absent when the delegator said nothing. */
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

/** Who a route is chosen for. A sub-program's orchestrator is an `orchestrator`. */
export const RoutingRoleSchema = z.enum(["orchestrator", "implementer", "examiner", "arbiter"]);
export type RoutingRole = z.infer<typeof RoutingRoleSchema>;

export const ROUTING_ROLES: readonly RoutingRole[] = RoutingRoleSchema.options;

/** A role's routes, in preference order: the first that can run is the one that does. */
export const RoleRoutesSchema = z.array(RouteSpecSchema).min(1);
export type RoleRoutes = z.infer<typeof RoleRoutesSchema>;

export const RolePreferencesSchema = z.strictObject({
  orchestrator: RoleRoutesSchema,
  implementer: RoleRoutesSchema,
  examiner: RoleRoutesSchema,
  arbiter: RoleRoutesSchema,
});
export type RolePreferences = z.infer<typeof RolePreferencesSchema>;

/** Dollars per million tokens, for an **estimate** when a harness reports no cost (D-P8-08). */
export const ModelPriceSchema = z.strictObject({
  inputPerMTok: z.number().min(0),
  outputPerMTok: z.number().min(0),
  cacheReadPerMTok: z.number().min(0).optional(),
  cacheWritePerMTok: z.number().min(0).optional(),
});
export type ModelPrice = z.infer<typeof ModelPriceSchema>;

const RolePolicySchema = z.strictObject({
  roles: RolePreferencesSchema,
  /** Routes nobody may start this run (D-P8-06). Matched on harness and model. */
  unavailable: z.array(RouteSpecSchema),
  prices: z.record(z.string().min(1), ModelPriceSchema),
});

// --- The ladders this replaced, read once and never written -------------------------

const LegacyRungSchema = z.object({ tier: TierSchema, routes: z.array(RouteSpecSchema).min(1) });
const LegacyRuleSchema = z.object({
  id: z.string(),
  when: z.object({ kind: z.array(z.string()).optional() }).passthrough(),
  start: z.object({ ladder: z.string(), tier: TierSchema }),
});
const LegacyPolicySchema = z.object({
  ladders: z.record(z.string(), z.array(LegacyRungSchema).min(1)),
  rules: z.array(LegacyRuleSchema).min(1),
  unavailable: z.array(RouteSpecSchema).default([]),
  prices: z.record(z.string(), ModelPriceSchema).default({}),
});
type LegacyPolicy = z.infer<typeof LegacyPolicySchema>;

const pushUnique = (into: RouteSpec[], route: RouteSpec): void => {
  if (!into.some((seen) => sameRoute(seen, route))) into.push(route);
};

/** The ladders' search order from `(ladder, tier)` up: each rung, then that tier on every other ladder. */
const searchOrder = (policy: LegacyPolicy, ladder: string, tier: Tier): RouteSpec[] => {
  const own = policy.ladders[ladder] ?? Object.values(policy.ladders)[0] ?? [];
  const from = Math.max(
    0,
    own.findIndex((rung) => tierRank(rung.tier) >= tierRank(tier)),
  );
  const order: RouteSpec[] = [];
  for (const rung of own.slice(from)) {
    for (const route of rung.routes) pushUnique(order, route);
    for (const route of sameTierElsewhere(policy, ladder, rung.tier)) pushUnique(order, route);
  }
  return order;
};

/** Every route at `tier` on the ladders other than `ladder`, in their order. */
const sameTierElsewhere = (policy: LegacyPolicy, ladder: string, tier: Tier): RouteSpec[] =>
  Object.entries(policy.ladders)
    .filter(([name]) => name !== ladder)
    .flatMap(([, rungs]) => rungs.filter((rung) => rung.tier === tier))
    .flatMap((rung) => rung.routes);

/** Every route, strongest tier first, the ladders interleaved in their order. */
const strongestFirst = (policy: LegacyPolicy): RouteSpec[] => {
  const order: RouteSpec[] = [];
  for (const tier of [...TIER_ORDER].reverse()) {
    for (const rungs of Object.values(policy.ladders)) {
      for (const rung of rungs) {
        if (rung.tier !== tier) continue;
        for (const route of rung.routes) pushUnique(order, route);
      }
    }
  }
  return order;
};

/**
 * The role lists a ladder configuration meant: the orchestrator's rule's search
 * order, the default rule's for the implementer, and every route strongest
 * first for the examiner and the arbiter, who were chosen from the top.
 */
export const rolesFromLadders = (legacy: unknown): z.input<typeof RolePolicySchema> => {
  const policy = LegacyPolicySchema.parse(legacy);
  const fallbackRule = policy.rules.at(-1) as LegacyPolicy["rules"][number];
  const orchestrateRule =
    policy.rules.find((rule) => rule.when.kind?.includes("orchestrate") === true) ?? fallbackRule;
  return {
    roles: {
      orchestrator: searchOrder(policy, orchestrateRule.start.ladder, orchestrateRule.start.tier),
      implementer: searchOrder(policy, fallbackRule.start.ladder, fallbackRule.start.tier),
      examiner: strongestFirst(policy),
      arbiter: strongestFirst(policy),
    },
    unavailable: policy.unavailable,
    prices: policy.prices,
  };
};

const isLegacy = (value: unknown): boolean =>
  typeof value === "object" && value !== null && "ladders" in value && !("roles" in value);

export const RoutingPolicySchema = z.preprocess(
  (value) => (isLegacy(value) ? rolesFromLadders(value) : value),
  RolePolicySchema,
);
export type RoutingPolicy = z.infer<typeof RolePolicySchema>;

/** Whether two route specs name the same harness and model. Effort is not identity. */
export const sameRoute = (
  a: Pick<RouteSpec, "harness" | "model">,
  b: Pick<RouteSpec, "harness" | "model">,
): boolean => a.harness === b.harness && a.model === b.model;

/**
 * What a repository or a program may say about routing (D-P8-03): **only ever
 * less** than the org allows. Keep only some harnesses, forbid some routes.
 * Which providers may run at all is `modelPolicy`'s.
 */
const RoutingNarrowingObjectSchema = z.strictObject({
  /** Keep only routes on these harnesses. */
  harnesses: z.array(z.string().min(1)).min(1).optional(),
  /** Never start these routes, whatever the role. Effort is not matched. */
  forbid: z
    .array(z.strictObject({ harness: z.string().min(1), model: z.string().min(1) }))
    .optional(),
});

/**
 * A narrowing written for the ladders kept the ladders it named, and every
 * ladder was named for its harness, so `ladders` reads as `harnesses`. A
 * `minimumTier` has nothing left to mean and is refused, not dropped: dropping
 * it would widen what the repository asked for.
 */
export const RoutingNarrowingSchema = z.preprocess((value) => {
  if (typeof value !== "object" || value === null || !("ladders" in value)) return value;
  const { ladders, ...rest } = value as { ladders?: unknown } & Record<string, unknown>;
  return { ...rest, harnesses: ladders };
}, RoutingNarrowingObjectSchema);
export type RoutingNarrowing = z.infer<typeof RoutingNarrowingObjectSchema>;

/** The harnesses both keep: absent means every one. */
const keptByBoth = (
  a: readonly string[] | undefined,
  b: readonly string[] | undefined,
): string[] | undefined => {
  if (a === undefined) return b === undefined ? undefined : [...b];
  if (b === undefined) return [...a];
  return a.filter((name) => b.includes(name));
};

/** Two narrowings as one, each keeping everything the other took away. */
export const combineNarrowings = (
  a: RoutingNarrowing | undefined,
  b: RoutingNarrowing | undefined,
): RoutingNarrowing | undefined => {
  if (a === undefined) return b;
  if (b === undefined) return a;
  const harnesses = keptByBoth(a.harnesses, b.harnesses);
  const forbid = [...(a.forbid ?? []), ...(b.forbid ?? [])];
  return {
    ...(harnesses === undefined ? {} : { harnesses }),
    ...(forbid.length === 0 ? {} : { forbid }),
  };
};
