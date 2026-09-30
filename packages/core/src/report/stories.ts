/**
 * Which user stories a record serves (P14, D-P14-03).
 *
 * Nothing at run time names a story. The link is derived from records that
 * already exist: a story is served by the success criteria that list it; a
 * criterion is claimed by strands; a job belongs to a strand; a decision was
 * made on a node, or, when it answers a planned decision, reaches the strands
 * that decision touches; a commit was landed by a job or produced by a
 * decision. `storiesOf` walks that chain up. It is structural: "serves US-02"
 * means the record sits under a strand that claims a criterion of US-02.
 */
import type { Decision, ProgramContract, Story } from "@nightshift/contracts";
import { programStories, strandsOf } from "../rules/plan.js";
import type { DecisionReport } from "./decision-graph.js";
import type { RunReport } from "./report.js";

/** The planned decision a recorded one answers (`D-01: …`), when it is one. */
export const plannedDecisionIdOf = (decision: Decision): string | undefined =>
  decision.authority === "human" ? /^(D-[0-9A-Za-z-]+): /.exec(decision.context)?.[1] : undefined;

/** What `storiesOf` is asked about. */
export type StoryTarget =
  | { readonly strandId: string }
  | { readonly criterionId: string }
  /** A planned decision of the contract, by its id (`D-01`). */
  | { readonly plannedDecisionId: string }
  /** Any execution node of the run: a strand's, a job's, the program's. */
  | { readonly nodeId: string }
  | { readonly decision: Decision }
  | { readonly commit: string };

/** What the chain is read from: the report's contract, strands and decision graph. */
export type StoryRecords = Pick<RunReport, "program" | "strands" | "graph">;

/** Stories served by any of `criterionIds`, in the contract's order. */
const storiesOfCriteria = (
  program: ProgramContract,
  criterionIds: ReadonlySet<string>,
): readonly Story[] => {
  const served = new Set(
    program.successCriteria
      .filter((criterion) => criterionIds.has(criterion.id))
      .flatMap((criterion) => criterion.serves ?? []),
  );
  return programStories(program).filter((story) => served.has(story.id));
};

/** Stories served by the criteria the strands claim. */
export const storiesOfStrands = (
  program: ProgramContract,
  strandIds: Iterable<string>,
): readonly Story[] => {
  const wanted = new Set(strandIds);
  return storiesOfCriteria(
    program,
    new Set(
      strandsOf(program)
        .filter((strand) => wanted.has(strand.id))
        .flatMap((strand) => strand.successCriteria),
    ),
  );
};

const allStrands = (program: ProgramContract): readonly string[] =>
  strandsOf(program).map((strand) => strand.id);

/** The strand a node belongs to, or `undefined` for the program's own node. */
export const strandOfNode = (records: StoryRecords, nodeId: string): string | undefined =>
  records.strands.find((strand) => strand.nodeIds.includes(nodeId))?.id;

const strandsOfPlanned = (program: ProgramContract, plannedId: string): readonly string[] => {
  const planned = (program.decisions ?? []).find((decision) => decision.id === plannedId);
  if (planned === undefined) return [];
  return planned.touches === "all" ? allStrands(program) : planned.touches;
};

/**
 * The strands a decision reaches: a planned one's `touches`; one made on a
 * strand's or a job's node, that strand; one made on the program's own node,
 * every strand, since the whole program was built under it.
 */
export const strandsOfDecision = (records: StoryRecords, decision: Decision): readonly string[] => {
  const plannedId = plannedDecisionIdOf(decision);
  if (plannedId !== undefined) return strandsOfPlanned(records.program, plannedId);
  const strand = strandOfNode(records, decision.executionNodeId);
  return strand === undefined ? allStrands(records.program) : [strand];
};

const strandsOfCommit = (records: StoryRecords, commit: string): readonly string[] => {
  const byJob = records.strands
    .filter((strand) => strand.jobs.some((job) => job.commitSha === commit))
    .map((strand) => strand.id);
  const byDecision = records.graph
    .filter((entry: DecisionReport) => entry.decision.produced?.commits.includes(commit) === true)
    .flatMap((entry) => strandsOfDecision(records, entry.decision));
  return [...new Set([...byJob, ...byDecision])];
};

/** The stories a record serves, in the contract's order; empty when it reaches none. */
export const storiesOf = (records: StoryRecords, target: StoryTarget): readonly Story[] => {
  const { program } = records;
  if ("criterionId" in target) return storiesOfCriteria(program, new Set([target.criterionId]));
  if ("strandId" in target) return storiesOfStrands(program, [target.strandId]);
  if ("plannedDecisionId" in target) {
    return storiesOfStrands(program, strandsOfPlanned(program, target.plannedDecisionId));
  }
  if ("nodeId" in target) {
    const strand = strandOfNode(records, target.nodeId);
    return storiesOfStrands(program, strand === undefined ? allStrands(program) : [strand]);
  }
  if ("decision" in target)
    return storiesOfStrands(program, strandsOfDecision(records, target.decision));
  return storiesOfStrands(program, strandsOfCommit(records, target.commit));
};

/** One story as the report and the Studio lead with it: its criteria, met or not. */
export interface StoryStatus {
  readonly story: Story;
  readonly criteria: readonly {
    readonly id: string;
    readonly outcome: string;
    readonly met: boolean;
  }[];
  /** Every criterion that serves it is met. */
  readonly met: boolean;
  readonly strands: readonly string[];
}

/** Each story with the criteria that serve it, met or not, and the strands that claim them. */
export const storyStatuses = (
  report: Pick<RunReport, "program" | "criteria">,
): readonly StoryStatus[] =>
  programStories(report.program).map((story) => {
    const criteria = report.criteria
      .filter((criterion) =>
        (report.program.successCriteria.find((c) => c.id === criterion.id)?.serves ?? []).includes(
          story.id,
        ),
      )
      .map(({ id, outcome, met }) => ({ id, outcome, met }));
    const ids = new Set(criteria.map((criterion) => criterion.id));
    return {
      story,
      criteria,
      met: criteria.length > 0 && criteria.every((criterion) => criterion.met),
      strands: strandsOf(report.program)
        .filter((strand) => strand.successCriteria.some((id) => ids.has(id)))
        .map((strand) => strand.id),
    };
  });
