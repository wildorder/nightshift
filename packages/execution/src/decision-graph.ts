/**
 * The report's decision graph and what a correction corrects (P9, D-P9-06,
 * D-P9-08).
 *
 * Every decision a run recorded, where it was made (the plan, a strand, a job,
 * the run's own orchestrator, an arbiter), what was weighed against it, how
 * reversible it is, the commits it produced, and, once the owner reversed it,
 * the reversal and the correction that followed. Close calls are visible here,
 * and a reversal starts here. Read from the control plane alone.
 */
import type {
  CorrectionTarget,
  Decision,
  ExecutionNode,
  JobContract,
  ProgramContract,
} from "@nightshift/contracts";
import {
  IRREVERSIBLE_CONFIRMATION_PREFIX,
  type ProjectStores,
  type RunScope,
} from "@nightshift/core";

export type DecisionPlace = "plan" | "run" | "strand" | "job" | "ruling";

export interface DecisionReport {
  readonly decision: Decision;
  readonly place: DecisionPlace;
  /** The strand id, or the node, where it was made. */
  readonly where?: string;
  /** The owner's reversal of it, when there is one. */
  readonly reversedBy?: Decision;
  /** Programs whose contract says they correct it. */
  readonly correctedBy: readonly string[];
}

export interface CorrectionReport {
  readonly target: CorrectionTarget;
  readonly decision?: Decision;
  readonly reversal?: Decision;
}

const RULINGS = new Set(["overturn", "uphold"]);

const readAll = async <T>(
  list: (page: { cursor?: string }) => Promise<{
    readonly items: readonly T[];
    readonly cursor?: string | undefined;
  }>,
): Promise<T[]> => {
  const items: T[] = [];
  let cursor: string | undefined;
  do {
    const page = await list(cursor === undefined ? {} : { cursor });
    items.push(...page.items);
    cursor = page.cursor;
  } while (cursor !== undefined);
  return items;
};

/** A decision that is a choice of its own: not a reversal of one, nor a go-ahead for a correction. */
const isChoice = (decision: Decision): boolean =>
  decision.supersedesDecisionId === null &&
  !decision.context.startsWith(IRREVERSIBLE_CONFIRMATION_PREFIX);

const placeOf = (
  decision: Decision,
  node: ExecutionNode | undefined,
  job: JobContract | undefined,
): { readonly place: DecisionPlace; readonly where?: string } => {
  if (decision.authority === "agent" && RULINGS.has(decision.choice) && node?.kind === "job") {
    return { place: "ruling", where: decision.executionNodeId };
  }
  if (node === undefined || node.parentNodeId === null) {
    return decision.authority === "human" ? { place: "plan" } : { place: "run" };
  }
  if (node.kind === "sub-program") {
    return { place: "strand", where: job?.strandId ?? node.executionNodeId };
  }
  return { place: "job", where: node.executionNodeId };
};

/** Every decision of the run, placed, with its reversal and corrections (D-P9-08). */
export const gatherDecisionGraph = async (
  stores: ProjectStores,
  scope: RunScope,
  decisions: readonly Decision[],
  nodes: ReadonlyMap<string, ExecutionNode>,
  jobOf: ReadonlyMap<string, JobContract>,
): Promise<DecisionReport[]> => {
  const programs = await readAll((page) =>
    stores.programContracts.listByProject(scope.projectId, page),
  );
  return decisions.filter(isChoice).map((decision) => {
    const node = nodes.get(decision.executionNodeId);
    const job = node?.jobContractId === null ? undefined : jobOf.get(node?.jobContractId ?? "");
    const reversedBy = decisions.find(
      (candidate) =>
        candidate.supersedesDecisionId === decision.decisionId && candidate.authority === "human",
    );
    return {
      decision,
      ...placeOf(decision, node, job),
      ...(reversedBy === undefined ? {} : { reversedBy }),
      correctedBy: programs
        .filter((program) =>
          (program.corrects ?? []).some(
            (target) => target.runId === scope.runId && target.decisionId === decision.decisionId,
          ),
        )
        .map((program) => program.programId),
    };
  });
};

/** What `program` corrects, read from the runs it names (D-P9-06). */
export const gatherCorrections = async (
  stores: ProjectStores,
  program: ProgramContract,
): Promise<CorrectionReport[]> =>
  Promise.all(
    (program.corrects ?? []).map(async (target) => {
      const scope = {
        projectId: program.projectId,
        programId: target.programId,
        runId: target.runId,
      };
      const decision = await stores.decisions.get(scope, target.decisionId);
      const reversal = await stores.decisions.get(scope, target.reversedBy);
      return {
        target,
        ...(decision === undefined ? {} : { decision }),
        ...(reversal === undefined ? {} : { reversal }),
      };
    }),
  );

const PLACE_WORD: Readonly<Record<DecisionPlace, string>> = {
  plan: "Plan",
  run: "Run",
  strand: "Strand",
  job: "Job",
  ruling: "Ruling",
};

const short = (sha: string): string => sha.slice(0, 8);

const renderOne = (entry: DecisionReport): string[] => {
  const { decision } = entry;
  const where = entry.where === undefined ? "" : ` ${entry.where}`;
  return [
    `- **${PLACE_WORD[entry.place]}${where}:** ${decision.context.trim()} (\`${decision.decisionId}\`)`,
    `  Chose: ${decision.choice}. ${decision.rationale}`,
    ...decision.alternatives.map(
      (alternative) =>
        `  Weighed: ${alternative.summary}${alternative.rejectedBecause === undefined ? "" : `, rejected because ${alternative.rejectedBecause}`}`,
    ),
    `  ${decision.reversibility === "reversible" ? "Reversible" : decision.reversibility === "compensatable" ? "**Compensatable**: its effects reach outside the repository" : "**Irreversible**: its effects reach outside the repository"}.`,
    decision.produced === undefined || decision.produced.commits.length === 0
      ? "  Produced: nothing that landed."
      : `  Produced: ${decision.produced.commits.map(short).join(", ")}.`,
    ...(entry.reversedBy === undefined
      ? []
      : [
          `  **Reversed by you** (\`${entry.reversedBy.decisionId}\`): ${entry.reversedBy.choice}. ${entry.reversedBy.rationale}`,
          entry.correctedBy.length === 0
            ? "  Not corrected yet: `nightshift decision brief` starts one."
            : `  Corrected by ${entry.correctedBy.map((id) => `\`${id}\``).join(", ")}.`,
        ]),
  ];
};

/** The report's decision graph section. */
export const renderDecisionGraph = (graph: readonly DecisionReport[]): string[] => [
  "## Decision graph",
  "",
  ...(graph.length === 0
    ? ["No decisions were recorded.", ""]
    : [
        "Every decision the run recorded: what was weighed, what it produced, and whether you",
        "reversed it. To reverse one: `nightshift decision reverse <program> <decisionId> --choice … --reason …`.",
        "",
        ...graph.flatMap(renderOne),
        "",
      ]),
];

/** A correction's report opens with what it corrects (D-P9-06). */
export const renderCorrections = (corrections: readonly CorrectionReport[]): string[] =>
  corrections.length === 0
    ? []
    : [
        "## What this program corrects",
        "",
        ...corrections.flatMap(({ target, decision, reversal }) => [
          `- \`${target.decisionId}\` in run \`${target.runId}\` of \`${target.programId}\`: ${decision?.context.trim() ?? "(not found)"}`,
          `  It chose: ${decision?.choice ?? "?"}. You reversed it (\`${target.reversedBy}\`): ${reversal === undefined ? "?" : `${reversal.choice}. ${reversal.rationale}`}`,
        ]),
        "",
      ];
