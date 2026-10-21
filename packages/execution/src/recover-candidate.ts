/** Reconstruct queue inputs from durable records, never from a worker's claim of verification. */
import { access, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  CheckpointId,
  CommitSha,
  ExecutionNode,
  ExecutionNodeId,
} from "@nightshift/contracts";
import { nowIso, routeOutcomeForNodeStatus, transition } from "@nightshift/core";
import type { ExecutionEnvironment, LandingEnvironment, RunSession } from "./environment.js";
import { addDetachedWorktree, jobBranch, pruneWorktrees, revParse } from "./git/index.js";
import type { IntegrationCandidate } from "./runner.js";
import { attemptsOf } from "./runner.js";

export const checkpointOfCandidate = async (
  environment: Pick<LandingEnvironment, "stores">,
  scope: RunSession["scope"],
  nodeId: ExecutionNodeId,
  commitSha: CommitSha | null,
): Promise<CheckpointId | undefined> => {
  let cursor: string | undefined;
  do {
    const page = await environment.stores.checkpoints.listByRun(
      scope,
      cursor === undefined ? {} : { cursor },
    );
    const found = page.items.find(
      (checkpoint) => checkpoint.executionNodeId === nodeId && checkpoint.commitSha === commitSha,
    );
    if (found !== undefined) return found.checkpointId;
    cursor = page.cursor;
  } while (cursor !== undefined);
  return undefined;
};

/** Missing artifacts must be explained durably; never invent a passing result. */
export const failRecoveredCandidate = async (
  environment: ExecutionEnvironment,
  node: ExecutionNode,
  reason: string,
): Promise<void> => {
  if (node.status !== "integrated") {
    const event =
      node.status === "implemented"
        ? "fail"
        : node.status === "verifying" || node.status === "examining"
          ? "interrupt"
          : "cancel";
    await environment.stores.executionNodes.put({
      ...transition(node, event, nowIso(environment.clock)),
      outcomeReason: reason,
    });
  }
  environment.outbox.emit({
    type: "node.failed",
    source: "control-plane",
    executionNodeId: node.executionNodeId,
    payload: { reason },
  });
};

/** Finish the existing attempt's outcome, without fabricating lost token usage. */
export const settleRecoveredRoute = async (
  environment: ExecutionEnvironment,
  session: RunSession,
  nodeId: ExecutionNodeId,
): Promise<void> => {
  const node = await environment.stores.executionNodes.get(session.scope, nodeId);
  if (node === undefined) return;
  const outcome = routeOutcomeForNodeStatus(node.status);
  if (outcome === "pending") return;
  const route = attemptsOf(
    await environment.stores.routingDecisions.listByNode(session.scope, nodeId),
  ).at(-1);
  if (route?.outcome === "pending")
    await environment.stores.routingDecisions.put({ ...route, outcome });
};

export const recoverCandidate = async (
  environment: ExecutionEnvironment,
  session: RunSession,
  node: ExecutionNode,
): Promise<IntegrationCandidate> => {
  const job =
    node.jobContractId === null
      ? undefined
      : await environment.stores.jobContracts.get(session.scope, node.jobContractId);
  const agent = (await environment.stores.agents.listByNode(session.scope, node.executionNodeId))
    .filter((record) => record.role === "worker")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .at(-1);
  if (job === undefined || agent === undefined || node.commitSha === null) {
    throw new Error("recovery_missing_evidence: the job, implementing agent, or commit is missing");
  }
  // A snapshot/replay has one parent. Unlike the original base ref, this
  // remains correct when the queue had already reconciled before the crash.
  const base = await revParse(environment.git, session.repoPath, `${node.commitSha}^`);
  const worktree = environment.paths.worktree(session.scope.runId, node.executionNodeId);
  if (
    !(await access(worktree).then(
      () => true,
      () => false,
    ))
  ) {
    await mkdir(dirname(worktree), { recursive: true });
    await pruneWorktrees(environment.git, session.repoPath);
    await addDetachedWorktree(environment.git, {
      repo: session.repoPath,
      path: worktree,
      base: node.commitSha,
    });
  }
  await environment.runAs?.(agent)?.grant(worktree);
  const attempt =
    attemptsOf(
      await environment.stores.routingDecisions.listByNode(session.scope, node.executionNodeId),
    ).at(-1)?.attempt ?? 1;
  return {
    session,
    job,
    nodeId: node.executionNodeId,
    agentId: agent.agentId,
    worktree,
    branch: jobBranch(session.scope.runId, node.executionNodeId),
    base,
    attempt,
    origin: "recovered",
    commitSha: node.commitSha,
  };
};
