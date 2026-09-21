/**
 * `nightshift resume`: the deferred checks, when the human is back (P7, D-P7-10).
 *
 * Work whose checks could not all run sits on the run's provisional line, in the
 * order the merge queue put it there. Once preflight says the prerequisites are
 * met, this walks that line **oldest first**, and for each commit runs *every*
 * verification step on a clean checkout of it:
 *
 * - **passed**: the node is `verified`, on the commit that lands, and the program
 *   branch is fast-forwarded onto it. The commit is the one that was deferred,
 *   unchanged: a verified commit is never moved.
 * - **failed**: that is a failure, recorded as one. Everything after it on the
 *   line was built on it, so none of it can land as it is: each is **discarded**,
 *   saying which node it was built on, and the provisional ref is removed. The
 *   fix and the redo are the next run's, planned with this one's report in hand.
 *
 * A-05 holds by construction. Nothing here reaches `verified` without a passed
 * `Verification` on its commit, and nothing reaches the program branch that is
 * not `verified`. Claiming a hurdle to dodge a failing test bought provisional
 * progress and nothing else, and this is where it stops.
 *
 * No agent is started and no model is asked anything.
 */
import { mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
import type { CommitSha, ExecutionNode, ExecutionNodeId } from "@nightshift/contracts";
import { nowIso, transition } from "@nightshift/core";
import type { LandingEnvironment, RunSession } from "./environment.js";
import {
  addDetachedWorktree,
  deleteRef,
  jobBranch,
  provisionalCommits,
  provisionalRef,
  pruneWorktrees,
  revParse,
} from "./git/index.js";
import { integrateNode } from "./integrate.js";
import { verifyNode } from "./verify.js";

export interface ResumeResult {
  /** Landed on the program branch, in order. */
  readonly landed: readonly ExecutionNodeId[];
  /** The node whose deferred checks failed, or which could not be landed. */
  readonly stoppedAt?: { readonly nodeId: ExecutionNodeId; readonly reason: string };
  /** Dropped because they were built on `stoppedAt`. */
  readonly discarded: readonly ExecutionNodeId[];
}

export type ResumeSession = Pick<RunSession, "scope" | "program" | "repoPath">;

const exists = async (path: string): Promise<boolean> => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};

const readNodes = async (
  environment: LandingEnvironment,
  session: ResumeSession,
): Promise<ExecutionNode[]> => {
  const nodes: ExecutionNode[] = [];
  let cursor: string | undefined;
  do {
    const page = await environment.stores.executionNodes.listByRun(
      session.scope,
      cursor === undefined ? {} : { cursor },
    );
    nodes.push(...page.items);
    cursor = page.cursor;
  } while (cursor !== undefined);
  return nodes;
};

/** The deferred nodes, in the order their commits sit on the provisional line. */
export const deferredLine = async (
  environment: LandingEnvironment,
  session: ResumeSession,
): Promise<readonly ExecutionNode[]> => {
  const commits = await provisionalCommits(
    environment.git,
    session.repoPath,
    session.program.repository.programBranch,
    session.scope.runId,
  );
  const byCommit = new Map<CommitSha, ExecutionNode>();
  for (const node of await readNodes(environment, session)) {
    if (node.status === "deferred" && node.commitSha !== null) byCommit.set(node.commitSha, node);
  }
  return commits.map((commit) => {
    const node = byCommit.get(commit);
    if (node === undefined) {
      throw new Error(
        `commit ${commit} is on the provisional line of run ${session.scope.runId}, and no deferred node carries it`,
      );
    }
    return node;
  });
};

/** Runs one deferred node's checks in full and lands it. `undefined` when it landed. */
const landOne = async (
  environment: LandingEnvironment,
  session: RunSession,
  node: ExecutionNode,
): Promise<string | undefined> => {
  const { stores, git: runner } = environment;
  const job =
    node.jobContractId === null
      ? undefined
      : await stores.jobContracts.get(session.scope, node.jobContractId);
  const agent = (await stores.agents.listByNode(session.scope, node.executionNodeId)).at(-1);
  if (job === undefined || agent === undefined || node.commitSha === null) {
    return "its job, agent or commit is missing from the control plane";
  }

  // The worktree was kept for this. If somebody tidied it away, a detached
  // checkout of the same commit is the same thing to a verification step.
  const worktree = environment.paths.worktree(session.scope.runId, node.executionNodeId);
  if (!(await exists(worktree))) {
    await mkdir(dirname(worktree), { recursive: true });
    await pruneWorktrees(runner, session.repoPath);
    await addDetachedWorktree(runner, {
      repo: session.repoPath,
      path: worktree,
      base: node.commitSha,
    });
  }

  const verified = await verifyNode(environment, {
    session,
    node,
    job,
    agentId: agent.agentId,
    worktree,
    resuming: true,
  });
  if (!verified.passed) {
    const after = await stores.executionNodes.get(session.scope, node.executionNodeId);
    return after?.outcomeReason ?? "its deferred checks did not pass";
  }

  const landed = await integrateNode(environment, {
    session,
    nodeId: node.executionNodeId,
    agentId: agent.agentId,
    worktree,
    branch: jobBranch(session.scope.runId, node.executionNodeId),
    base: await revParse(runner, session.repoPath, session.program.repository.programBranch),
    commitSha: verified.commitSha,
  });
  return landed.kind === "integrated" ? undefined : landed.reason;
};

export const resumeDeferred = async (
  environment: LandingEnvironment,
  resumed: ResumeSession,
): Promise<ResumeResult> => {
  const { stores, clock, outbox } = environment;
  const line = await deferredLine(environment, resumed);
  if (line.length === 0) return { landed: [], discarded: [] };

  // `verifyNode` and `integrateNode` take a whole session; resuming has no
  // orchestrator, and neither of them reads the two fields it lacks.
  const session = resumed as RunSession;
  const ref = provisionalRef(resumed.scope.runId);
  const landed: ExecutionNodeId[] = [];

  for (const [index, node] of line.entries()) {
    const stopped = await landOne(environment, session, node);
    if (stopped === undefined) {
      landed.push(node.executionNodeId);
      continue;
    }

    const discarded: ExecutionNodeId[] = [];
    for (const later of line.slice(index + 1)) {
      const reason =
        `discarded: built on ${node.executionNodeId}, which did not pass its deferred checks ` +
        `(${stopped}). Its commit ${later.commitSha} is kept under its job branch for reference.`;
      const { outcomeReason: _deferredFor, ...cancelled } = transition(
        later,
        "cancel",
        nowIso(clock),
      );
      await stores.executionNodes.put({ ...cancelled, outcomeReason: reason });
      outbox.emit({
        type: "node.discarded",
        source: "control-plane",
        payload: { builtOn: node.executionNodeId, commitSha: later.commitSha, reason },
        executionNodeId: later.executionNodeId,
      });
      discarded.push(later.executionNodeId);
    }
    await deleteRef(environment.git, resumed.repoPath, ref);
    return { landed, stoppedAt: { nodeId: node.executionNodeId, reason: stopped }, discarded };
  }

  await deleteRef(environment.git, resumed.repoPath, ref);
  return { landed, discarded: [] };
};
