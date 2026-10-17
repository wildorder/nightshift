/**
 * A strand's own branch (P18, D-P18-03, D-P18-04).
 *
 * A planned strand builds on a branch of its own, `nightshift/<run>/<strandNode>`,
 * cut from the program head when the strand starts and checked out in the
 * strand's worktree, where its orchestrator reads it. Its jobs are cut from the
 * branch's head and their commits merge back onto it as they finish: no gate, no
 * examination and no queue turn of their own. The strand then lands once, as a
 * job does: the merge queue brings the program head into the branch when it has
 * moved, verifies it, examines it, and fast-forwards the program branch to it.
 *
 * Merges onto one strand are made one at a time, in this process: two of its
 * jobs finishing together must not race over the strand's checkout.
 */
import {
  blockingFindings,
  type CommitSha,
  type ExaminationFinding,
  type ExecutionNode,
  type ExecutionNodeId,
} from "@nightshift/contracts";
import type { ExecutionEnvironment, RunSession } from "./environment.js";
import { latestExamination, verificationEvidence } from "./examine.js";
import {
  baseRef,
  type GitRunner,
  git,
  jobBranch,
  revParse,
  tryGit,
  tryRevParse,
  updateRef,
} from "./git/index.js";

/** The branch a strand builds on: its node's job branch, as any node's worktree has. */
export const strandBranch = (runId: string, strandNodeId: string): string =>
  jobBranch(runId, strandNodeId);

/** The strand a job builds in: its parent, when that is a sub-program node. */
export const strandOf = async (
  environment: Pick<ExecutionEnvironment, "stores">,
  session: Pick<RunSession, "scope">,
  node: Pick<ExecutionNode, "kind" | "parentNodeId">,
): Promise<ExecutionNode | undefined> => {
  if (node.kind !== "job" || node.parentNodeId === null) return undefined;
  const parent = await environment.stores.executionNodes.get(session.scope, node.parentNodeId);
  return parent?.kind === "sub-program" ? parent : undefined;
};

/** The strand branch's head, or `undefined` when the strand has not made one yet. */
export const strandHead = (
  runner: GitRunner,
  repo: string,
  runId: string,
  strandNodeId: string,
): Promise<CommitSha | undefined> =>
  tryRevParse(runner, repo, `refs/heads/${strandBranch(runId, strandNodeId)}`);

/** The program head the strand last took in: where its branch was cut, or merged up to. */
export const strandBase = (
  runner: GitRunner,
  repo: string,
  strandNodeId: string,
): Promise<CommitSha | undefined> => tryRevParse(runner, repo, baseRef(strandNodeId));

export type StrandMerge =
  | { readonly merged: true; readonly head: CommitSha }
  | { readonly merged: false; readonly conflicts: readonly string[]; readonly detail: string };

const conflictsIn = async (runner: GitRunner, worktree: string): Promise<string[]> =>
  (await tryGit(runner, ["diff", "--name-only", "--diff-filter=U"], { cwd: worktree })).stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");

const serial = new Map<string, Promise<unknown>>();

/** Runs `work` after every earlier merge onto the same strand worktree has finished. */
const onStrand = <T>(worktree: string, work: () => Promise<T>): Promise<T> => {
  const previous = serial.get(worktree) ?? Promise.resolve();
  const next = previous.then(work, work);
  serial.set(
    worktree,
    next.catch(() => undefined),
  );
  return next;
};

/**
 * Merges `commit` into the branch checked out in `worktree`: a fast-forward
 * when the branch has not moved since `commit` was cut from it, otherwise a
 * merge commit, so every job's own commit stays in the history. A conflict is
 * aborted and reported, the branch left where it was.
 */
export const mergeInto = (
  runner: GitRunner,
  input: {
    readonly worktree: string;
    readonly commit: CommitSha;
    readonly message: string;
    readonly atMs: number;
  },
): Promise<StrandMerge> =>
  onStrand(input.worktree, async () => {
    // The strand's checkout is Nightshift's: nothing in it is anyone's work in
    // progress, so whatever a reader left there goes before the merge.
    await git(runner, ["reset", "--hard", "HEAD"], { cwd: input.worktree });
    await git(runner, ["clean", "-fd"], { cwd: input.worktree });
    const merged = await tryGit(runner, ["merge", "--no-edit", "-m", input.message, input.commit], {
      cwd: input.worktree,
      atMs: input.atMs,
    });
    if (merged.exitCode !== 0) {
      const conflicts = await conflictsIn(runner, input.worktree);
      await tryGit(runner, ["merge", "--abort"], { cwd: input.worktree });
      return {
        merged: false,
        conflicts,
        detail: (merged.stderr || merged.stdout).trim().slice(0, 2_000),
      };
    }
    return { merged: true, head: await revParse(runner, input.worktree, "HEAD") };
  });

/**
 * The program head merged into the strand's branch, when it moved since the
 * strand last took it in (D-P18-04), and the strand's base ref moved with it.
 * The strand's head after it, or the conflict.
 */
export const mergeHeadIntoStrand = async (
  environment: Pick<ExecutionEnvironment, "git" | "clock">,
  input: {
    readonly repo: string;
    readonly worktree: string;
    readonly strandNodeId: ExecutionNodeId;
    readonly head: CommitSha;
  },
): Promise<StrandMerge> => {
  const result = await mergeInto(environment.git, {
    worktree: input.worktree,
    commit: input.head,
    message: `Merge the program head ${input.head.slice(0, 12)} into strand ${input.strandNodeId}`,
    atMs: environment.clock.now(),
  });
  if (result.merged) {
    await updateRef(environment.git, input.repo, baseRef(input.strandNodeId), input.head);
  }
  return result;
};

/** How many times a strand's landing failure goes back to its orchestrator (D-P18-05). */
export const MAX_STRAND_FIX_ROUNDS = 3;

/** A strand whose landing failed: red gates, a blocking finding, or a conflict with the program head. */
export const strandLandingFailed = (
  node: Pick<ExecutionNode, "kind" | "status" | "outcomeReason">,
): boolean =>
  node.kind === "sub-program" &&
  (node.status === "verification_failed" ||
    node.status === "examination_failed" ||
    (node.status === "failed" && (node.outcomeReason ?? "").startsWith("integration_conflict")));

/**
 * Why a strand is not settled though its status is (D-P18-05): its landing
 * failed and Nightshift is resuming its orchestrator to fix it. `undefined`
 * once its rounds are spent, or when it did not fail landing. `attempts` is
 * its orchestrator's attempts so far.
 */
export const strandContinuing = (
  node: Pick<ExecutionNode, "kind" | "status" | "outcomeReason">,
  attempts: number,
): string | undefined =>
  strandLandingFailed(node) && attempts <= MAX_STRAND_FIX_ROUNDS
    ? `its landing failed; Nightshift resumes its orchestrator to fix it (round ${attempts} of ${MAX_STRAND_FIX_ROUNDS})`
    : undefined;

/**
 * What stopped a strand's landing, as its orchestrator is told it (D-P18-05):
 * each landing gate that failed, with the tail of its log; each blocking
 * finding of its examination; or the conflict with the program head.
 */
export const strandFailures = async (
  environment: ExecutionEnvironment,
  session: Pick<RunSession, "scope">,
  node: ExecutionNode,
): Promise<{
  readonly failedChecks: readonly {
    readonly stepId: string;
    readonly command: string;
    readonly exitCode: number | null;
    readonly output: string;
  }[];
  readonly findings: readonly ExaminationFinding[];
  readonly conflict?: string;
}> => {
  const verification = [
    ...(await environment.stores.verifications.listByNode(session.scope, node.executionNodeId)),
  ]
    .filter((record) => record.phase !== "candidate" && record.phase !== "run")
    .sort((a, b) => a.endedAt.localeCompare(b.endedAt))
    .at(-1);
  const failedChecks =
    verification === undefined || verification.outcome !== "failed"
      ? []
      : (await verificationEvidence(environment, verification))
          .filter((step) => step.exitCode !== undefined && step.exitCode !== 0)
          .map((step) => ({
            stepId: step.stepId,
            command: step.command,
            exitCode: step.exitCode ?? null,
            output: step.logTail ?? "",
          }));
  const examination =
    node.status === "examination_failed"
      ? await latestExamination(environment, session.scope, node.executionNodeId)
      : undefined;
  const conflict = (node.outcomeReason ?? "").startsWith("integration_conflict")
    ? node.outcomeReason
    : undefined;
  return {
    failedChecks,
    findings: examination === undefined ? [] : blockingFindings(examination),
    ...(conflict === undefined ? {} : { conflict }),
  };
};

/**
 * The commits of the jobs in `nodes` that reached the program branch: a job
 * the merge queue integrated, or a strand's job merged onto a strand that then
 * landed (D-P18-04). A merged job of a strand that never landed reached nothing.
 */
export const landedJobCommits = (nodes: readonly ExecutionNode[]): CommitSha[] => {
  const byId = new Map(nodes.map((node) => [node.executionNodeId as string, node]));
  return nodes.flatMap((node) => {
    if (node.kind !== "job" || node.commitSha === null) return [];
    if (node.status === "integrated") return [node.commitSha];
    const strand = node.parentNodeId === null ? undefined : byId.get(node.parentNodeId);
    return node.status === "merged" && strand?.status === "integrated" ? [node.commitSha] : [];
  });
};
