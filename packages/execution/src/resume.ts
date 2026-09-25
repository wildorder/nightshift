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
import type {
  AgentId,
  CommitSha,
  Examination,
  ExecutionNode,
  ExecutionNodeId,
  JobContract,
} from "@nightshift/contracts";
import { nowIso, transition } from "@nightshift/core";
import type { ExecutionEnvironment, LandingEnvironment, RunSession } from "./environment.js";
import {
  carriedExamination,
  examineInQueue,
  patchIdOf,
  recordRulingLanded,
  requirementOf,
} from "./examine.js";
import {
  addDetachedWorktree,
  deleteRef,
  git,
  jobBranch,
  provisionalCommits,
  provisionalRef,
  pruneWorktrees,
  revParse,
} from "./git/index.js";
import { checkoutBlocked, integrateNode } from "./integrate.js";
import { verifyNode } from "./verify.js";

export interface ResumeResult {
  /** Landed on the program branch, in order. */
  readonly landed: readonly ExecutionNodeId[];
  /**
   * Nothing could be landed on this checkout, so **nothing was touched**: every
   * deferred node is still deferred and the provisional line is intact. Fix the
   * checkout and resume again.
   */
  readonly blocked?: string;
  /**
   * Where it stopped. `failed` means the node's deferred checks ran and did not
   * pass: a verdict, and what was built on it is discarded. `refused` means its
   * checks passed and the landing itself was refused, which is no verdict on
   * anything after it: those stay deferred, on the line, for the next resume.
   */
  readonly stoppedAt?: {
    readonly nodeId: ExecutionNodeId;
    readonly kind: "failed" | "refused";
    readonly reason: string;
  };
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

type Stopped = { readonly kind: "failed" | "refused"; readonly reason: string };

/** Runs one deferred node's checks in full and lands it. `undefined` when it landed. */
const landOne = async (
  environment: LandingEnvironment | ExecutionEnvironment,
  session: RunSession,
  node: ExecutionNode,
): Promise<Stopped | undefined> => {
  const { stores, git: runner } = environment;
  const job =
    node.jobContractId === null
      ? undefined
      : await stores.jobContracts.get(session.scope, node.jobContractId);
  const agent = (await stores.agents.listByNode(session.scope, node.executionNodeId)).at(-1);
  if (job === undefined || agent === undefined || node.commitSha === null) {
    return {
      kind: "refused",
      reason: "its job, agent or commit is missing from the control plane",
    };
  }

  const worktree = await worktreeFor(environment, session, node, node.commitSha);

  // P8 (D-P8-14): deferred work whose risk requires examination is examined
  // now, once its checks pass, never on unverified work. A resume with no
  // examiner leaves it deferred, saying why, rather than landing it unexamined.
  const head = await revParse(runner, session.repoPath, session.program.repository.programBranch);
  const examiner = examinerOf(environment);
  const carried = await carriedAtResume(environment, session, job, node, head);
  if (carried === "awaiting" && examiner === undefined) {
    return {
      kind: "refused",
      reason:
        "awaiting_examination: its risk requires an independent examiner, and this resume has " +
        "none to run; it stays deferred, and nothing after it lands until it is examined",
    };
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
    return { kind: "failed", reason: after?.outcomeReason ?? "its deferred checks did not pass" };
  }

  let examination = carried === "awaiting" || carried === "not_required" ? undefined : carried;
  if (carried === "awaiting" && examiner !== undefined) {
    const examined = await examineAtResume(examiner, session, job, node, head, verified);
    if ("kind" in examined) return examined;
    examination = examined.examination;
  }

  return land(environment, session, node, {
    agentId: agent.agentId,
    worktree,
    head,
    commitSha: verified.commitSha,
    examination,
  });
};

/** Seal, fast-forward, checkpoint; and an arbiter's ruling that let it land gets its rollback point. */
const land = async (
  environment: LandingEnvironment | ExecutionEnvironment,
  session: RunSession,
  node: ExecutionNode,
  landing: {
    readonly agentId: AgentId;
    readonly worktree: string;
    readonly head: CommitSha;
    readonly commitSha: CommitSha;
    readonly examination: Examination | undefined;
  },
): Promise<Stopped | undefined> => {
  const landed = await integrateNode(environment, {
    session,
    nodeId: node.executionNodeId,
    agentId: landing.agentId,
    worktree: landing.worktree,
    branch: jobBranch(session.scope.runId, node.executionNodeId),
    base: landing.head,
    commitSha: landing.commitSha,
    ...(landing.examination === undefined ? {} : { examination: landing.examination }),
  });
  if (landed.kind === "integrated" && landing.examination !== undefined) {
    await recordRulingLanded(environment, session.scope, landing.examination, landed.checkpointId);
  }
  return landed.kind === "integrated" ? undefined : { kind: "refused", reason: landed.reason };
};

/** The worktree kept for this; when somebody tidied it away, a detached checkout of the same commit. */
const worktreeFor = async (
  environment: LandingEnvironment | ExecutionEnvironment,
  session: RunSession,
  node: ExecutionNode,
  commitSha: CommitSha,
): Promise<string> => {
  const worktree = environment.paths.worktree(session.scope.runId, node.executionNodeId);
  if (await exists(worktree)) return worktree;
  await mkdir(dirname(worktree), { recursive: true });
  await pruneWorktrees(environment.git, session.repoPath);
  await addDetachedWorktree(environment.git, {
    repo: session.repoPath,
    path: worktree,
    base: commitSha,
  });
  return worktree;
};

/** The examination made at resume, once the deferred checks passed (D-P8-14), or why it stopped the work. */
const examineAtResume = async (
  examiner: ExecutionEnvironment,
  session: RunSession,
  job: JobContract,
  node: ExecutionNode,
  head: CommitSha,
  verified: Extract<Awaited<ReturnType<typeof verifyNode>>, { passed: true }>,
): Promise<{ readonly examination: Examination | undefined } | Stopped> => {
  const verifiedNode = await examiner.stores.executionNodes.get(
    session.scope,
    node.executionNodeId,
  );
  if (verifiedNode === undefined) return { kind: "refused", reason: "its node is gone" };
  const gate = await examineInQueue(examiner, {
    session,
    job,
    node: verifiedNode,
    commitSha: verified.commitSha,
    base: head,
    verification: verified.verification,
  });
  if (gate.kind === "land") return { examination: gate.examination };
  const after = await examiner.stores.executionNodes.get(session.scope, node.executionNodeId);
  return { kind: "failed", reason: after?.outcomeReason ?? "its examination stopped it" };
};

/**
 * What examination a deferred node brings to its landing (D-P8-14): none needed,
 * the examination of this exact change, or one it is still awaiting.
 */
const carriedAtResume = async (
  environment: LandingEnvironment | ExecutionEnvironment,
  session: RunSession,
  job: JobContract,
  node: ExecutionNode,
  head: CommitSha,
): Promise<Examination | "not_required" | "awaiting"> => {
  if (!requirementOf(session, job).required || node.commitSha === null) return "not_required";
  const diff = await git(
    environment.git,
    ["diff", "--no-color", "--no-ext-diff", head, node.commitSha],
    {
      cwd: session.repoPath,
    },
  );
  const carried = carriedExamination(
    await environment.stores.examinations.listByNode(session.scope, node.executionNodeId),
    patchIdOf(diff),
  );
  return carried ?? "awaiting";
};

/** The full environment, when this resume was given one that can start an examiner. */
const examinerOf = (
  environment: LandingEnvironment | ExecutionEnvironment,
): ExecutionEnvironment | undefined =>
  "harness" in environment && environment.examination !== undefined ? environment : undefined;

export const resumeDeferred = async (
  environment: LandingEnvironment | ExecutionEnvironment,
  resumed: ResumeSession,
): Promise<ResumeResult> => {
  const line = await deferredLine(environment, resumed);
  if (line.length === 0) return { landed: [], discarded: [] };

  // Before any node is touched: a landing refused after sealing ends the node,
  // and a dirty checkout is nobody's verdict on anybody's work.
  const blocked = await checkoutBlocked(environment, resumed);
  if (blocked !== undefined) return { landed: [], blocked, discarded: [] };

  // `verifyNode` and `integrateNode` take a whole session; resuming has no
  // orchestrator, and neither of them reads the two fields it lacks. The run is
  // read for the policy it recorded (P8, D-P8-03): what examination it requires.
  const run = await environment.stores.runs.get(resumed.scope, resumed.scope.runId);
  const session = { ...resumed, ...(run === undefined ? {} : { run }) } as RunSession;
  const ref = provisionalRef(resumed.scope.runId);
  const landed: ExecutionNodeId[] = [];

  for (const [index, node] of line.entries()) {
    const stopped = await landOne(environment, session, node);
    if (stopped === undefined) {
      landed.push(node.executionNodeId);
      continue;
    }
    const stoppedAt = { nodeId: node.executionNodeId, ...stopped };
    // Only a verdict discards. A refused landing leaves the rest deferred, on a
    // line that still holds them, for a resume that can land.
    if (stopped.kind === "refused") return { landed, stoppedAt, discarded: [] };

    const discarded = await discard(environment, node, stopped.reason, line.slice(index + 1));
    await deleteRef(environment.git, resumed.repoPath, ref);
    return { landed, stoppedAt, discarded };
  }

  await deleteRef(environment.git, resumed.repoPath, ref);
  return { landed, discarded: [] };
};

/** Drops what was built on a node whose deferred checks failed, each saying which node that was. */
const discard = async (
  environment: LandingEnvironment,
  failed: ExecutionNode,
  why: string,
  later: readonly ExecutionNode[],
): Promise<ExecutionNodeId[]> => {
  const { stores, clock, outbox } = environment;
  const discarded: ExecutionNodeId[] = [];
  for (const node of later) {
    const reason =
      `discarded: built on ${failed.executionNodeId}, which did not pass its deferred checks ` +
      `(${why}). Its commit ${node.commitSha} is kept under its job branch for reference.`;
    await stores.executionNodes.put({
      ...transition(node, "cancel", nowIso(clock)),
      outcomeReason: reason,
    });
    outbox.emit({
      type: "node.discarded",
      source: "control-plane",
      payload: { builtOn: failed.executionNodeId, commitSha: node.commitSha, reason },
      executionNodeId: node.executionNodeId,
    });
    discarded.push(node.executionNodeId);
  }
  return discarded;
};
