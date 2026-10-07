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
 * - **failed**: that is a failure, recorded as one, and handled as a run handles
 *   a failed check (P9, D-P9-07): where a worker can be started
 *   (`nightshift-resume`), the node is retried one rung up with what failed in
 *   its brief, at most twice. Nothing after it is discarded: each later node is
 *   replayed onto whatever the program head now is and verified there, and lands
 *   if it passes. A later change that no longer applies, or a retry that still
 *   fails, is reported, for the owner to plan a correction for.
 *
 * A-05 holds by construction. Nothing here reaches `verified` without a passed
 * `Verification` on its commit, and nothing reaches the program branch that is
 * not `verified`. Claiming a hurdle to dodge a failing test bought provisional
 * progress and nothing else, and this is where it stops.
 *
 * No agent is started but a retry's worker, and an examiner where the run's
 * policy requires one.
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
  RouteChoice,
} from "@nightshift/contracts";
import { nowIso, transition } from "@nightshift/core";
import type { McpLaunch } from "@nightshift/harness";
import type { RouteContext } from "./engine.js";
import type {
  ExecutionEnvironment,
  LandingEnvironment,
  RunSession,
  WorkerLaunchIdentity,
} from "./environment.js";
import {
  carriedExamination,
  examineInQueue,
  patchIdOf,
  recordRulingLanded,
  requirementOf,
  verificationEvidence,
} from "./examine.js";
import {
  addDetachedWorktree,
  changedPaths,
  deleteRef,
  git,
  jobBranch,
  provisionalCommits,
  provisionalRef,
  pruneWorktrees,
  replayCommit,
  revParse,
  tryRevParse,
} from "./git/index.js";
import { checkoutBlocked, integrateNode } from "./integrate.js";
import { repairProvisionalLine } from "./provisional-line.js";
import { attemptsOf, startJob } from "./runner.js";
import { checkChangedPaths, describeScopeViolation } from "./scope-check.js";
import { verifyNode } from "./verify.js";

export interface ResumeResult {
  /** Landed on the program branch, in order, whether as deferred or as retried. */
  readonly landed: readonly ExecutionNodeId[];
  /**
   * Nothing could be landed on this checkout, so **nothing was touched**: every
   * deferred node is still deferred and the provisional line is intact. Fix the
   * checkout and resume again.
   */
  readonly blocked?: string;
  /**
   * Where it stopped without a verdict: a landing was refused, which says
   * nothing about the work after it, so that work stays deferred on the line for
   * the next resume.
   */
  readonly stoppedAt?: {
    readonly nodeId: ExecutionNodeId;
    readonly kind: "refused";
    readonly reason: string;
  };
  /** Nodes whose check failed at resume and were then retried until they landed (P9, D-P9-07). */
  readonly retried: readonly ExecutionNodeId[];
  /**
   * What did not land: a check that failed and whose retries failed too (or that
   * nothing here could retry), or a change that no longer applies on the new head.
   * Each is the owner's to plan a correction for. Nothing is discarded that
   * still verifies.
   */
  readonly failed: readonly { readonly nodeId: ExecutionNodeId; readonly reason: string }[];
}

/**
 * How `resume` retries a check that fails (P9, D-P9-07): as a run would, one
 * rung up with what failed in the worker's brief. Given only where a worker can
 * be started (`nightshift-resume`); without it, a failed check stays failed.
 */
export interface ResumeRetry {
  readonly route: (job: JobContract, context: RouteContext) => RouteChoice;
  readonly mcp: (identity: WorkerLaunchIdentity) => McpLaunch;
}

/** A check that fails at resume is retried at most this often, as a fix is (D-P8-13). */
export const MAX_RESUME_RETRIES = 2;

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

/**
 * `node`, its commit on the program head: as it is when the head is its parent,
 * replayed onto the head otherwise. A replay that conflicts, or that now reaches
 * outside the node's scope, ends the node (`cancel`, the one edge out of
 * `deferred` that is not a verification) with the reason.
 */
const replayedOntoHead = async (
  environment: LandingEnvironment | ExecutionEnvironment,
  session: RunSession,
  node: ExecutionNode,
  worktree: string,
): Promise<{ readonly node: ExecutionNode } | Stopped> => {
  const { stores, clock, git: runner } = environment;
  const commit = node.commitSha;
  if (commit === null) return { node };
  const head = await revParse(runner, session.repoPath, session.program.repository.programBranch);
  const parent = await tryRevParse(runner, session.repoPath, `${commit}^`);
  if (parent === head) return { node };

  const replayed = await replayCommit(runner, {
    worktree,
    commit,
    onto: head,
    atMs: clock.now(),
  });
  const offending = replayed.ok
    ? checkChangedPaths(node.scope, await changedPaths(runner, worktree, head, replayed.commitSha))
    : undefined;
  if (!replayed.ok || (offending !== undefined && !offending.allowed)) {
    const reason = replayed.ok
      ? describeScopeViolation(offending?.allowed === false ? offending.offending : [])
      : `integration_conflict: this change no longer applies on the program head after an ` +
        `earlier deferred node did not land as it was, in ${replayed.conflicts.join(", ") || replayed.detail}. ` +
        "It is kept under its job branch; plan a correction for it.";
    await stores.executionNodes.put({
      ...transition(node, "cancel", nowIso(clock)),
      outcomeReason: reason,
    });
    return { kind: "failed", reason };
  }
  const rebased: ExecutionNode = {
    ...node,
    commitSha: replayed.commitSha,
    updatedAt: nowIso(clock),
  };
  await stores.executionNodes.put(rebased);
  return { node: rebased };
};

/** Runs one deferred node's checks in full and lands it. `undefined` when it landed. */
const landOne = async (
  environment: LandingEnvironment | ExecutionEnvironment,
  session: RunSession,
  deferred: ExecutionNode,
): Promise<Stopped | undefined> => {
  const { stores, git: runner } = environment;
  let node = deferred;
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

  const worktree = await worktreeFor(environment, session, node, node.commitSha as CommitSha);
  // Built on something that did not land as it was (a check that failed, a
  // retry that landed in its place): replayed onto the head first (D-P9-07).
  const current = await replayedOntoHead(environment, session, node, worktree);
  if ("kind" in current) return current;
  node = current.node;

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
  retry?: ResumeRetry,
): Promise<ResumeResult> => {
  // What a stop left at the line's tip without a deferred node goes first: it
  // never finished verifying, and nothing may land on it (provisional-line.ts).
  await repairProvisionalLine(environment, resumed);
  const line = await deferredLine(environment, resumed);
  if (line.length === 0) return { landed: [], retried: [], failed: [] };

  // Before any node is touched: a landing refused after sealing ends the node,
  // and a dirty checkout is nobody's verdict on anybody's work.
  const blocked = await checkoutBlocked(environment, resumed);
  if (blocked !== undefined) return { landed: [], retried: [], failed: [], blocked };

  // `verifyNode` and `integrateNode` take a whole session; resuming has no
  // orchestrator, and neither of them reads the two fields it lacks. The run is
  // read for the policy it recorded (P8, D-P8-03): what examination it requires.
  const run = await environment.stores.runs.get(resumed.scope, resumed.scope.runId);
  const session = {
    ...resumed,
    ...(run === undefined ? {} : { run, rootNodeId: run.rootNodeId }),
  } as RunSession;
  const ref = provisionalRef(resumed.scope.runId);
  const landed: ExecutionNodeId[] = [];
  const retried: ExecutionNodeId[] = [];
  const failed: { nodeId: ExecutionNodeId; reason: string }[] = [];
  const retrier = retrierOf(environment, retry);

  for (const node of line) {
    const stopped = await landOne(environment, session, node);
    if (stopped === undefined) {
      landed.push(node.executionNodeId);
      continue;
    }
    // A refused landing is no verdict: the rest stays deferred, on a line that
    // still holds it, for a resume that can land.
    if (stopped.kind === "refused") {
      return {
        landed,
        retried,
        failed,
        stoppedAt: { nodeId: node.executionNodeId, kind: "refused", reason: stopped.reason },
      };
    }
    // A verdict (P9, D-P9-07). The line past here no longer leads anywhere: a
    // retry is cut from the program head, and what follows is replayed onto
    // whatever lands, each verified there. Nothing is discarded for having
    // been built on this.
    await deleteRef(environment.git, resumed.repoPath, ref);
    if (
      stopped.kind === "failed" &&
      retrier !== undefined &&
      (await retrier(session, node.executionNodeId))
    ) {
      retried.push(node.executionNodeId);
      landed.push(node.executionNodeId);
      continue;
    }
    failed.push({ nodeId: node.executionNodeId, reason: stopped.reason });
  }

  await deleteRef(environment.git, resumed.repoPath, ref);
  return { landed, retried, failed };
};

/** The retry, when this resume can start workers and was told how. */
const retrierOf = (
  environment: LandingEnvironment | ExecutionEnvironment,
  retry: ResumeRetry | undefined,
): ((session: RunSession, nodeId: ExecutionNodeId) => Promise<boolean>) | undefined =>
  retry !== undefined && "harness" in environment
    ? (session, nodeId) => retryFailedCheck(environment, session, nodeId, retry)
    : undefined;

/**
 * A node whose check failed at resume, run again as a run would (D-P9-07,
 * D-P8-07): one rung up, with what failed in the worker's brief, verified and
 * landed where it stands. True once it has landed; at most
 * {@link MAX_RESUME_RETRIES} tries.
 */
const retryFailedCheck = async (
  environment: ExecutionEnvironment,
  session: RunSession,
  nodeId: ExecutionNodeId,
  retry: ResumeRetry,
): Promise<boolean> => {
  const { stores, clock } = environment;
  for (let attempt = 0; attempt < MAX_RESUME_RETRIES; attempt += 1) {
    const node = await stores.executionNodes.get(session.scope, nodeId);
    if (node?.status === "integrated") return true;
    if (
      node === undefined ||
      node.status !== "verification_failed" ||
      node.jobContractId === null
    ) {
      return false;
    }
    const job = await stores.jobContracts.get(session.scope, node.jobContractId);
    const verification = (await stores.verifications.listByNode(session.scope, nodeId)).at(-1);
    if (job === undefined || verification === undefined) return false;
    const failedSteps = (await verificationEvidence(environment, verification)).filter(
      (step) => step.exitCode !== undefined && step.exitCode !== 0,
    );
    const last = attemptsOf(await stores.routingDecisions.listByNode(session.scope, nodeId)).at(-1);
    const route = retry.route(job, {
      unavailable: [],
      ...(last === undefined
        ? {}
        : {
            previous: {
              target: last.chosen,
              ladder: last.ladder,
              rungIndex: last.rung?.index,
              climb: true,
            },
          }),
    });
    const { outcomeReason: _why, ...rest } = transition(node, "retry", nowIso(clock));
    const queued: ExecutionNode = { ...rest, commitSha: null };
    await stores.executionNodes.put(queued);
    const started = await startJob(environment, {
      session,
      job,
      node: queued,
      route,
      mcp: retry.mcp,
      task: {
        kind: "retry_failed_check",
        failed: failedSteps.map((step) => ({
          stepId: step.stepId,
          command: step.command,
          exitCode: step.exitCode ?? null,
          output: step.logTail ?? "",
        })),
      },
    });
    await started.completion;
  }
  return (await stores.executionNodes.get(session.scope, nodeId))?.status === "integrated";
};
