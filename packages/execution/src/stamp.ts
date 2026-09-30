/**
 * What a decision produced (P9, D-P9-01).
 *
 * When the node a decision was made on lands, the decision is stamped with the
 * checkpoint after it and the commits that node's work landed: a job, the one
 * commit the merge queue integrated; a strand or sub-program, the commits its
 * subtree landed after the decision's checkpoint; the program node at run end,
 * the whole run's, except that a decision the owner answered in the plan gets
 * only what the strands it `touches` landed. Nothing downstream, and nothing an
 * agent declares: the records and git say it.
 *
 * Never in the way of a landing: a stamp that cannot be written is left off,
 * and the report shows the decision as having produced nothing that landed.
 */
import type {
  CheckpointId,
  CommitSha,
  Decision,
  ExecutionNode,
  ProgramContract,
} from "@nightshift/contracts";
import {
  IRREVERSIBLE_CONFIRMATION_PREFIX,
  plannedDecisionIdOf,
  type RunScope,
} from "@nightshift/core";
import type { ExecutionEnvironment } from "./environment.js";
import { commitsSince, effectiveHead } from "./git/index.js";

export type StampEnvironment = Pick<ExecutionEnvironment, "stores" | "git">;

export interface StampSession {
  readonly scope: RunScope;
  readonly program: ProgramContract;
  readonly repoPath: string;
}

const readAll = async <T>(
  list: (page: { cursor?: string }) => Promise<{ items: readonly T[]; cursor?: string }>,
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

/** Decisions on `nodeId` that are choices of their own, not yet stamped. */
const unstamped = (decisions: readonly Decision[], nodeId: string): Decision[] =>
  decisions.filter(
    (decision) =>
      decision.executionNodeId === nodeId &&
      decision.produced === undefined &&
      // A reversal is a record of the owner's mind, and a confirmation a record
      // of their go-ahead: neither produced anything of its own.
      decision.supersedesDecisionId === null &&
      !decision.context.startsWith(IRREVERSIBLE_CONFIRMATION_PREFIX),
  );

/** Every node under `rootIds`, the roots included. */
const subtreeOf = (
  nodes: readonly ExecutionNode[],
  rootIds: ReadonlySet<string>,
): ExecutionNode[] => {
  const within = new Set(rootIds);
  let grew = true;
  while (grew) {
    grew = false;
    for (const node of nodes) {
      if (
        !within.has(node.executionNodeId) &&
        node.parentNodeId !== null &&
        within.has(node.parentNodeId)
      ) {
        within.add(node.executionNodeId);
        grew = true;
      }
    }
  }
  return nodes.filter((node) => within.has(node.executionNodeId));
};

const landedCommits = (nodes: readonly ExecutionNode[]): Set<string> =>
  new Set(
    nodes.flatMap((node) =>
      node.kind === "job" && node.status === "integrated" && node.commitSha !== null
        ? [node.commitSha]
        : [],
    ),
  );

const write = async (
  environment: StampEnvironment,
  decision: Decision,
  commits: readonly CommitSha[],
  checkpointAfter: CheckpointId | undefined,
): Promise<void> => {
  await environment.stores.decisions
    .put({
      ...decision,
      ...(decision.checkpointAfter === undefined && checkpointAfter !== undefined
        ? { checkpointAfter }
        : {}),
      produced: { commits: [...commits] },
    })
    .catch(() => {});
};

/**
 * Stamps the decisions made on a job that has just been integrated, with the
 * commit it landed and the checkpoint the landing made.
 */
export const stampJobDecisions = async (
  environment: StampEnvironment,
  scope: RunScope,
  node: Pick<ExecutionNode, "executionNodeId">,
  commitSha: CommitSha,
  checkpointId: CheckpointId,
): Promise<void> => {
  try {
    const decisions = await readAll((page) => environment.stores.decisions.listByRun(scope, page));
    for (const decision of unstamped(decisions, node.executionNodeId)) {
      await write(environment, decision, [commitSha], checkpointId);
    }
  } catch {
    // Left unstamped; the landing stands.
  }
};

/**
 * Stamps the decisions made on a sub-program or program node that has ended,
 * with the commits its work landed after each decision's checkpoint.
 */
export const stampSettledDecisions = async (
  environment: StampEnvironment,
  session: StampSession,
  nodeId: string,
): Promise<void> => {
  try {
    const { stores } = environment;
    const decisions = unstamped(
      await readAll((page) => stores.decisions.listByRun(session.scope, page)),
      nodeId,
    );
    if (decisions.length === 0) return;
    const nodes = await readAll((page) => stores.executionNodes.listByRun(session.scope, page));
    const checkpoints = await readAll((page) => stores.checkpoints.listByRun(session.scope, page));
    const { head } = await effectiveHead(
      environment.git,
      session.repoPath,
      session.program.repository.programBranch,
      session.scope.runId,
    );
    const strandNodes = await strandNodesOf(environment, session.scope, nodes);
    for (const decision of decisions) {
      const roots = rootsFor(decision, nodeId, session.program, strandNodes);
      const landed = landedCommits(subtreeOf(nodes, roots));
      const before = checkpoints.find(
        (checkpoint) => checkpoint.checkpointId === decision.checkpointBefore,
      );
      if (before === undefined || landed.size === 0) continue;
      const since = await commitsSince(environment.git, session.repoPath, before.commitSha, head);
      const commits = since.filter((sha) => landed.has(sha));
      if (commits.length === 0) continue;
      const last = commits.at(-1);
      const after = checkpoints.find((checkpoint) => checkpoint.commitSha === last);
      await write(environment, decision, commits, after?.checkpointId);
    }
  } catch {
    // Left unstamped; the run's ending stands.
  }
};

/** Strand id → the nodes that ran it, read from their Job Contracts. */
const strandNodesOf = async (
  environment: StampEnvironment,
  scope: RunScope,
  nodes: readonly ExecutionNode[],
): Promise<ReadonlyMap<string, readonly string[]>> => {
  const byStrand = new Map<string, string[]>();
  for (const node of nodes) {
    if (node.kind !== "sub-program" || node.jobContractId === null) continue;
    const job = await environment.stores.jobContracts.get(scope, node.jobContractId);
    if (job?.strandId === undefined) continue;
    byStrand.set(job.strandId, [...(byStrand.get(job.strandId) ?? []), node.executionNodeId]);
  }
  return byStrand;
};

/**
 * Where a decision's work is: under the node it was made on, except a planned
 * decision the owner answered, whose work is the strands it touches.
 */
const rootsFor = (
  decision: Decision,
  nodeId: string,
  program: ProgramContract,
  strandNodes: ReadonlyMap<string, readonly string[]>,
): ReadonlySet<string> => {
  const plannedId = plannedDecisionIdOf(decision);
  const planned = program.decisions?.find((candidate) => candidate.id === plannedId);
  if (planned === undefined || planned.touches === "all") return new Set([nodeId]);
  return new Set(planned.touches.flatMap((strandId) => strandNodes.get(strandId) ?? []));
};
