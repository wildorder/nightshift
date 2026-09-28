/**
 * Decision authority and reversibility (architecture §6).
 *
 * Two rules, both non-negotiable:
 *
 * 1. Human authority is highest. An agent may not override a human decision.
 * 2. Reversibility is never softened. An effect recorded as irreversible cannot
 *    later be described as compensatable or reversible.
 *
 * The original decision is never mutated. An override is a new record pointing
 * back at what it supersedes, because replay has to be able to read both sides of
 * the reversal.
 */
import type {
  Decision,
  DecisionAuthority,
  IsoTimestamp,
  Reversibility,
} from "@nightshift/contracts";
import { DecisionAuthorityError, ReversibilitySoftenedError } from "../errors.js";
import { assertSameRun } from "./ownership.js";

/** Increasing severity. A higher number is a stronger claim about consequences. */
const REVERSIBILITY_SEVERITY: Readonly<Record<Reversibility, number>> = {
  reversible: 0,
  compensatable: 1,
  irreversible: 2,
};

export const reversibilitySeverity = (reversibility: Reversibility): number =>
  REVERSIBILITY_SEVERITY[reversibility];

/** `human` outranks `agent`; equal authorities do not outrank each other. */
export const outranks = (a: DecisionAuthority, b: DecisionAuthority): boolean =>
  a === "human" && b === "agent";

/**
 * Throws unless `next` is at least as severe as `previous`.
 *
 * Softening is the dishonest direction: it would let a run claim that an
 * irreversible external effect can simply be undone.
 */
export const assertReversibilityNotSoftened = (
  previous: Reversibility,
  next: Reversibility,
): void => {
  if (reversibilitySeverity(next) < reversibilitySeverity(previous)) {
    throw new ReversibilitySoftenedError(previous, next);
  }
};

/**
 * Validates a decision before it is persisted.
 *
 * A decision that claims to supersede another must say so through
 * {@link overrideDecision}; recording a bare decision with
 * `supersedesDecisionId` set would skip the authority check.
 */
export const recordDecision = (decision: Decision): Decision => {
  if (decision.supersedesDecisionId !== null) {
    throw new DecisionAuthorityError(
      "a decision that supersedes another must be created through overrideDecision",
    );
  }
  return decision;
};

/**
 * Builds the record that reverses `original`.
 *
 * Rejects: an agent overriding a human, an override in a different ownership
 * chain, an override that softens reversibility, and an override that fails to
 * reference what it supersedes.
 */
export const overrideDecision = (
  original: Decision,
  override: Decision,
  at: IsoTimestamp,
): Decision => {
  assertSameRun(original, override);

  if (original.authority === "human" && override.authority !== "human") {
    throw new DecisionAuthorityError(
      `an ${override.authority} decision cannot override the human decision ${original.decisionId}`,
    );
  }

  if (override.decisionId === original.decisionId) {
    throw new DecisionAuthorityError("a decision cannot override itself");
  }

  assertReversibilityNotSoftened(original.reversibility, override.reversibility);

  return { ...override, supersedesDecisionId: original.decisionId, createdAt: at };
};

/**
 * Whether `decision` is the current word on its subject, meaning nothing in
 * `all` supersedes it.
 */
export const isSuperseded = (decision: Decision, all: readonly Decision[]): boolean =>
  all.some((other) => other.supersedesDecisionId === decision.decisionId);

/**
 * Follows the supersession chain from `decision` to whichever record has the
 * final say. Throws on a cycle rather than looping forever.
 */
export const effectiveDecision = (decision: Decision, all: readonly Decision[]): Decision => {
  const seen = new Set<string>([decision.decisionId]);
  let current = decision;
  for (;;) {
    const next = all.find((other) => other.supersedesDecisionId === current.decisionId);
    if (next === undefined) return current;
    if (seen.has(next.decisionId)) {
      throw new DecisionAuthorityError(`supersession cycle involving decision ${next.decisionId}`);
    }
    seen.add(next.decisionId);
    current = next;
  }
};

/**
 * Why `decision` cannot be reversed, or `undefined` when it can (P9, D-P9-02;
 * shared by the CLI and the Studio since P11, D-P11-08).
 *
 * One refusal: a decision that is itself a reversal. Reverse the decision it
 * superseded instead, so the chain stays one deep and the record reads as
 * "A, then the owner's word on A". Whether the decision has *already* been
 * reversed is a question over the run's other decisions (`isSuperseded`), and
 * the caller asks it with those in hand.
 */
export const whyNotReversible = (decision: Decision): string | undefined =>
  decision.supersedesDecisionId === null
    ? undefined
    : `${decision.decisionId} is itself a reversal; reverse the decision it superseded, ${decision.supersedesDecisionId}`;

export interface ReversalInput {
  /** The id the reversal is recorded under. */
  readonly decisionId: Decision["decisionId"];
  /** The owner's new choice. */
  readonly choice: string;
  /** Why: recorded as the reversal's rationale and as why the old choice lost. */
  readonly reason: string;
  readonly at: IsoTimestamp;
}

/**
 * The record that reverses `decision` on a human's authority.
 *
 * Exactly what `nightshift decision reverse` writes, built in one place so the
 * CLI and the Studio cannot drift (D-P11-08): the same node, the same class and
 * `checkpointBefore` (a reversal sits beside what it reverses), the old choice
 * as the one alternative with the owner's reason against it, no
 * `checkpointAfter` and no `produced` (those are stamped when work lands, and a
 * reversal lands nothing). Throws `DecisionAuthorityError` through
 * `overrideDecision` for anything the authority rules refuse.
 */
export const buildReversal = (decision: Decision, input: ReversalInput): Decision => {
  const refusal = whyNotReversible(decision);
  if (refusal !== undefined) throw new DecisionAuthorityError(refusal);
  const { checkpointAfter: _after, produced: _produced, ...rest } = decision;
  return overrideDecision(
    decision,
    {
      ...rest,
      decisionId: input.decisionId,
      agentId: null,
      context: `The owner reversed ${decision.decisionId} (${decision.context.trim()})`,
      alternatives: [{ summary: decision.choice, rejectedBecause: input.reason }],
      choice: input.choice,
      rationale: input.reason,
      authority: "human",
      createdAt: input.at,
    },
    input.at,
  );
};
