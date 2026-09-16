/**
 * Deterministic verification, and the only place a `Verification` is written
 * (D-P3-06, A-05).
 *
 * ## Why this is not reachable from a worker
 *
 * A worker can move a node to `implemented` and no further. Verification runs
 * here, in the execution layer, after the worker's process has exited, on a
 * **clean checkout** of the commit the worker produced. So a worker cannot run
 * the verification itself and report the result, cannot leave a dirty worktree
 * that makes the tests pass, and cannot write the record that would make its own
 * work `verified`. The MCP server registers no tool that creates one, in either
 * role.
 *
 * The clean checkout matters more than it looks. `reset --hard` and `clean -fd`
 * discard everything the worker left that is not in the commit — so what is
 * verified is exactly what would integrate. Ignored files survive, because
 * `clean` is run without `-x`: dependencies stay installed and verification
 * needs no reinstall. What is verified is therefore the tracked tree plus
 * whatever is ignored, which is what a developer running the same commands would
 * get.
 *
 * ## Order
 *
 * Node to `verifying`, run the steps, upload each step's output as an artifact,
 * write the `Verification`, and only then transition. The record exists before
 * the status that depends on it, so a reader can never find a `verified` node
 * with no evidence — and `core`'s `markVerified` would refuse anyway.
 */
import type {
  AgentId,
  ArtifactId,
  CommitSha,
  ExecutionNode,
  JobContract,
  Verification,
} from "@nightshift/contracts";
import { VerificationSchema } from "@nightshift/contracts";
import { markVerificationFailed, markVerified, nowIso, transition } from "@nightshift/core";
import { outcomeOf, runVerificationSteps, toVerificationCommands } from "@nightshift/verification";
import {
  DEFAULT_VERIFICATION_TIMEOUT_MS,
  type ExecutionEnvironment,
  type RunSession,
} from "./environment.js";
import { cleanCheckout } from "./git/index.js";
import { recordArtifact } from "./runner.js";

export interface VerifyInput {
  readonly session: RunSession;
  readonly node: ExecutionNode;
  readonly job: JobContract;
  readonly agentId: AgentId;
  readonly worktree: string;
}

export type VerifyResult =
  | { readonly passed: true; readonly commitSha: CommitSha; readonly verification: Verification }
  | { readonly passed: false; readonly verification?: Verification };

export const verifyNode = async (
  environment: ExecutionEnvironment,
  input: VerifyInput,
): Promise<VerifyResult> => {
  const { stores, clock, outbox } = environment;
  const commitSha = input.node.commitSha;
  if (commitSha === null) {
    // `markImplemented` records the commit, so an implemented node without one
    // is a defect rather than a state to handle gracefully.
    throw new Error(`node ${input.node.executionNodeId} is implemented but carries no commit`);
  }

  const verifying = transition(input.node, "begin_verification", nowIso(clock));
  await stores.executionNodes.put(verifying);
  const startedAt = nowIso(clock);
  outbox.emit({
    type: "verification.requested",
    source: "control-plane",
    payload: {
      commitSha,
      steps: input.session.program.verification.map((step) => step.id),
    },
    executionNodeId: input.node.executionNodeId,
    agentId: input.agentId,
  });

  // Exactly what would integrate, and nothing the worker left behind.
  await cleanCheckout(environment.git, input.worktree, commitSha);

  const results = await runVerificationSteps({
    steps: input.session.program.verification,
    cwd: input.worktree,
    timeoutMs: environment.verificationTimeoutMs ?? DEFAULT_VERIFICATION_TIMEOUT_MS,
  });

  // Each step's whole output, in S3 and referenced — never inline (A-08).
  const logArtifactIds = new Map<string, ArtifactId>();
  for (const result of results) {
    const artifactId = await recordArtifact(environment, {
      scope: input.session.scope,
      nodeId: input.node.executionNodeId,
      kind: "verification-log",
      contentType: "text/plain; charset=utf-8",
      bytes: result.output,
    });
    logArtifactIds.set(result.stepId, artifactId as ArtifactId);
  }

  const verification = VerificationSchema.parse({
    schemaVersion: 1,
    ...input.session.scope,
    verificationId: environment.ids.next("ver"),
    executionNodeId: input.node.executionNodeId,
    jobContractId: input.job.jobContractId,
    // The agent whose work is under verification, not a verifying agent: nothing
    // verifies, in the sense of an agent. A command does.
    agentId: input.agentId,
    commitSha,
    commands: toVerificationCommands(results, logArtifactIds),
    outcome: outcomeOf(results),
    startedAt,
    endedAt: nowIso(clock),
  } satisfies Record<string, unknown>) as Verification;
  await stores.verifications.put(verification);

  const at = nowIso(clock);
  if (verification.outcome === "passed") {
    // `markVerified` refuses evidence that does not match the work: a different
    // commit, a different job, a different run. It is the rule, not this module.
    await stores.executionNodes.put(markVerified(verifying, verification, at));
    outbox.emit({
      type: "verification.completed",
      source: "control-plane",
      payload: {
        verificationId: verification.verificationId,
        outcome: "passed",
        commitSha,
        commands: verification.commands.map((command) => ({
          stepId: command.stepId,
          exitCode: command.exitCode,
          durationMs: command.durationMs,
        })),
      },
      executionNodeId: input.node.executionNodeId,
      agentId: input.agentId,
    });
    return { passed: true, commitSha, verification };
  }

  const failing = verification.commands.filter((command) => command.exitCode !== 0);
  await stores.executionNodes.put({
    ...markVerificationFailed(verifying, verification, at),
    outcomeReason: `verification failed: ${failing
      .map((command) => `${command.stepId} exited ${command.exitCode}`)
      .join(", ")}`,
  });
  outbox.emit({
    type: "verification.completed",
    source: "control-plane",
    payload: {
      verificationId: verification.verificationId,
      outcome: "failed",
      commitSha,
      failingSteps: failing.map((command) => command.stepId),
      // Nothing is sealed and nothing integrates; the worktree is kept so a
      // human can look at what the commands saw.
      worktree: input.worktree,
    },
    executionNodeId: input.node.executionNodeId,
    agentId: input.agentId,
  });
  return { passed: false, verification };
};
