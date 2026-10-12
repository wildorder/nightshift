/**
 * Who examines and who arbitrates (P8, D-P8-10, D-P8-13; by role since D-RR-01).
 *
 * Both come from their role's list in the org's policy, by the same eligibility
 * as any route (the compatibility table, the program's model policy, what is
 * unavailable now), and then by what independence asks:
 *
 * - An **examiner** is the first route on the examiner's list that runs a
 *   different model from the implementer when the policy says
 *   `mustDifferModel`, and another provider when it says `mustDifferProvider`.
 *   When usage limits leave none independent enough and the policy says
 *   `strongest`, it is simply the first route on the list that can run.
 * - An **arbiter** is the first route on the arbiter's list whose model
 *   neither side used, and the first that can run when every one is a side's:
 *   a fresh invocation either way, never either side's agent. The report counts
 *   how often an arbiter agrees with the side whose model it shares.
 *
 * Deterministic like the rest of routing: the same inputs, the same choice.
 */
import type {
  ModelPolicy,
  RouteChoice,
  RouteSpec,
  RouteTarget,
  RoutingPolicy,
} from "@nightshift/contracts";
import { candidatesFor, firstEligible } from "./roles.js";

export interface HelperRouteInput {
  readonly policy: RoutingPolicy;
  readonly policyVersion: number;
  readonly modelPolicy: ModelPolicy;
  readonly unavailable?: readonly Pick<RouteSpec, "harness" | "model">[] | undefined;
}

/** The examiner's route (D-P8-10): the first independent enough route on its list. */
export const examinerRoute = (
  input: HelperRouteInput & {
    readonly implementer: RouteTarget;
    readonly mustDifferModel: boolean;
    readonly mustDifferProvider: boolean;
  },
): RouteChoice =>
  firstEligible(
    { ...input, role: "examiner" },
    "examiner",
    candidatesFor(input, "examiner"),
    (_candidate, target) => {
      if (input.mustDifferModel && target.model === input.implementer.model) {
        return `the policy requires a different model from the implementer's ${input.implementer.model}`;
      }
      if (input.mustDifferProvider && target.provider === input.implementer.provider) {
        return `the policy requires a different provider from the implementer's ${input.implementer.provider}`;
      }
      return undefined;
    },
  );

/**
 * The examiner when the independent ones are limited and the policy says
 * `strongest` (D-P8-10, as amended 2026-10-12): the first route on the
 * examiner's list that can run now, whatever built the work.
 */
export const strongestExaminerRoute = (
  input: HelperRouteInput & { readonly implementer: RouteTarget },
): RouteChoice =>
  firstEligible(
    { ...input, role: "examiner" },
    "examiner-strongest",
    candidatesFor(input, "examiner"),
  );

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
 * The arbiter's route (D-P8-13): the arbiter's list, a model neither side used
 * first, then the rest in their order.
 */
export const arbiterRoute = (
  input: HelperRouteInput & { readonly implementer: RouteTarget; readonly examiner: RouteTarget },
): RouteChoice => {
  const list = candidatesFor(input, "arbiter");
  const neither = list.filter(
    (candidate) => arbiterSharesModelWith(candidate.route, input) === undefined,
  );
  const sides = list.filter(
    (candidate) => arbiterSharesModelWith(candidate.route, input) !== undefined,
  );
  return firstEligible({ ...input, role: "arbiter" }, "arbiter", [...neither, ...sides]);
};
