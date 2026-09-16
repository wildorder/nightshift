/**
 * The one routing rule P3 has (D-P3-08).
 *
 * It chooses the Claude Code adapter and a model the Program Contract's policy
 * allows. That is all it does, and it is deliberately not interesting — P6
 * replaces the rule, and what it replaces is a *rule*, not a record.
 *
 * ## Why a rule this simple still records everything
 *
 * A `RoutingDecision` is written for every job from the very first one, with
 * every option considered, whether it was eligible, and why not when it was not.
 * The dataset learned routing trains on (A-13) starts with the first job, not
 * with P6, and a dataset that only begins when somebody builds the learner is a
 * dataset with no history. So the record is complete now, while the rule is
 * trivial, rather than being backfilled later from nothing.
 *
 * An orchestrator may pin a model. That is honoured when the policy allows it
 * and recorded as `wasOverride: true` — the difference between "policy chose
 * this" and "a human asked for this" is exactly what a later analysis needs.
 */
import type {
  JobContract,
  ModelPolicy,
  ProgramContract,
  RouteChoice,
  RouteOption,
  RouteTarget,
} from "@nightshift/contracts";

/** The adapter P3 has. P4 adds Codex and AgentCore; this is not a list to grow here. */
export const P3_HARNESS = "claude";
export const P3_PROVIDER = "anthropic";

/** The rule's identifier, recorded on every decision it makes. */
export const FIXED_RULE_ID = "p3-fixed";

/**
 * The model used when a Program Contract's policy names none.
 *
 * `allowedModels: []` means "any model offered by an allowed provider", which is
 * a policy statement, not a choice — something still has to pick one. This is
 * that pick, and it is here rather than in the adapter on purpose: the adapter
 * passes through whatever routing chose and maintains no list of its own
 * (T8), and the authoritative list of what a program *may* use is its policy.
 */
export const DEFAULT_MODEL = "claude-sonnet-5";

export type RoutingRefusalCode = "model_forbidden" | "provider_not_allowed" | "no_eligible_model";

/**
 * Routing could not choose. Typed, because an orchestrator that pinned a model
 * the policy forbids needs to know that rather than see a generic failure.
 */
export class RoutingRefusedError extends Error {
  override readonly name = "RoutingRefusedError";

  constructor(
    readonly code: RoutingRefusalCode,
    message: string,
    /** Every option considered, so the refusal explains itself. */
    readonly eligibleOptions: readonly RouteOption[],
  ) {
    super(message);
  }
}

const targetFor = (model: string): RouteTarget => ({
  harness: P3_HARNESS,
  provider: P3_PROVIDER,
  model,
});

/** Why a model is not eligible under `policy`, or `undefined` when it is. */
const ineligibility = (policy: ModelPolicy, model: string): string | undefined => {
  // Forbidden always wins over allowed, on both lists.
  if (policy.forbiddenModels.includes(model)) {
    return `the program's modelPolicy forbids "${model}"`;
  }
  if (policy.allowedModels.length > 0 && !policy.allowedModels.includes(model)) {
    return `the program's modelPolicy allows only [${policy.allowedModels.join(", ")}]`;
  }
  return undefined;
};

/**
 * The models this rule considers, in preference order.
 *
 * The policy's own list when it has one, because a program that named its models
 * meant them; otherwise the single documented default. An override is considered
 * first, so it appears in the record even when it turns out to be ineligible.
 */
const candidates = (policy: ModelPolicy, override: string | undefined): readonly string[] => {
  const fromPolicy = policy.allowedModels.length > 0 ? policy.allowedModels : [DEFAULT_MODEL];
  return override === undefined || fromPolicy.includes(override)
    ? fromPolicy
    : [override, ...fromPolicy];
};

export interface FixedRouteInput {
  readonly program: ProgramContract;
  readonly job: JobContract;
  /** A model the orchestrator pinned, if it pinned one. */
  readonly override?: string | undefined;
}

/**
 * Chooses a harness, a provider and a model, and explains the choice.
 *
 * Throws {@link RoutingRefusedError} when nothing is eligible, rather than
 * quietly falling back to something the policy did not sanction: a program that
 * forbids a model and gets it anyway has had its contract ignored.
 */
export const fixedRoute = (input: FixedRouteInput): RouteChoice => {
  const policy = input.program.modelPolicy;

  if (!policy.allowedProviders.includes(P3_PROVIDER)) {
    const options: readonly RouteOption[] = [
      {
        target: targetFor(input.override ?? DEFAULT_MODEL),
        eligible: false,
        reason: `the program's modelPolicy allows providers [${policy.allowedProviders.join(", ")}], and P3 has only the ${P3_PROVIDER} adapter`,
      },
    ];
    throw new RoutingRefusedError(
      "provider_not_allowed",
      `this program allows no provider P3 can route to. Allowed: [${policy.allowedProviders.join(", ")}]; available: ${P3_PROVIDER}. A second adapter arrives in P4.`,
      options,
    );
  }

  const considered = candidates(policy, input.override);
  const options: RouteOption[] = considered.map((model) => {
    const reason = ineligibility(policy, model);
    return reason === undefined
      ? { target: targetFor(model), eligible: true }
      : { target: targetFor(model), eligible: false, reason };
  });

  // An override the policy forbids is refused rather than silently replaced. The
  // orchestrator asked for something specific and is entitled to know it was not
  // available, rather than discovering later that a different model ran.
  if (input.override !== undefined) {
    const chosen = options.find((option) => option.target.model === input.override);
    if (chosen?.eligible !== true) {
      throw new RoutingRefusedError(
        "model_forbidden",
        `the orchestrator pinned "${input.override}", which this program does not allow: ${chosen?.reason ?? "no such option"}`,
        options,
      );
    }
    return {
      target: chosen.target,
      eligibleOptions: options,
      ruleId: FIXED_RULE_ID,
      wasOverride: true,
    };
  }

  const first = options.find((option) => option.eligible);
  if (first === undefined) {
    throw new RoutingRefusedError(
      "no_eligible_model",
      `no model is both allowed and not forbidden by this program's modelPolicy: allowed [${policy.allowedModels.join(", ")}], forbidden [${policy.forbiddenModels.join(", ")}]`,
      options,
    );
  }

  return {
    target: first.target,
    eligibleOptions: options,
    ruleId: FIXED_RULE_ID,
    wasOverride: false,
  };
};
