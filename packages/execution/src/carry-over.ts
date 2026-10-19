/**
 * Carrying a strand over from an earlier run of the same plan.
 *
 * A run that fails part-way has still done real work: a strand that succeeded
 * landed verified, examined commits on the program branch. Without this, the
 * only way on was a new run of the whole plan, which handed that strand to an
 * orchestrator again. At best that repeated its verifications and examinations;
 * at worst an agent rebuilt landed work and collided with the strand being
 * finished. P15's first run (2026-10-07) is where this was found: S-01 had
 * landed, S-02 was parked by a full machine, and nothing could start S-02 alone.
 *
 * So a new run of a ratified plan starts by asking which strands an earlier run
 * of the **same plan hash** finished, and keeps one when, and only when, every
 * commit it landed is already an ancestor of the new run's base. Those strands
 * are recorded on the run (`Run.carriedStrands`), count as succeeded in it, and
 * are never delegated. Deterministic: records and git, no model. A strand whose
 * work is not on the branch any more, or a plan that has changed, carries
 * nothing, and the strand runs as it always did.
 */
import type {
  CarriedStrand,
  CommitSha,
  ExecutionNode,
  ProgramContract,
  Run,
} from "@nightshift/contracts";
import {
  buildTree,
  descendantsOf,
  isPlanned,
  type Page,
  type PageRequest,
  type ProjectStores,
  strandAttempts,
  strandOutcomes,
  strandsOf,
} from "@nightshift/core";
import type { StrandContinuation } from "@nightshift/harness";
import type { ExecutionEnvironment } from "./environment.js";
import { type GitRunner, git, tryGit, tryRevParse } from "./git/index.js";
import { landedJobCommits, mergeHeadIntoStrand, strandBranch } from "./strand.js";

export interface CarryOverEnvironment {
  readonly stores: ProjectStores;
  readonly git: GitRunner;
}

export interface CarryOverInput {
  /** The ratified contract the new run follows. */
  readonly program: ProgramContract;
  readonly repoPath: string;
  /** The program branch's head the new run starts from. */
  readonly baseCommit: string;
}

const everyPage = async <T>(
  list: (page: PageRequest) => Promise<Page<T>>,
): Promise<readonly T[]> => {
  const items: T[] = [];
  let cursor: string | undefined;
  do {
    const page = await list(cursor === undefined ? {} : { cursor });
    items.push(...page.items);
    cursor = page.cursor;
  } while (cursor !== undefined);
  return items;
};

/** True when `commit` is `base` or one of its ancestors. */
const isOnBase = async (
  git: GitRunner,
  repoPath: string,
  commit: string,
  base: string,
): Promise<boolean> =>
  (await tryGit(git, ["merge-base", "--is-ancestor", commit, base], { cwd: repoPath })).exitCode ===
  0;

/** True when every commit is the base or one of its ancestors. */
const allOnBase = async (
  git: GitRunner,
  input: CarryOverInput,
  commits: readonly string[],
): Promise<boolean> => {
  for (const commit of commits) {
    if (!(await isOnBase(git, input.repoPath, commit, input.baseCommit))) return false;
  }
  return true;
};

/** What one strand landed in `run`: the commits of the jobs under its latest attempt that reached the branch. */
const landedBy = (
  nodes: readonly ExecutionNode[],
  strandNode: ExecutionNode,
): readonly CommitSha[] => {
  const tree = buildTree(nodes);
  const subtree = [strandNode.executionNodeId, ...descendantsOf(tree, strandNode.executionNodeId)]
    .map((id) => tree.nodes.get(id))
    .filter((node): node is ExecutionNode => node !== undefined);
  return landedJobCommits(subtree);
};

/** One earlier run's finished strands, as they would carry: the run's own, or what it carried itself. */
const finishedIn = async (
  stores: ProjectStores,
  program: ProgramContract,
  run: Run,
): Promise<readonly CarriedStrand[]> => {
  const scope = { projectId: run.projectId, programId: run.programId, runId: run.runId };
  const nodes = await everyPage((page) => stores.executionNodes.listByRun(scope, page));
  const jobs = await everyPage((page) => stores.jobContracts.listByRun(scope, page));
  const strandOfJob = new Map(
    jobs.flatMap((job) => (job.strandId === undefined ? [] : [[job.jobContractId, job.strandId]])),
  );
  const outcomes = strandOutcomes(strandAttempts(nodes, strandOfJob), run.carriedStrands ?? []);
  return strandsOf(program).flatMap((strand): CarriedStrand[] => {
    if (outcomes[strand.id] !== "succeeded") return [];
    const attempts = nodes
      .filter(
        (node) => node.jobContractId !== null && strandOfJob.get(node.jobContractId) === strand.id,
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const latest = attempts.at(-1);
    if (latest === undefined) {
      // Not built here: carried into this run, so it carries on as it came.
      const inherited = run.carriedStrands?.find((carried) => carried.strandId === strand.id);
      return inherited === undefined ? [] : [inherited];
    }
    return [{ strandId: strand.id, fromRunId: run.runId, landed: [...landedBy(nodes, latest)] }];
  });
};

/**
 * The strands a new run of `program` need not build, in the plan's order.
 * Earlier runs are read newest first, so a strand finished twice carries from
 * its latest success.
 */
export const carriedStrandsFor = async (
  environment: CarryOverEnvironment,
  input: CarryOverInput,
): Promise<readonly CarriedStrand[]> => {
  const { program } = input;
  if (!isPlanned(program) || program.planHash === undefined) return [];
  const runs = [
    ...(await everyPage((page) =>
      environment.stores.runs.listByProgram(
        { projectId: program.projectId, programId: program.programId },
        page,
      ),
    )),
  ].sort((a, b) => b.startedAt.localeCompare(a.startedAt));

  const carried = new Map<string, CarriedStrand>();
  for (const run of runs) {
    const root = await environment.stores.executionNodes.get(
      { projectId: run.projectId, programId: run.programId, runId: run.runId },
      run.rootNodeId,
    );
    if (root?.plan?.planHash !== program.planHash) continue;
    for (const candidate of await finishedIn(environment.stores, program, run)) {
      if (carried.has(candidate.strandId)) continue;
      if (await allOnBase(environment.git, input, candidate.landed)) {
        carried.set(candidate.strandId, candidate);
      }
    }
  }
  return strandsOf(program).flatMap((strand) => {
    const found = carried.get(strand.id);
    return found === undefined ? [] : [found];
  });
};

/** Where an earlier run's strand branch can be read: this clone's, or the remote's (A-60). */
const headOfBranch = async (
  runner: GitRunner,
  repoPath: string,
  branch: string,
): Promise<CommitSha | undefined> => {
  const local = async () =>
    (await tryRevParse(runner, repoPath, `refs/heads/${branch}`)) ??
    (await tryRevParse(runner, repoPath, `refs/remotes/origin/${branch}`));
  const found = await local();
  if (found !== undefined) return found;
  // Published by a machine and never fetched here: ask the remote for it.
  await tryGit(
    runner,
    ["fetch", "--quiet", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`],
    {
      cwd: repoPath,
    },
  );
  return local();
};

/**
 * The strand `strandId` as the latest earlier run of the same plan left it,
 * when that run built some of it and did not land it (A-60): its branch and
 * head, wherever this clone can read them. `undefined` when no earlier run
 * did, when the strand landed (carry-over keeps it), or when its branch holds
 * nothing the program head does not.
 */
export const unfinishedStrand = async (
  environment: CarryOverEnvironment,
  input: {
    readonly program: ProgramContract;
    readonly repoPath: string;
    readonly runId: string;
    readonly strandId: string;
    /** The program head this run's strand starts from. */
    readonly base: CommitSha;
  },
): Promise<
  { readonly fromRunId: string; readonly branch: string; readonly head: CommitSha } | undefined
> => {
  const { program, stores } = { program: input.program, stores: environment.stores };
  if (!isPlanned(program) || program.planHash === undefined) return undefined;
  const runs = [
    ...(await everyPage((page) =>
      stores.runs.listByProgram(
        { projectId: program.projectId, programId: program.programId },
        page,
      ),
    )),
  ]
    .filter((run) => run.runId !== input.runId)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  for (const run of runs) {
    const scope = { projectId: run.projectId, programId: run.programId, runId: run.runId };
    const root = await stores.executionNodes.get(scope, run.rootNodeId);
    if (root?.plan?.planHash !== program.planHash) continue;
    const nodes = await everyPage((page) => stores.executionNodes.listByRun(scope, page));
    const jobs = await everyPage((page) => stores.jobContracts.listByRun(scope, page));
    const strandOfJob = new Map(
      jobs.flatMap((job) =>
        job.strandId === undefined ? [] : [[job.jobContractId, job.strandId]],
      ),
    );
    const latest = nodes
      .filter(
        (node) =>
          node.kind === "sub-program" &&
          node.jobContractId !== null &&
          strandOfJob.get(node.jobContractId) === input.strandId,
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .at(-1);
    if (latest === undefined) continue;
    const outcomes = strandOutcomes(strandAttempts(nodes, strandOfJob), run.carriedStrands ?? []);
    // Landed: on the program branch already, and carried over as succeeded.
    if (outcomes[input.strandId] === "succeeded") return undefined;
    const branch = strandBranch(run.runId, latest.executionNodeId);
    const head = await headOfBranch(environment.git, input.repoPath, branch);
    if (head === undefined) continue;
    if (await isOnBase(environment.git, input.repoPath, head, input.base)) return undefined;
    return { fromRunId: run.runId, branch, head };
  }
  return undefined;
};

/** Each job on a strand's branch since `base`, newest first, by its subject. */
const workOn = async (
  runner: GitRunner,
  repoPath: string,
  base: CommitSha,
  head: CommitSha,
): Promise<readonly string[]> =>
  (
    await tryGit(runner, ["log", "--first-parent", "--format=%s", `${base}..${head}`], {
      cwd: repoPath,
    })
  ).stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("Merge the program head"));

/**
 * A strand's first start in this run, continued from what an earlier run left
 * of it (A-60): its checkout, just cut at the program head, is moved to the
 * earlier strand's head and the program head merged in, so every job that
 * finished there stays done. When the two do not merge, the checkout stays at
 * the program head and the orchestrator is told where the earlier work is.
 * `undefined` when there is nothing to continue.
 */
export const continueUnfinishedStrand = async (
  environment: Pick<ExecutionEnvironment, "stores" | "git" | "clock" | "publishStrand">,
  input: {
    readonly program: ProgramContract;
    readonly repoPath: string;
    readonly runId: string;
    readonly strandId: string;
    readonly strandNodeId: ExecutionNode["executionNodeId"];
    readonly worktree: string;
    readonly base: CommitSha;
  },
): Promise<StrandContinuation | undefined> => {
  const earlier = await unfinishedStrand(environment, input);
  if (earlier === undefined) return undefined;
  const work = await workOn(environment.git, input.repoPath, input.base, earlier.head);
  await git(environment.git, ["reset", "--quiet", "--hard", earlier.head], { cwd: input.worktree });
  const merged = await mergeHeadIntoStrand(environment, {
    repo: input.repoPath,
    worktree: input.worktree,
    runId: input.runId,
    strandNodeId: input.strandNodeId,
    head: input.base,
  });
  if (merged.merged) return { ...earlier, work };
  await git(environment.git, ["reset", "--quiet", "--hard", input.base], { cwd: input.worktree });
  const where = merged.conflicts.length > 0 ? merged.conflicts.join(", ") : merged.detail;
  return { ...earlier, work, conflict: `it conflicts with the program head in ${where}` };
};
