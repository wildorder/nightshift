/**
 * The run's provisional line and its records, kept in agreement (P7, D-P7-10).
 *
 * A job whose checks wait on a human prerequisite is `deferred`, and its commit
 * goes on the run's provisional line, where `nightshift resume` finds it and
 * later work builds on it. Those are two writes to two stores, git and the
 * control plane, and no write spans both. Until 2026-10-07 the record came
 * first: an engine that stopped between the two left a node `deferred` whose
 * commit was on no line, and `resume`, which walks the line, never found it.
 * The work was lost without a word (found by P15's own test, under load).
 *
 * So the commit goes on the line **first** (`verify.ts`), and `deferred` always
 * means "on the line". The partial state a stop can leave is the other one: a
 * commit at the line's tip whose node never became `deferred`, because its
 * verification never finished. `repairProvisionalLine` drops exactly those,
 * before anything uses the line: when a run's engine attaches, and when
 * `resume` starts. Only the tip can be affected, because the merge queue lands
 * one commit at a time, and the dropped node, whatever the stop left it as, is
 * retried from the line as it then stands.
 */
import type { CommitSha, ExecutionNode } from "@nightshift/contracts";
import type { ProjectStores, RunScope } from "@nightshift/core";
import {
  deleteRef,
  type GitRunner,
  provisionalCommits,
  provisionalRef,
  updateRef,
} from "./git/index.js";

export interface ProvisionalLineEnvironment {
  readonly git: GitRunner;
  readonly stores: Pick<ProjectStores, "executionNodes">;
}

export interface ProvisionalLineSession {
  readonly scope: RunScope;
  readonly repoPath: string;
  readonly program: { readonly repository: { readonly programBranch: string } };
}

const deferredCommitsOf = async (
  stores: ProvisionalLineEnvironment["stores"],
  scope: RunScope,
): Promise<ReadonlySet<string>> => {
  const commits = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await stores.executionNodes.listByRun(
      scope,
      cursor === undefined ? {} : { cursor },
    );
    for (const node of page.items as readonly ExecutionNode[]) {
      if (node.status === "deferred" && node.commitSha !== null) commits.add(node.commitSha);
    }
    cursor = page.cursor;
  } while (cursor !== undefined);
  return commits;
};

/**
 * Drops the commits at the line's tip that no `deferred` node carries, moving
 * the line back to the last one that does, or removing it when none does.
 * Returns what was dropped, oldest first.
 */
export const repairProvisionalLine = async (
  environment: ProvisionalLineEnvironment,
  session: ProvisionalLineSession,
): Promise<readonly CommitSha[]> => {
  const { runId } = session.scope;
  const line = await provisionalCommits(
    environment.git,
    session.repoPath,
    session.program.repository.programBranch,
    runId,
  );
  if (line.length === 0) return [];
  const deferred = await deferredCommitsOf(environment.stores, session.scope);
  let kept = line.length;
  while (kept > 0 && !deferred.has(line[kept - 1] as string)) kept -= 1;
  if (kept === line.length) return [];
  const ref = provisionalRef(runId);
  const tip = line[kept - 1];
  if (tip === undefined) await deleteRef(environment.git, session.repoPath, ref);
  else await updateRef(environment.git, session.repoPath, ref, tip);
  return line.slice(kept);
};
