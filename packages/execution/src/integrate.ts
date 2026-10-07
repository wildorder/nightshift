/**
 * Seal, integrate, checkpoint (D-P3-05, A-10, A-29).
 *
 * The last three steps, and the only ones that touch the operator's own
 * repository. Each is deliberately small and each refuses loudly rather than
 * improvising:
 *
 * - **Seal** is a ref at the verified commit, `refs/nightshift/sealed/<nodeId>`,
 *   plus the node reaching `sealed`. The ref is what makes the commit durably
 *   addressable after the worktree and its branch are gone — a commit reachable
 *   from nothing is a commit `gc` is entitled to delete.
 * - **Integrate** is `git merge --ff-only`. Not a merge commit, not a rebase. A
 *   program branch that moved since the worktree was cut is a durable
 *   `stale_base` failure naming both commits; reconciling it is P6.
 * - **Checkpoint** is a ref and a record at the integrated commit, so replay has
 *   somewhere to return to.
 *
 * Examination is skipped entirely: it is unavailable in P3 (D-P3-07) and a
 * delegation whose risk would require it was refused before the worker started.
 * `verified → sealed` is the direct edge `core`'s table already allows.
 *
 * ## The operator's working tree
 *
 * Integration fast-forwards the branch the operator has checked out, which moves
 * their working tree. That is the only write Nightshift makes into the program
 * checkout, and it refuses when the checkout is dirty rather than fast-forwarding
 * over someone's work in progress.
 */
import type {
  AgentId,
  CheckpointId,
  CommitSha,
  Examination,
  ExecutionNode,
  ExecutionNodeId,
} from "@nightshift/contracts";
import { nowIso, transition } from "@nightshift/core";
import type { LandingEnvironment, RunSession } from "./environment.js";
import { reconcileGateRepairs } from "./gate-repair.js";
import {
  checkpointRef,
  currentBranch,
  fastForward,
  isDirty,
  removeWorktree,
  revParse,
  sealedRef,
  updateRef,
} from "./git/index.js";
import { discardScratch } from "./scratch.js";
import { stampJobDecisions } from "./stamp.js";

export interface IntegrateInput {
  readonly session: RunSession;
  readonly nodeId: ExecutionNodeId;
  readonly agentId: AgentId;
  readonly worktree: string;
  readonly branch: string;
  /** The commit the worktree was cut from. Integration requires it unmoved. */
  readonly base: CommitSha;
  readonly commitSha: CommitSha;
  /**
   * P8 (D-P8-09): the examination that lets this commit land. Present, the node
   * goes `verified → examining → sealed` through the table's examination edges;
   * absent, `verified → sealed` directly, as before P8.
   */
  readonly examination?: Examination;
}

export type IntegrateResult =
  | { readonly kind: "integrated"; readonly checkpointId: CheckpointId }
  | { readonly kind: "refused"; readonly reason: string };

/** Every reason the program checkout is not in a state to be fast-forwarded. */
/**
 * Why nothing can be landed on this checkout right now, whatever the commit:
 * the wrong branch, or somebody's uncommitted work. Asked **before** a resume
 * touches any node, because a refusal after sealing ends the node.
 */
export const checkoutBlocked = async (
  environment: Pick<LandingEnvironment, "git">,
  session: Pick<RunSession, "repoPath" | "program">,
): Promise<string | undefined> => {
  const repo = session.repoPath;
  const programBranch = session.program.repository.programBranch;
  const branch = await currentBranch(environment.git, repo);
  if (branch !== programBranch) {
    return `program_checkout_wrong_branch: the checkout at ${repo} is on "${branch}", not the program branch "${programBranch}"`;
  }
  if (await isDirty(environment.git, repo)) {
    return `program_checkout_dirty: the checkout at ${repo} has uncommitted changes, and Nightshift will not fast-forward over them`;
  }
  return undefined;
};

const blockingReason = async (
  environment: LandingEnvironment,
  input: IntegrateInput,
): Promise<string | undefined> => {
  const repo = input.session.repoPath;
  const programBranch = input.session.program.repository.programBranch;

  const branch = await currentBranch(environment.git, repo);
  if (branch !== programBranch) {
    return `program_checkout_wrong_branch: the checkout at ${repo} is on "${branch}", not the program branch "${programBranch}"`;
  }
  if (await isDirty(environment.git, repo)) {
    return `program_checkout_dirty: the checkout at ${repo} has uncommitted changes, and Nightshift will not fast-forward over them`;
  }
  const head = await revParse(environment.git, repo, programBranch);
  if (head !== input.base) {
    // Named rather than reconciled: rebasing verified work onto a moved base
    // would mean verifying something nobody verified. P6 does this properly.
    return `stale_base: the worktree was cut from ${input.base} but "${programBranch}" is now at ${head}. Reconciling a moved base arrives in P6.`;
  }
  return undefined;
};

export const integrateNode = async (
  environment: LandingEnvironment,
  input: IntegrateInput,
): Promise<IntegrateResult> => {
  const { stores, clock, outbox, git: runner } = environment;
  const repo = input.session.repoPath;

  const node = await stores.executionNodes.get(input.session.scope, input.nodeId);
  if (node === undefined || node.status !== "verified") {
    return { kind: "refused", reason: "the node is not verified" };
  }

  // --- Seal: the commit becomes addressable, whatever happens next -------------
  await updateRef(runner, repo, sealedRef(input.nodeId), input.commitSha);
  let sealed: ExecutionNode;
  if (input.examination === undefined) {
    sealed = transition(node, "seal", nowIso(clock));
  } else {
    // The examination that cleared it, carried or made here (D-P8-09).
    const examining = transition(node, "begin_examination", nowIso(clock));
    await stores.executionNodes.put(examining);
    sealed = transition(examining, "examination_passed", nowIso(clock));
  }
  await stores.executionNodes.put(sealed);

  // --- Integrate ---------------------------------------------------------------
  const blocked = await blockingReason(environment, input);
  if (blocked !== undefined) {
    await failSealed(environment, input, blocked);
    return { kind: "refused", reason: blocked };
  }

  const merged = await fastForward(runner, repo, input.commitSha, clock.now());
  if (!merged.ok) {
    const reason = `stale_base: the program branch could not be fast-forwarded onto ${input.commitSha}: ${merged.detail}`;
    await failSealed(environment, input, reason);
    return { kind: "refused", reason };
  }

  const integrated = transition(sealed, "integrate", nowIso(clock));
  await stores.executionNodes.put(integrated);
  outbox.emit({
    type: "node.integrated",
    source: "control-plane",
    payload: {
      commitSha: input.commitSha,
      programBranch: input.session.program.repository.programBranch,
      sealedRef: sealedRef(input.nodeId),
    },
    executionNodeId: input.nodeId,
    agentId: input.agentId,
  });

  // --- Checkpoint ---------------------------------------------------------------
  const checkpointId = environment.ids.next("ckpt");
  const ref = checkpointRef(checkpointId);
  await updateRef(runner, repo, ref, input.commitSha);
  await stores.checkpoints.put({
    schemaVersion: 1,
    ...input.session.scope,
    checkpointId,
    executionNodeId: input.nodeId,
    commitSha: input.commitSha,
    ref,
    label: `integrated ${input.nodeId}`,
    createdAt: nowIso(clock),
  });
  outbox.emit({
    type: "checkpoint.created",
    source: "control-plane",
    payload: { checkpointId, ref, commitSha: input.commitSha },
    executionNodeId: input.nodeId,
  });

  // --- Publication (P10, D-P10-22) ------------------------------------------------
  // The branch moved here; on a machine the publisher moves GitHub's copy. The
  // hook keeps its own order and never fails the landing: the commit is
  // integrated and checkpointed whether or not the request got out.
  if (environment.publish !== undefined) {
    await environment
      .publish({
        head: input.commitSha,
        programBranch: input.session.program.repository.programBranch,
        repoPath: repo,
      })
      .catch(() => undefined);
  }

  // --- What its decisions produced (P9, D-P9-01) ----------------------------------
  await stampJobDecisions(
    environment,
    input.session.scope,
    { executionNodeId: input.nodeId },
    input.commitSha,
    checkpointId,
  );

  // --- The worktree has done its job --------------------------------------------
  // Only on the happy path. Every failure keeps it, because a worktree is the
  // only place a human can see what the worker actually did.
  await removeWorktree(runner, repo, input.worktree, input.branch, input.nodeId).catch(() => {
    // A worktree that will not go is untidy, not incorrect: the work is
    // integrated and the checkpoint exists. `git worktree prune` clears it later.
  });
  await discardScratch(environment.paths, input.worktree);

  // --- What a repair did to the gates (P15, D-P15-04, D-P15-07, D-P15-11) ----------
  // Every landing passes here, whoever lands it (the merge queue, a readmitted
  // dispute, `nightshift resume`), and before the next landing can start: the
  // definitions the next verification reads, the gate-health record and the
  // setup reference are brought up to date with every repair that has landed.
  // It never fails the landing; the work is integrated whatever it finds.
  await reconcileGateRepairs(environment, input.session, {
    landed: input.nodeId,
    nodeId: input.nodeId,
  });

  return { kind: "integrated", checkpointId };
};

/**
 * A sealed node that could not integrate.
 *
 * `sealed → failed` is not in the node table — sealed work is verified work, and
 * the table only lets it integrate or be cancelled. So the durable outcome is
 * `cancelled` with the reason, which is honest: the work is verified and sealed,
 * and it was this *integration attempt* that was abandoned. The sealed ref
 * survives, so P6 can pick the commit up and reconcile it.
 */
const failSealed = async (
  environment: LandingEnvironment,
  input: IntegrateInput,
  reason: string,
): Promise<void> => {
  const node = await environment.stores.executionNodes.get(input.session.scope, input.nodeId);
  if (node === undefined || node.status !== "sealed") return;
  await environment.stores.executionNodes.put({
    ...transition(node, "cancel", nowIso(environment.clock)),
    outcomeReason: reason,
  });
  environment.outbox.emit({
    type: "node.cancelled",
    source: "control-plane",
    payload: {
      reason,
      commitSha: input.commitSha,
      sealedRef: sealedRef(input.nodeId),
      worktree: input.worktree,
    },
    executionNodeId: input.nodeId,
    agentId: input.agentId,
  });
};
