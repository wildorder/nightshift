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
  type JobContract,
  type Ladder,
  type OrgConfig,
  type ProgramContract,
  type RiskLevel,
  type RoutingPolicy,
  type RoutingRule,
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
