/**
 * What a strand's orchestrator is told (P7, D-P7-04, D-P7-06, SC-P7-10).
 *
 * **What the human read is what the agent is told.** A strand's objective is its
 * section of the ratified plan document, verbatim and first, so nothing is
 * paraphrased between the review and the run. After it come the two things the
 * section does not contain and the orchestrator needs: the decisions a human
 * already made that touch this strand, which are constraints and not forks, and
 * where the plan expects the other strands' work, which is how it knows what is
 * being built beside it. None of it is a limit on what the strand may change: a
 * job carries no path scope (the owner's ruling, 2026-10-09).
 *
 * Pure: the plan text and the contract are handed in. Building this here rather
 * than letting a root orchestrator compose it is what makes "verbatim"
 * structural instead of something a prompt asks for.
 */
import type { PlannedDecision, ProgramContract, Strand } from "@nightshift/contracts";
import { type PlanSections, strandsOf } from "./plan.js";

export const STRAND_DECISIONS_HEADING = "DECISIONS ALREADY MADE BY A HUMAN";
export const STRAND_ROSTER_HEADING = "THE OTHER STRANDS OF THIS PROGRAM";

/** The answered decisions whose reach includes `strandId`. */
export const decisionsTouching = (
  contract: ProgramContract,
  strandId: string,
): readonly PlannedDecision[] =>
  (contract.decisions ?? []).filter(
    (decision) =>
      decision.answer !== undefined &&
      (decision.touches === "all" || decision.touches.includes(strandId)),
  );

const describeDecision = (decision: PlannedDecision): string =>
  [
    `  ${decision.id}: ${decision.question}`,
    `    Answer: ${decision.answer}`,
    ...(decision.rationale === undefined ? [] : [`    Why: ${decision.rationale}`]),
  ].join("\n");

const describeNeighbour = (strand: Strand): string =>
  [
    `  ${strand.id} ${strand.name}: ${strand.scope.summary}`,
    `    the plan expects its work mostly in: ${strand.scope.includes.join(", ")}`,
    ...(strand.scope.excludes.length === 0
      ? []
      : [`    and not in: ${strand.scope.excludes.join(", ")}`]),
  ].join("\n");

/** Thrown when a strand cannot be briefed: the plan the run holds does not describe it. */
export class StrandBriefError extends Error {
  override readonly name = "StrandBriefError";
}

export interface StrandBrief {
  /** The plan section verbatim, then the decisions that touch it, then the roster. */
  readonly objective: string;
  readonly acceptance: readonly string[];
}

export const strandBrief = (
  contract: ProgramContract,
  sections: PlanSections,
  strandId: string,
): StrandBrief => {
  const strand = strandsOf(contract).find((candidate) => candidate.id === strandId);
  if (strand === undefined) throw new StrandBriefError(`the plan has no strand ${strandId}`);
  const section = sections[strandId];
  if (section === undefined || section.trim() === "") {
    throw new StrandBriefError(`the plan document has no section for strand ${strandId}`);
  }

  const decisions = decisionsTouching(contract, strandId);
  const neighbours = strandsOf(contract).filter((candidate) => candidate.id !== strandId);
  const objective = [
    section,
    ...(decisions.length === 0
      ? []
      : [
          `${STRAND_DECISIONS_HEADING}\n\n  These are settled. Build on them; do not reopen them.\n\n${decisions
            .map(describeDecision)
            .join("\n\n")}`,
        ]),
    ...(neighbours.length === 0
      ? []
      : [
          `${STRAND_ROSTER_HEADING}\n\n  Each is being built beside yours, perhaps at the same time. Where the plan expects their work is guidance, not a limit: change whatever your work needs, and expect a conflict where two strands change the same lines.\n\n${neighbours
            .map(describeNeighbour)
            .join("\n\n")}`,
        ]),
  ].join("\n\n");

  return { objective, acceptance: [...strand.acceptance] };
};
