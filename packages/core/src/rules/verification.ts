/**
 * Verification state (A-05, SC-P1-13, SC-P1-14).
 *
 * `implemented ≠ verified`. A worker may report completion, which moves a node
 * to `implemented`. Only a `Verification` record can move it to `verified`, and
 * only work that reached `verified` can be sealed and integrated.
 *
 * Note what this module does *not* offer: there is no function that sets
 * `verified` without evidence. That absence is the enforcement. A caller wanting
 * to shortcut it would have to construct a passing `Verification`, which means
 * producing command results with zero exit codes, which the contract schema
 * cross-checks.
 */
import type { CommitSha, ExecutionNode, IsoTimestamp, Verification } from "@nightshift/contracts";
import { VerificationEvidenceError } from "../errors.js";
import { sameRun } from "./ownership.js";
import { transition } from "./transitions.js";

/**
 * Every reason `verification` fails to evidence `node`. Empty means the evidence
 * matches the work.
 */
export const explainEvidenceMismatch = (
  node: ExecutionNode,
  verification: Verification,
): readonly string[] => {
  const reasons: string[] = [];

  if (!sameRun(node, verification)) {
    reasons.push(
      `verification belongs to a different ownership chain (${verification.projectId}/${verification.programId}/${verification.runId})`,
    );
  }

  if (verification.executionNodeId !== node.executionNodeId) {
    reasons.push(
      `verification targets node ${verification.executionNodeId}, not ${node.executionNodeId}`,
    );
  }

  if (node.jobContractId === null) {
    reasons.push(`node ${node.executionNodeId} has no job contract to verify`);
  } else if (verification.jobContractId !== node.jobContractId) {
    reasons.push(
      `verification targets job ${verification.jobContractId}, not ${node.jobContractId}`,
    );
  }

  if (node.commitSha === null) {
    reasons.push(`node ${node.executionNodeId} has no commit to verify`);
  } else if (verification.commitSha !== node.commitSha) {
    reasons.push(
      `verification covers commit ${verification.commitSha}, but the node is on ${node.commitSha}`,
    );
  }

  if (verification.outcome !== "passed") {
    reasons.push(`verification outcome is "${verification.outcome}"`);
  }

  return reasons;
};

/** Whether `verification` is adequate evidence that `node`'s work is verified. */
export const isValidEvidence = (node: ExecutionNode, verification: Verification): boolean =>
  explainEvidenceMismatch(node, verification).length === 0;

/**
 * Moves `node` to `verified` on the strength of `verification`.
 *
 * Throws when the evidence does not match the work, or when the node is not in
 * `verifying`. Both are `VerificationEvidenceError`: from a caller's point of
 * view, asserting verification without standing in the verification step is the
 * same class of mistake as asserting it without evidence.
 */
export const markVerified = (
  node: ExecutionNode,
  verification: Verification,
  at: IsoTimestamp,
): ExecutionNode => {
  const reasons = explainEvidenceMismatch(node, verification);
  if (reasons.length > 0) throw new VerificationEvidenceError(reasons.join("; "));
  return transition(node, "verification_passed", at);
};

/**
 * Records that verification failed. The node does not become `verified`, and the
 * failure is durable rather than a silent absence.
 */
export const markVerificationFailed = (
  node: ExecutionNode,
  verification: Verification,
  at: IsoTimestamp,
): ExecutionNode => {
  if (verification.outcome !== "failed") {
    throw new VerificationEvidenceError(
      `cannot record a failure from a verification whose outcome is "${verification.outcome}"`,
    );
  }
  return transition(node, "verification_failed", at);
};

/**
 * Records a worker's own claim of completion, together with the commit it
 * produced. This is the furthest a worker can move a node: `implemented`.
 */
export const markImplemented = (
  node: ExecutionNode,
  commitSha: CommitSha,
  at: IsoTimestamp,
): ExecutionNode => ({
  ...transition(node, "report_implemented", at),
  commitSha,
});

/**
 * Whether a node's recorded commit still matches the base it was verified
 * against. A commit that was green against an outdated base is not
 * automatically acceptable once other jobs integrate (architecture §4); the
 * execution layer uses this to decide when to rebase and reverify.
 */
export const isVerificationStale = (
  node: ExecutionNode,
  verification: Verification,
  currentCommitSha: CommitSha,
): boolean => verification.commitSha !== currentCommitSha || node.commitSha !== currentCommitSha;
