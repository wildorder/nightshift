/**
 * The policy a job is routed and examined under (P8, D-P8-01 … D-P8-04).
 *
 * Three pure functions, each the only way its fact is read:
 *
 * - {@link classificationOf}: what a job says about itself, with the
 *   **conservative** default for anything it left unsaid, so an unclassified job
 *   never lands on the cheapest rung by accident (D-P8-01).
 * - {@link effectivePolicy}: the org's routing and examination policy, narrowed
 *   by the program's contract (which already carries its repository's narrowing,
 *   `inheritFromConfig`). Narrowing can only take away; anything that would add
 *   is a **widening**, refused by name (D-P8-03).
 * - {@link examinationRequirementFor}: what the effective policy demands of a
 *   job at its risk.
 *
 * `modelPolicy` is not applied here: which provider a harness belongs to is the
 * compatibility table's, in `packages/routing`, and routing intersects it with
 * whatever this leaves.
 */
import {
  type Classification,
  type EffectivePolicy,
  type ExaminationPolicy,
  type ExaminationRequirement,
  type ExecutionNode,
  type JobContract,
  type Ladder,
  type ModelPrice,
  type OrgConfig,
  type ProgramContract,
  type RiskLevel,
  type RouteUsage,
  type RoutingPolicy,
  type RoutingRule,
  type Run,
  sameRoute,
  stricterExaminationPolicy,
  type Tier,
  tierRank,
} from "@nightshift/contracts";

/**
 * A job's classification, defaults filled (D-P8-01): risk as stated (a Job
 * Contract always states it), ambiguity as stated, testability `weak` when
 * unsaid, kind absent when unsaid.
 */
export const classificationOf = (
  job: Pick<JobContract, "risk" | "ambiguity" | "testability" | "kind">,
): Classification => ({
  risk: job.risk,
  ambiguity: job.ambiguity,
  testability: job.testability ?? "weak",
  ...(job.kind === undefined ? {} : { kind: job.kind }),
});

/** The conservative defaults for a delegation that states nothing (D-P8-01). */
export const conservativeDefaults = (
  program: Pick<ProgramContract, "defaultRisk">,
): { readonly risk: RiskLevel; readonly ambiguity: RiskLevel } => ({
  risk: program.defaultRisk,
  ambiguity: "medium",
});

/** A refusal to widen, naming what was asked for. */
export interface Widening {
  readonly field: "ladders" | "routes";
  readonly detail: string;
}

export type EffectivePolicyResult =
  | { readonly ok: true; readonly policy: EffectivePolicy }
  | { readonly ok: false; readonly widenings: readonly Widening[] };

/** A rule with its start raised to `minimum`, if it starts below it. */
const raiseStart = (rule: RoutingRule, minimum: Tier | undefined): RoutingRule =>
  minimum === undefined || tierRank(rule.start.tier) >= tierRank(minimum)
    ? rule
    : { ...rule, start: { ...rule.start, tier: minimum } };

/**
 * The org's routing and examination, narrowed by `contract` (D-P8-03).
 *
 * Routing: keep the ladders the contract keeps, drop the routes it forbids and
 * any rung or ladder left empty, and raise every rule's starting tier to the
 * contract's minimum. A rule whose ladder was dropped starts on the first ladder
 * left, at the same tier. Examination: the stricter of the two, field by field.
 *
 * Refused, with every reason at once: a ladder the org does not have, or a
 * narrowing that leaves no route at all.
 */
export const effectivePolicy = (
  org: Pick<OrgConfig, "routingPolicy" | "examinationPolicy" | "version">,
  contract: Pick<ProgramContract, "routing" | "examinationPolicy">,
): EffectivePolicyResult => {
  const narrowing = contract.routing;
  const widenings: Widening[] = [];
  const orgLadders = Object.keys(org.routingPolicy.ladders);

  for (const name of narrowing?.ladders ?? []) {
    if (!orgLadders.includes(name)) {
      widenings.push({
        field: "ladders",
        detail: `ladder "${name}" is not one the org has (${orgLadders.join(", ")}); a program may only keep the org's ladders, not add one`,
      });
    }
  }

  const kept =
    narrowing?.ladders === undefined
      ? orgLadders
      : orgLadders.filter((name) => narrowing.ladders?.includes(name));
  const forbidden = narrowing?.forbid ?? [];
  const ladders: Record<string, Ladder> = {};
  for (const name of kept) {
    const rungs = (org.routingPolicy.ladders[name] ?? [])
      .map((rung) => ({
        ...rung,
        routes: rung.routes.filter(
          (route) => !forbidden.some((banned) => sameRoute(banned, route)),
        ),
      }))
      .filter((rung) => rung.routes.length > 0);
    if (rungs.length > 0) ladders[name] = rungs as Ladder;
  }

  const remaining = Object.keys(ladders);
  if (remaining.length === 0) {
    widenings.push({
      field: "routes",
      detail:
        "the narrowing leaves no route at all: every ladder was dropped or every route on it forbidden",
    });
  }
  if (widenings.length > 0) return { ok: false, widenings };

  const first = remaining[0] as string;
  const rules = org.routingPolicy.rules.map((rule) => {
    const onKeptLadder: RoutingRule =
      ladders[rule.start.ladder] === undefined
        ? { ...rule, start: { ...rule.start, ladder: first } }
        : rule;
    return raiseStart(onKeptLadder, narrowing?.minimumTier);
  });

  const routingPolicy: RoutingPolicy = {
    ladders,
    rules,
    unavailable: org.routingPolicy.unavailable,
    prices: org.routingPolicy.prices,
  };
  return {
    ok: true,
    policy: {
      routingPolicy,
      examinationPolicy: stricterExaminationPolicy(
        org.examinationPolicy,
        contract.examinationPolicy,
      ),
      orgConfigVersion: org.version,
    },
  };
};

/** Thrown where an effective policy is required and the narrowing widened. */
export class PolicyWideningError extends Error {
  constructor(readonly widenings: readonly Widening[]) {
    super(
      `the program's routing narrows its org's policy illegally: ${widenings.map((w) => w.detail).join("; ")}`,
    );
    this.name = "PolicyWideningError";
  }
}

/** {@link effectivePolicy}, throwing {@link PolicyWideningError} on a widening. */
export const requireEffectivePolicy = (
  ...args: Parameters<typeof effectivePolicy>
): EffectivePolicy => {
  const result = effectivePolicy(...args);
  if (!result.ok) throw new PolicyWideningError(result.widenings);
  return result.policy;
};

/** What examination the policy demands of a job at `risk`. */
export const examinationRequirementFor = (
  policy: ExaminationPolicy,
  risk: RiskLevel,
): ExaminationRequirement => policy[risk];

/**
 * Whether a retry after this ending should climb a rung (D-P8-07). A
 * verification, examination or worker failure says something about the model;
 * a merge conflict, a stale base, an interrupt or an unavailable route says
 * nothing about it, and the retry keeps the route.
 */
export const failureClimbs = (node: Pick<ExecutionNode, "status" | "outcomeReason">): boolean => {
  switch (node.status) {
    case "verification_failed":
      return true;
    case "examination_failed":
    case "failed": {
      const reason = node.outcomeReason ?? "";
      return !NO_CLIMB_REASON_PREFIXES.some((prefix) => reason.startsWith(prefix));
    }
    default:
      return false;
  }
};

/**
 * The `outcomeReason` prefixes of a failure that is not the model's: the merge
 * queue's conflict and stale base (P6), and a route that could not start (P8).
 */
export const NO_CLIMB_REASON_PREFIXES: readonly string[] = [
  "integration_conflict:",
  "stale_base:",
  "route_unavailable:",
  // No examiner could be had, or it gave no verdict: nothing was learnt of the work.
  "examiner_failed:",
];

/**
 * A dollar estimate from token counts and a price table (D-P8-08). `undefined`
 * when the table has no price for the model: an estimate from nothing is not an
 * estimate.
 */
export const estimateCost = (
  usage: Pick<RouteUsage, "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens">,
  price: ModelPrice | undefined,
): number | undefined => {
  if (price === undefined) return undefined;
  const perToken = (perMillion: number | undefined, tokens: number | undefined): number =>
    ((perMillion ?? 0) * (tokens ?? 0)) / 1_000_000;
  return (
    perToken(price.inputPerMTok, usage.inputTokens) +
    perToken(price.outputPerMTok, usage.outputTokens) +
    perToken(price.cacheReadPerMTok ?? price.inputPerMTok, usage.cacheReadTokens) +
    perToken(price.cacheWritePerMTok ?? price.inputPerMTok, usage.cacheWriteTokens)
  );
};

/**
 * Usage with its dollars labelled (D-P8-08): what the harness reported, else an
 * estimate from the price table, else nothing, and `costSource` says which.
 */
export const labelCost = (usage: RouteUsage, price: ModelPrice | undefined): RouteUsage => {
  if (usage.actualCostUsd !== undefined) return { ...usage, costSource: "reported" };
  const estimate = estimateCost(usage, price);
  return estimate === undefined
    ? { ...usage, costSource: "unknown" }
    : { ...usage, estimatedCostUsd: estimate, costSource: "estimated" };
};

/** What a run has spent, from its routing decisions (D-P8-08). Tokens are input plus output. */
export interface Spend {
  readonly usd: number;
  readonly tokens: number;
  /** True when any dollar figure in `usd` is an estimate. */
  readonly estimated: boolean;
}

export const spendOf = (usages: readonly RouteUsage[]): Spend =>
  usages.reduce<Spend>(
    (total, usage) => ({
      usd: total.usd + (usage.actualCostUsd ?? usage.estimatedCostUsd ?? 0),
      tokens: total.tokens + (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
      estimated:
        total.estimated ||
        (usage.actualCostUsd === undefined && usage.estimatedCostUsd !== undefined),
    }),
    { usd: 0, tokens: 0, estimated: false },
  );

/** Which budget, if any, `spend` has used up (D-P8-08). */
export const budgetSpent = (
  spend: Spend,
  costPolicy: Pick<ProgramContract["costPolicy"], "maxUsd" | "maxTokens">,
):
  | { readonly budget: "maxUsd" | "maxTokens"; readonly limit: number; readonly spent: number }
  | undefined => {
  if (costPolicy.maxUsd !== undefined && spend.usd >= costPolicy.maxUsd) {
    return { budget: "maxUsd", limit: costPolicy.maxUsd, spent: spend.usd };
  }
  if (costPolicy.maxTokens !== undefined && spend.tokens >= costPolicy.maxTokens) {
    return { budget: "maxTokens", limit: costPolicy.maxTokens, spent: spend.tokens };
  }
  return undefined;
};

/**
 * The policy a run executes under: what it recorded when it started (D-P8-03),
 * or, for a run started before P8, the seeded org default narrowed by its
 * contract, which is what it would have recorded.
 */
export const policyOfRun = (
  run: Pick<Run, "policy">,
  program: Pick<ProgramContract, "routing" | "examinationPolicy">,
  seeded: Pick<OrgConfig, "routingPolicy" | "examinationPolicy" | "version">,
): EffectivePolicy => run.policy ?? requireEffectivePolicy(seeded, program);
