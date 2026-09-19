/**
 * Routing, P5: harness choice is configuration (D-P5-04, D-P5-05, SC-P5-16).
 *
 * P3's rule was fixed: one harness, one provider. This one is still not
 * *reasoning* — no cost, no capability, no history; that is P7 — but it chooses
 * among real alternatives, by intersecting two things and nothing else:
 *
 * - the **Program Contract's model policy**: which providers and models this
 *   program permits, in the order its author listed them; and
 * - the **compatibility table**: which harness can run which provider's models.
 *
 * The first compatible, permitted `(harness, provider, model)` in the policy's
 * provider order wins. An orchestrator may pin `harness`, `model` or both on
 * `delegate`; a pin is honoured **within the intersection**, recorded as an
 * override, and refused with a typed reason when it falls outside. The human
 * picks the orchestrator's model; Nightshift picks the workers' (D-P5-05), and
 * this is where.
 *
 * Every option considered is recorded, eligible or not, each refusal with its
 * reason (A-13): the decision is evidence, written before the work it routes.
 */
import type {
  JobContract,
  ModelPolicy,
  ProgramContract,
  RouteChoice,
  RouteOption,
  RouteTarget,
} from "@nightshift/contracts";
import {
  type CompatibleProvider,
  canRunModel,
  compatiblePairs,
  KNOWN_HARNESSES,
} from "./compatibility.js";

export const CONFIGURED_RULE_ID = "p5-configured";

export type RoutingRefusalCode =
  /** The pinned model is on the policy's forbidden list, or off its allowed one. */
  | "model_forbidden"
  /** No provider the policy allows can be routed to at all. */
  | "provider_not_allowed"
  /** The pinned harness is not one the table knows. */
  | "harness_unknown"
  /** The table says the pinned harness cannot run the pinned or permitted models. */
  | "harness_model_incompatible"
  /** The only compatible pairs belong to a later program. */
  | "route_not_yet_available"
  /** The policy and the table intersect in nothing. */
  | "no_eligible_route";

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

export interface RouteOverride {
  readonly harness?: string | undefined;
  readonly model?: string | undefined;
}

export interface ConfiguredRouteInput {
  readonly program: ProgramContract;
  readonly job: JobContract;
  /** What the orchestrator pinned on `delegate`, if anything. */
  readonly override?: RouteOverride | undefined;
}

const modelIneligibility = (policy: ModelPolicy, model: string): string | undefined => {
  // Forbidden always wins over allowed.
  if (policy.forbiddenModels.includes(model)) {
    return `the program's modelPolicy forbids "${model}"`;
  }
  if (policy.allowedModels.length > 0 && !policy.allowedModels.includes(model)) {
    return `the program's modelPolicy allows only [${policy.allowedModels.join(", ")}]`;
  }
  return undefined;
};

/**
 * The models to consider for one `(harness, provider)` pair: the policy's own
 * that the pair can run, in policy order; the pair's default when the policy
 * names none; and a pinned model first, so a refusal of it is on the record.
 */
const modelsFor = (
  policy: ModelPolicy,
  pair: CompatibleProvider,
  pinned: string | undefined,
): readonly string[] => {
  const fromPolicy =
    policy.allowedModels.length > 0
      ? policy.allowedModels.filter((model) => canRunModel(pair, model))
      : pair.defaultModel === undefined
        ? []
        : [pair.defaultModel];
  if (pinned === undefined || fromPolicy.includes(pinned)) return fromPolicy;
  return canRunModel(pair, pinned) ? [pinned, ...fromPolicy] : fromPolicy;
};

export const configuredRoute = (input: ConfiguredRouteInput): RouteChoice => {
  const policy = input.program.modelPolicy;
  const pinnedHarness = input.override?.harness;
  const pinnedModel = input.override?.model;
  const wasOverride = pinnedHarness !== undefined || pinnedModel !== undefined;

  if (pinnedHarness !== undefined && !KNOWN_HARNESSES.includes(pinnedHarness)) {
    throw new RoutingRefusedError(
      "harness_unknown",
      `"${pinnedHarness}" is not a harness Nightshift knows. Known: [${KNOWN_HARNESSES.join(", ")}].`,
      [],
    );
  }

  // Policy order first, then table order within a provider: the program's author
  // said which provider they prefer, and the table has no opinion.
  const pairs = policy.allowedProviders.flatMap((provider) =>
    compatiblePairs().filter((pair) => pair.provider === provider),
  );

  const pins: RouteOverride = { harness: pinnedHarness, model: pinnedModel };
  const options: RouteOption[] = pairs.flatMap((pair) =>
    modelsFor(policy, pair, pinnedModel).map((model): RouteOption => {
      const target: RouteTarget = { harness: pair.harness, provider: pair.provider, model };
      const reason = optionIneligibility(policy, pair, model, pins);
      return reason === undefined
        ? { target, eligible: true }
        : { target, eligible: false, reason };
    }),
  );

  const chosen = options.find((option) => option.eligible);
  if (chosen !== undefined) {
    return {
      target: chosen.target,
      eligibleOptions: options,
      ruleId: CONFIGURED_RULE_ID,
      wasOverride,
    };
  }

  throw refusal(policy, pairs, options, pinnedHarness, pinnedModel);
};

type Pair = CompatibleProvider & { readonly harness: string };

/** Why one `(pair, model)` is not the choice, or `undefined` when it could be. */
const optionIneligibility = (
  policy: ModelPolicy,
  pair: Pair,
  model: string,
  pins: RouteOverride,
): string | undefined => {
  const byPolicy = modelIneligibility(policy, model);
  if (byPolicy !== undefined) return byPolicy;
  if (pair.availableFrom !== undefined) {
    return `${pair.harness} on ${pair.provider} arrives in ${pair.availableFrom}`;
  }
  if (pins.harness !== undefined && pair.harness !== pins.harness) {
    return `the orchestrator pinned the ${pins.harness} harness`;
  }
  if (pins.model !== undefined && model !== pins.model) {
    return `the orchestrator pinned "${pins.model}"`;
  }
  return undefined;
};

/** The most specific true thing to say about why nothing was eligible. */
const refusal = (
  policy: ModelPolicy,
  pairs: readonly Pair[],
  options: readonly RouteOption[],
  pinnedHarness: string | undefined,
  pinnedModel: string | undefined,
): RoutingRefusedError => {
  const allowed = `[${policy.allowedProviders.join(", ")}]`;

  if (pairs.length === 0) {
    return new RoutingRefusedError(
      "provider_not_allowed",
      `this program allows providers ${allowed}, and no harness Nightshift has runs any of them.`,
      options,
    );
  }

  if (pinnedModel !== undefined) {
    const because = modelIneligibility(policy, pinnedModel);
    if (because !== undefined) {
      return new RoutingRefusedError(
        "model_forbidden",
        `"${pinnedModel}" was requested, and ${because}.`,
        options.length > 0
          ? options
          : [{ target: targetOf(pairs[0], pinnedModel), eligible: false, reason: because }],
      );
    }
  }

  const byHarness =
    pinnedHarness === undefined
      ? undefined
      : pinnedHarnessRefusal(policy, pairs, options, pinnedHarness, pinnedModel);
  if (byHarness !== undefined) return byHarness;

  return unpinnedRefusal(policy, pairs, options, pinnedModel);
};

/** Why a pinned harness could not be honoured, when that is the reason. */
const pinnedHarnessRefusal = (
  policy: ModelPolicy,
  pairs: readonly Pair[],
  options: readonly RouteOption[],
  pinnedHarness: string,
  pinnedModel: string | undefined,
): RoutingRefusedError | undefined => {
  const allowed = `[${policy.allowedProviders.join(", ")}]`;
  {
    const own = pairs.filter((pair) => pair.harness === pinnedHarness);
    if (own.length === 0) {
      return new RoutingRefusedError(
        "provider_not_allowed",
        `the ${pinnedHarness} harness was requested, and this program allows none of the providers it runs. Allowed: ${allowed}.`,
        options,
      );
    }
    if (pinnedModel !== undefined && !own.some((pair) => canRunModel(pair, pinnedModel))) {
      return new RoutingRefusedError(
        "harness_model_incompatible",
        `the ${pinnedHarness} harness cannot run "${pinnedModel}". It runs: ${own
          .map((pair) => `${pair.provider} [${pair.models.join(", ")}]`)
          .join("; ")}.`,
        options.length > 0
          ? options
          : [
              {
                target: targetOf(own[0], pinnedModel),
                eligible: false,
                reason: `the ${pinnedHarness} harness cannot run "${pinnedModel}"`,
              },
            ],
      );
    }
    if (options.every((option) => option.target.harness !== pinnedHarness)) {
      return new RoutingRefusedError(
        "harness_model_incompatible",
        `the ${pinnedHarness} harness cannot run any model this program allows: [${policy.allowedModels.join(", ")}].`,
        options,
      );
    }
  }
  return undefined;
};

/** The refusals that do not turn on a pinned harness. */
const unpinnedRefusal = (
  policy: ModelPolicy,
  pairs: readonly Pair[],
  options: readonly RouteOption[],
  pinnedModel: string | undefined,
): RoutingRefusedError => {
  const allowed = `[${policy.allowedProviders.join(", ")}]`;

  if (pinnedModel !== undefined && !pairs.some((pair) => canRunModel(pair, pinnedModel))) {
    return new RoutingRefusedError(
      "harness_model_incompatible",
      `no harness that runs an allowed provider ${allowed} can run "${pinnedModel}".`,
      options,
    );
  }

  const usable = pairs.filter((pair) => pair.availableFrom === undefined);
  if (usable.length === 0) {
    const arrives = [...new Set(pairs.map((pair) => pair.availableFrom))].join(", ");
    return new RoutingRefusedError(
      "route_not_yet_available",
      `this program allows providers ${allowed}, and routing to them arrives in ${arrives}.`,
      options,
    );
  }

  return new RoutingRefusedError(
    "no_eligible_route",
    `no model in this program's policy can be routed: ${
      options.length === 0
        ? "no allowed model is one an allowed provider's harness can run"
        : options.map((option) => `${option.target.model}: ${option.reason ?? ""}`).join("; ")
    }.`,
    options,
  );
};

const targetOf = (pair: Pair | undefined, model: string): RouteTarget => ({
  harness: pair?.harness ?? "unknown",
  provider: pair?.provider ?? "unknown",
  model,
});
