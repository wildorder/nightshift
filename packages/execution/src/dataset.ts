/**
 * The routing dataset (P8, SC-P8-15, SC-11): every routing decision of a run,
 * each with its job, its classification, its attempt chain, its usage and how
 * the work it ran came out, self-contained so a learned router can train on the
 * lines without joining anything. Gathered from the control plane alone.
 */
import {
  type ExecutionNode,
  type JobContract,
  type RoutingDatasetLine,
  RoutingDatasetLineSchema,
  type RoutingDecision,
} from "@nightshift/contracts";
import type { ProjectStores, RunScope } from "@nightshift/core";

const readAll = async <T>(
  read: (page: {
    cursor?: string;
  }) => Promise<{ readonly items: readonly T[]; readonly cursor?: string | undefined }>,
): Promise<T[]> => {
  const items: T[] = [];
  let cursor: string | undefined;
  do {
    const page = await read(cursor === undefined ? {} : { cursor });
    items.push(...page.items);
    cursor = page.cursor;
  } while (cursor !== undefined);
  return items;
};

/** The last evidence a node's work was judged by: its queue verification, and its examination. */
const judgedBy = async (stores: ProjectStores, scope: RunScope, node: ExecutionNode) => {
  const verification = [...(await stores.verifications.listByNode(scope, node.executionNodeId))]
    .filter((candidate) => candidate.phase !== "candidate")
    .sort((a, b) => a.endedAt.localeCompare(b.endedAt))
    .at(-1);
  const examination = [...(await stores.examinations.listByNode(scope, node.executionNodeId))]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .at(-1);
  return {
    verification: verification?.outcome ?? null,
    examination:
      examination === undefined
        ? null
        : {
            outcome: examination.outcome,
            blocking: examination.blocking,
            fixAttempt: examination.fixAttempt,
          },
  };
};

/** One decision as a line: the decision, its job, and how the work came out. */
const lineOf = (
  scope: RunScope,
  node: ExecutionNode,
  job: JobContract | undefined,
  decision: RoutingDecision,
  judged: Awaited<ReturnType<typeof judgedBy>>,
): RoutingDatasetLine =>
  RoutingDatasetLineSchema.parse({
    schemaVersion: 1,
    projectId: scope.projectId,
    programId: scope.programId,
    runId: scope.runId,
    executionNodeId: node.executionNodeId,
    jobContractId: node.jobContractId,
    strandId: job?.strandId ?? null,
    routingDecisionId: decision.routingDecisionId,
    purpose: decision.purpose ?? "work",
    attempt: decision.attempt,
    previousRouteId: decision.previousRouteId,
    ruleId: decision.ruleId,
    wasOverride: decision.wasOverride,
    ladder: decision.ladder ?? null,
    rung: decision.rung ?? null,
    classification: decision.classification ?? null,
    policyVersion: decision.policyVersion ?? null,
    chosen: decision.chosen,
    eligibleOptions: decision.eligibleOptions,
    usage: decision.usage,
    outcome: decision.outcome,
    ...judged,
    createdAt: decision.createdAt,
  });

/** One run's lines, in the order the decisions were made. */
export const routingDataset = async (
  stores: ProjectStores,
  scope: RunScope,
): Promise<readonly RoutingDatasetLine[]> => {
  const nodes = await readAll<ExecutionNode>((page) =>
    stores.executionNodes.listByRun(scope, page),
  );
  const jobs = await readAll<JobContract>((page) => stores.jobContracts.listByRun(scope, page));
  const jobOf = new Map(jobs.map((job) => [job.jobContractId as string, job]));
  const lines: RoutingDatasetLine[] = [];
  for (const node of nodes) {
    if (node.parentNodeId === null) continue;
    const decisions = await stores.routingDecisions.listByNode(scope, node.executionNodeId);
    if (decisions.length === 0) continue;
    const judged = await judgedBy(stores, scope, node);
    const job = node.jobContractId === null ? undefined : jobOf.get(node.jobContractId);
    for (const decision of decisions) lines.push(lineOf(scope, node, job, decision, judged));
  }
  return lines.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
};
