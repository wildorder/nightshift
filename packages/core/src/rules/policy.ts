/**
 * The policy a job is routed and examined under (P8, D-P8-01 … D-P8-04).
 *
 * Three pure functions, each the only way its fact is read:
 *
 * - {@link classificationOf}: what a job says about itself, with the
 *   **conservative** default for anything it left unsaid (D-P8-01). Recorded on
 *   each routing decision; since D-RR-01 it no longer picks the route.
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
  type MeasurementSummary,
  type ModelPrice,
  type OrgConfig,
  type ProgramContract,
  type RiskLevel,
  ROUTING_ROLES,
  type RouteSpec,
  type RouteUsage,
  type RoutingDecision,
  type RoutingPolicy,
  type RoutingRole,
  type Run,
  sameRoute,
  stricterExaminationPolicy,
} from "@nightshift/contracts";
import { countersFromRouteUsage } from "../measurement/normalize.js";
import { type AttemptResources, resourcesOf, tokensOf } from "../report/resources.js";

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
  readonly field: "routes";
  readonly detail: string;
}

export type EffectivePolicyResult =
  | { readonly ok: true; readonly policy: EffectivePolicy }
  | { readonly ok: false; readonly widenings: readonly Widening[] };

/**
 * The org's routing and examination, narrowed by `contract` (D-P8-03).
 *
 * Routing: every role keeps its order, less the routes on harnesses the
 * contract does not keep and the routes it forbids (D-RR-01). Examination: the
 * stricter of the two, field by field.
 *
 * Refused, with every reason at once: a narrowing that leaves a role nothing
 * to run on.
 */
export const effectivePolicy = (
  org: Pick<OrgConfig, "routingPolicy" | "examinationPolicy" | "version">,
  contract: Pick<ProgramContract, "routing" | "examinationPolicy">,
): EffectivePolicyResult => {
  const narrowing = contract.routing;
  const forbidden = narrowing?.forbid ?? [];
  const keeps = (route: RouteSpec): boolean =>
    (narrowing?.harnesses === undefined || narrowing.harnesses.includes(route.harness)) &&
    !forbidden.some((banned) => sameRoute(banned, route));

  const widenings: Widening[] = [];
  const roles = {} as Record<RoutingRole, RouteSpec[]>;
  for (const role of ROUTING_ROLES) {
    roles[role] = org.routingPolicy.roles[role].filter(keeps);
    if (roles[role].length === 0) {
      widenings.push({
        field: "routes",
        detail: `the narrowing leaves the ${role} no route at all: every route on its list is on a harness it drops or forbidden`,
      });
    }
  }
  if (widenings.length > 0) return { ok: false, widenings };

  const routingPolicy: RoutingPolicy = {
    roles: roles as RoutingPolicy["roles"],
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
 * Whether a retry after this ending should move down its role's list (D-P8-07,
 * as D-RR-01 keeps it). A
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
  usage: Pick<
    RouteUsage,
    "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens" | "inputIncludesCache"
  >,
  price: ModelPrice | undefined,
): number | undefined => {
  if (price === undefined) return undefined;
  // Inclusive input already contains the cache tokens: price only the remainder
  // at the input rate, so cached input is not charged twice.
  const input =
    usage.inputIncludesCache === true && usage.inputTokens !== undefined
      ? Math.max(
          0,
          usage.inputTokens - (usage.cacheReadTokens ?? 0) - (usage.cacheWriteTokens ?? 0),
        )
      : usage.inputTokens;
  const perToken = (perMillion: number | undefined, tokens: number | undefined): number =>
    ((perMillion ?? 0) * (tokens ?? 0)) / 1_000_000;
  return (
    perToken(price.inputPerMTok, input) +
    perToken(price.outputPerMTok, usage.outputTokens) +
    perToken(price.cacheReadPerMTok ?? price.inputPerMTok, usage.cacheReadTokens) +
    perToken(price.cacheWritePerMTok ?? price.inputPerMTok, usage.cacheWriteTokens)
  );
};

const hasCounters = (usage: RouteUsage): boolean =>
  usage.inputTokens !== undefined ||
  usage.outputTokens !== undefined ||
  usage.cacheReadTokens !== undefined ||
  usage.cacheWriteTokens !== undefined;

/**
 * Usage with its dollars labelled (D-P8-08): what the harness reported, else an
 * estimate from the price table, else nothing, and `costSource` says which.
 */
export const labelCost = (usage: RouteUsage, price: ModelPrice | undefined): RouteUsage => {
  if (usage.actualCostUsd !== undefined) return { ...usage, costSource: "reported" };
  // Missing counters are not a known zero: nothing was measured, so nothing is estimated.
  if (!hasCounters(usage)) return { ...usage, costSource: "unknown" };
  const estimate = estimateCost(usage, price);
  return estimate === undefined
    ? { ...usage, costSource: "unknown" }
    : { ...usage, estimatedCostUsd: estimate, costSource: "estimated" };
};

/** What a spend leaves unknown. Complete means every attempt was measured, priced and fully valued. */
export interface SpendEvaluation {
  readonly complete: boolean;
  /** Attempts with token counters but no dollar figure: $0 here is not known to be free. */
  readonly unpriced: number;
  /** Attempts with neither counters nor dollars: nothing was measured. */
  readonly unmeasured: number;
  /** Summary valuations that leave some usage unvalued, so the estimate understates. */
  readonly estimateIncomplete: number;
}

/**
 * What a run has spent (D-P8-08, D-02). Tokens are input (normalized to include
 * cache where the convention is known) plus output, as reports show them. The
 * dollars are the figures known; `evaluation` says what they leave out.
 */
export interface Spend {
  readonly usd: number;
  readonly tokens: number;
  /** True when any dollar figure in `usd` is an estimate. */
  readonly estimated: boolean;
  /** Usages with neither a dollar figure nor any token counter: unmeasured, not free. */
  readonly unknown: number;
  readonly evaluation: SpendEvaluation;
}

const evaluationOf = (
  unpriced: number,
  unmeasured: number,
  estimateIncomplete: number,
): SpendEvaluation => ({
  complete: unpriced === 0 && unmeasured === 0 && estimateIncomplete === 0,
  unpriced,
  unmeasured,
  estimateIncomplete,
});

const spendOfAttempts = (items: readonly AttemptResources[]): Spend => {
  let usd = 0;
  let tokens = 0;
  let estimated = false;
  let unpriced = 0;
  let unmeasured = 0;
  let estimateIncomplete = 0;
  for (const item of items) {
    const { reported, estimated: estimate } = item.usd;
    // One figure per attempt, reported preferred: never both.
    usd += reported ?? estimate ?? 0;
    if (reported === undefined && estimate !== undefined) estimated = true;
    tokens += (item.tokens.input ?? 0) + (item.tokens.output ?? 0);
    if (item.estimateIncomplete === true) estimateIncomplete += 1;
    if (reported === undefined && estimate === undefined) {
      const counted =
        item.tokens.input !== undefined ||
        item.tokens.output !== undefined ||
        item.tokens.cacheRead !== undefined ||
        item.tokens.cacheWrite !== undefined;
      if (counted) unpriced += 1;
      else unmeasured += 1;
    }
  }
  return {
    usd,
    tokens,
    estimated,
    unknown: unmeasured,
    evaluation: evaluationOf(unpriced, unmeasured, estimateIncomplete),
  };
};

/** Spend from routing usages alone, with the token definition reports use. */
export const spendOf = (usages: readonly RouteUsage[]): Spend =>
  spendOfAttempts(
    usages.map((usage) => ({
      tokens: tokensOf(countersFromRouteUsage(usage)),
      usd: {
        ...(usage.estimatedCostUsd === undefined ? {} : { estimated: usage.estimatedCostUsd }),
        ...(usage.actualCostUsd === undefined ? {} : { reported: usage.actualCostUsd }),
        source: usage.costSource ?? "none",
      },
      coverage: hasCounters(usage) ? "legacy" : "missing",
    })),
  );

/**
 * Spend from a run's routing decisions and measurement summaries: the same
 * per-route resources, and so the same totals, the report shows.
 */
export const spendOfRun = (input: {
  readonly routes: readonly RoutingDecision[];
  readonly measurements: readonly MeasurementSummary[];
}): Spend => spendOfAttempts(input.routes.map((route) => resourcesOf(route, input.measurements)));

/**
 * What a budget evaluation leaves out, for reporting. `configured` is whether
 * any limit is set; an incomplete evaluation is never a certificate of "within budget".
 */
export const budgetEvaluation = (
  spend: Spend,
  costPolicy: Pick<ProgramContract["costPolicy"], "maxUsd" | "maxTokens">,
): SpendEvaluation & { readonly configured: boolean } => ({
  configured: costPolicy.maxUsd !== undefined || costPolicy.maxTokens !== undefined,
  ...spend.evaluation,
});

/**
 * Which budget, if any, `spend` has used up (D-P8-08). A limit is enforced on
 * what is known; `evaluation` says whether that was everything.
 */
export const budgetSpent = (
  spend: Spend,
  costPolicy: Pick<ProgramContract["costPolicy"], "maxUsd" | "maxTokens">,
):
  | {
      readonly budget: "maxUsd" | "maxTokens";
      readonly limit: number;
      readonly spent: number;
      readonly evaluation: SpendEvaluation;
    }
  | undefined => {
  if (costPolicy.maxUsd !== undefined && spend.usd >= costPolicy.maxUsd) {
    return {
      budget: "maxUsd",
      limit: costPolicy.maxUsd,
      spent: spend.usd,
      evaluation: spend.evaluation,
    };
  }
  if (costPolicy.maxTokens !== undefined && spend.tokens >= costPolicy.maxTokens) {
    return {
      budget: "maxTokens",
      limit: costPolicy.maxTokens,
      spent: spend.tokens,
      evaluation: spend.evaluation,
    };
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
