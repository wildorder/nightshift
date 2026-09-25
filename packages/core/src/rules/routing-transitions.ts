/**
 * What may change on a `RoutingDecision` after it is written (P5, D-P5-06).
 *
 * A routing decision is recorded **before** the work it routes (A-13), so the
 * two things only the work can supply are not known when it is written: what it
 * cost, and how it ended. P3 wrote `usage: {}` and `outcome: "pending"` and had
 * no rule for filling them in, so the API's create-or-confirm refused the update
 * and every decision stayed `pending` forever.
 *
 * The rule is as narrow as that gap:
 *
 * - `usage` may be set **once**, and only when the stored value is empty. A
 *   second, different figure is refused: usage is evidence, and evidence that
 *   can be revised is not.
 * - `outcome` may move from `pending` to any other value, **once**.
 * - Everything else is immutable. Why a route was chosen never changes after
 *   the fact.
 *
 * Pure, like every other table in `core`: the API applies it on
 * `PUT …/routing-decisions/{id}`, and it answers with the list of what is wrong
 * rather than throwing, so a refusal can say all of it.
 */
import type { RouteOutcome, RoutingDecision } from "@nightshift/contracts";

/** The outcomes a decision can end in. `pending` is the only one that is not an ending. */
export const ROUTE_TERMINAL_OUTCOMES: readonly RouteOutcome[] = [
  "verified",
  "succeeded",
  "verification_failed",
  "failed",
  "escalated",
  "cancelled",
  "unavailable",
];

export const isRouteOutcomeTerminal = (outcome: RouteOutcome): boolean => outcome !== "pending";

/** Every field but `usage` and `outcome`. */
export const IMMUTABLE_ROUTING_FIELDS = [
  "schemaVersion",
  "projectId",
  "programId",
  "runId",
  "routingDecisionId",
  "executionNodeId",
  "attempt",
  "eligibleOptions",
  "chosen",
  "ruleId",
  "wasOverride",
  "previousRouteId",
  "ladder",
  "rung",
  "classification",
  "policyVersion",
  "createdAt",
] as const satisfies readonly (keyof RoutingDecision)[];

/** Structural equality over JSON-shaped values, insensitive to key order. */
const same = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const left = Object.entries(a).filter(([, value]) => value !== undefined);
  const right = Object.entries(b).filter(([, value]) => value !== undefined);
  if (left.length !== right.length) return false;
  return left.every(([key, value]) => same(value, (b as Record<string, unknown>)[key]));
};

const isEmptyUsage = (usage: RoutingDecision["usage"]): boolean =>
  Object.values(usage).every((value) => value === undefined);

/**
 * Why `next` may not replace `existing`. Empty when it may — including when the
 * two are identical, which is a retry and not a change.
 */
export const explainRoutingUpdate = (
  existing: RoutingDecision,
  next: RoutingDecision,
): readonly string[] => {
  const problems: string[] = [];

  for (const field of IMMUTABLE_ROUTING_FIELDS) {
    if (!same(existing[field], next[field])) {
      problems.push(`${field} is immutable once a routing decision is recorded`);
    }
  }

  if (!same(existing.usage, next.usage) && !isEmptyUsage(existing.usage)) {
    problems.push("usage is already recorded; it may be set once, from empty");
  }

  if (existing.outcome !== next.outcome) {
    if (existing.outcome !== "pending") {
      problems.push(`outcome is already ${existing.outcome}; it may move once, from pending`);
    } else if (!isRouteOutcomeTerminal(next.outcome)) {
      problems.push("outcome may only move from pending to an ending");
    }
  }

  return problems;
};

export const canUpdateRouting = (existing: RoutingDecision, next: RoutingDecision): boolean =>
  explainRoutingUpdate(existing, next).length === 0;

/**
 * The outcome a finished job node gives its routing decision.
 *
 * `verified` covers everything at or past verification: the route did its job
 * when the work it produced passed, whatever integration then made of it.
 */
export const routeOutcomeForNodeStatus = (status: string): RouteOutcome => {
  switch (status) {
    case "verified":
    case "examining":
    case "examination_failed":
    case "sealed":
    case "integrated":
      return "verified";
    case "succeeded":
      return "succeeded";
    case "verification_failed":
      return "verification_failed";
    case "cancelled":
      return "cancelled";
    case "failed":
    case "interrupted":
      return "failed";
    default:
      return "pending";
  }
};
