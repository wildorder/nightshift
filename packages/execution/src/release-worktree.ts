/**
 * Releasing a job's worktree (P10, D-P10-25): the engine takes it back from
 * the agent it was granted to, then removes it and its branch.
 */
import type { ExecutionEnvironment } from "./environment.js";
import { removeWorktree } from "./git/operations.js";

/**
 * Removes a job's worktree and branch the engine made, taking it back from the
 * agent it was granted to first (D-P10-25). Every engine-side removal of a
 * job's worktree goes through here.
 */
export const releaseWorktree = async (
  environment: Pick<ExecutionEnvironment, "git" | "reclaim">,
  repo: string,
  worktree: string,
  branch: string,
  nodeId: string,
): Promise<void> => {
  await environment.reclaim?.(worktree);
  await removeWorktree(environment.git, repo, worktree, branch, nodeId);
};
