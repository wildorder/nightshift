/**
 * The run's end gates (A-57): the verification steps declared `at: "end"`,
 * run once on the program head when the run's work has all landed, and again
 * after each fix that lands. Never per job.
 *
 * A whole-system gate — an end-to-end suite against a built, migrated
 * system — proves the program, not a job, and paying for it on every landing
 * made a night's run take the night several times over. So a job's
 * verification runs the landing steps (`landingSteps`), and these run when the
 * orchestrator asks to finish the run as `succeeded`: on a fresh checkout of
 * the program head, with setup, through the same `runVerification` the queue
 * uses, recorded as a `Verification` of phase `run` on the program node, which
 * has no job. A failure is the orchestrator's to read and to fix with a job;
 * `succeeded` is refused until the head they ran on has passed them.
 *
 * The record stands for its head: asked again with nothing landed, the answer
 * is the record, not another run of the suite.
 */
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { CommitSha, Verification } from "@nightshift/contracts";
import { setupAsStep } from "@nightshift/verification";
import type { ExecutionEnvironment, RunSession } from "./environment.js";
import { verificationEvidence } from "./examine.js";
import { endSteps, gateDefinitions } from "./gate-repair.js";
import { addDetachedWorktree, pruneWorktrees, revParse, tryGit } from "./git/index.js";
import { discardScratch } from "./scratch.js";
import { runVerification } from "./verify.js";

/** One end gate that ran and failed, with the tail of what it printed. */
export interface FailedEndGate {
  readonly stepId: string;
  readonly command: string;
  readonly exitCode?: number | undefined;
  readonly logTail?: string | undefined;
}

export type EndGatesResult =
  /** The contract holds no end gates: nothing to run. */
  | { readonly status: "none" }
  | {
      readonly status: "passed";
      readonly commitSha: CommitSha;
      readonly verification: Verification;
    }
  | {
      readonly status: "failed";
      readonly commitSha: CommitSha;
      readonly verification: Verification;
      readonly failing: readonly FailedEndGate[];
    }
  /** Every gate that could run passed; some wait on a human prerequisite (D-P7-10). */
  | {
      readonly status: "deferred";
      readonly commitSha: CommitSha;
      readonly verification: Verification;
      readonly waitingOn: readonly string[];
    };

/** The program head: the commit the run's landings have brought the program branch to. */
const programHead = (environment: ExecutionEnvironment, session: RunSession): Promise<CommitSha> =>
  revParse(
    environment.git,
    session.repoPath,
    `refs/heads/${session.program.repository.programBranch}`,
  );

/** What the record says, as the orchestrator is told it. */
const resultOf = async (
  environment: ExecutionEnvironment,
  verification: Verification,
): Promise<EndGatesResult> => {
  const commitSha = verification.commitSha;
  if (verification.outcome === "passed") return { status: "passed", commitSha, verification };
  if (verification.outcome === "deferred") {
    const waitingOn = [
      ...new Set(
        verification.commands.flatMap((command) =>
          command.deferred === undefined ? [] : [command.deferred.prerequisiteId],
        ),
      ),
    ];
    return { status: "deferred", commitSha, verification, waitingOn };
  }
  const failed = new Set(
    verification.commands
      .filter((command) => command.deferred === undefined && command.exitCode !== 0)
      .map((command) => command.stepId),
  );
  const evidence = await verificationEvidence(environment, verification);
  return {
    status: "failed",
    commitSha,
    verification,
    failing: evidence.filter((step) => failed.has(step.stepId)),
  };
};

/**
 * Runs the end gates on `head`, in a detached checkout of it that goes when
 * they have run, and records the verification on the program node.
 */
const runEndGates = async (
  environment: ExecutionEnvironment,
  session: RunSession,
  head: CommitSha,
): Promise<Verification> => {
  const gates = await gateDefinitions(environment, session);
  const steps = endSteps(gates);
  const { outbox } = environment;
  const nodeId = session.rootNodeId;
  const worktree = environment.paths.worktree(session.scope.runId, nodeId);
  const checkout = `${worktree}-end-${environment.ids.next("ver").slice(-8).toLowerCase()}`;
  await mkdir(dirname(checkout), { recursive: true });
  await pruneWorktrees(environment.git, session.repoPath);
  await addDetachedWorktree(environment.git, {
    repo: session.repoPath,
    path: checkout,
    base: head,
  });
  outbox.emit({
    type: "verification.requested",
    source: "control-plane",
    payload: {
      commitSha: head,
      phase: "run",
      steps: [...gates.setup.map((step) => setupAsStep(step).id), ...steps.map((step) => step.id)],
    },
    executionNodeId: nodeId,
    agentId: session.orchestratorAgentId,
  });
  try {
    const { verification, waitingOn, flakyPayload } = await runVerification(environment, {
      session,
      nodeId,
      jobContractId: null,
      agentId: session.orchestratorAgentId,
      checkout,
      commitSha: head,
      gates,
      steps,
      phase: "run",
      label: "end gates",
    });
    const failing = verification.commands.filter(
      (command) => command.deferred === undefined && command.exitCode !== 0,
    );
    outbox.emit({
      type: "verification.completed",
      source: "control-plane",
      payload: {
        verificationId: verification.verificationId,
        outcome: verification.outcome,
        commitSha: head,
        phase: "run",
        ...(failing.length === 0 ? {} : { failingSteps: failing.map((command) => command.stepId) }),
        ...(waitingOn.length === 0 ? {} : { waitingOn }),
        ...flakyPayload,
      },
      executionNodeId: nodeId,
      agentId: session.orchestratorAgentId,
    });
    return verification;
  } finally {
    // Its logs are artifacts and its record is written; the checkout has nothing left to show.
    await environment.reclaim?.(checkout).catch(() => undefined);
    await tryGit(environment.git, ["worktree", "remove", "--force", checkout], {
      cwd: session.repoPath,
    }).catch(() => undefined);
    await discardScratch(environment.paths, checkout, environment.reclaim);
    await pruneWorktrees(environment.git, session.repoPath).catch(() => undefined);
  }
};

/**
 * The run's end gates against the program head as it stands: the record for
 * that head when there is one, otherwise a run of them now.
 */
export const verifyRunHead = async (
  environment: ExecutionEnvironment,
  session: RunSession,
): Promise<EndGatesResult> => {
  const gates = await gateDefinitions(environment, session);
  if (endSteps(gates).length === 0) return { status: "none" };
  const head = await programHead(environment, session);
  const recorded = (
    await environment.stores.verifications.listByNode(session.scope, session.rootNodeId)
  )
    .filter((verification) => verification.phase === "run" && verification.commitSha === head)
    .at(-1);
  const verification = recorded ?? (await runEndGates(environment, session, head));
  return resultOf(environment, verification);
};
