/**
 * Why an attempt was made (P20, S-05): the explicit causes a retry records on
 * its routing decision, derived from the records of how the attempt before it
 * ended. Pure; identifiers and short metadata only. A retry with mixed causes
 * records each.
 */
import type { AttemptCause, Examination, ExecutionNode, Verification } from "@nightshift/contracts";
import type { fixOf } from "./examine.js";
import type { strandFailures } from "./strand.js";

/** What a strand's landing failed on, as `strandFailures` reads it. */
export type StrandFailures = Awaited<ReturnType<typeof strandFailures>>;

export interface CausesOfRetryInput {
  readonly node: Pick<ExecutionNode, "status" | "outcomeReason">;
  readonly examinations: readonly Examination[];
  readonly fix: ReturnType<typeof fixOf>;
  readonly verifications?: readonly Verification[] | undefined;
  readonly strandFailures?: StrandFailures | undefined;
}

const MAX_DETAIL = 400;
const MAX_IDS = 32;
const MAX_PATHS = 50;
const UNREPORTED = "the worker exited 0 without reporting completion";

const newest = <T extends { readonly createdAt: string }>(items: readonly T[]): T | undefined =>
  [...items].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1);

const latestFailedVerification = (
  verifications: readonly Verification[] | undefined,
): Verification | undefined =>
  [...(verifications ?? [])]
    .filter((record) => record.outcome === "failed")
    .sort((a, b) => a.endedAt.localeCompare(b.endedAt))
    .at(-1);

/** The paths a queue's conflict reason names, when it names any. */
const conflictPaths = (reason: string): string[] => {
  const named = /\bsince it started, in (.+?)\. Nothing was/s.exec(reason)?.[1];
  if (named === undefined) return [];
  return named
    .split(", ")
    .map((path) => path.trim())
    .filter((path) => path !== "")
    .slice(0, MAX_PATHS);
};

const withVerification = (verifications: readonly Verification[] | undefined): AttemptCause => {
  const failed = latestFailedVerification(verifications);
  return {
    kind: "verification_failed",
    ...(failed === undefined ? {} : { verificationId: failed.verificationId }),
  };
};

/** The examination that holds the upheld findings a ruling is about. */
const holdingExamination = (
  examinations: readonly Examination[],
  findingIds: ReadonlySet<string>,
): Examination | undefined =>
  newest(
    examinations.filter((examination) =>
      examination.findings.some(
        (finding) => findingIds.has(finding.id) && finding.resolution === "upheld",
      ),
    ),
  );

const rulingCause = (
  examinations: readonly Examination[],
  rulings: readonly { readonly findingId: string; readonly decisionId: string }[],
): AttemptCause => {
  const findingIds = rulings.map((ruling) => ruling.findingId).slice(0, MAX_IDS);
  const holder = holdingExamination(examinations, new Set(findingIds));
  return {
    kind: "ruling",
    decisionIds: rulings.map((ruling) => ruling.decisionId).slice(0, MAX_IDS),
    findingIds,
    ...(holder === undefined ? {} : { examinationId: holder.examinationId }),
  } as AttemptCause;
};

const findingsCause = (
  examinations: readonly Examination[],
  findings: readonly { readonly id: string }[],
): AttemptCause => {
  const latest = newest(examinations);
  return {
    kind: "examination_findings",
    findingIds: findings.map((finding) => finding.id).slice(0, MAX_IDS),
    ...(latest === undefined ? {} : { examinationId: latest.examinationId }),
  };
};

/**
 * The causes of the attempt that follows a node's last ending. A fix of
 * examination findings, or an arbiter's ruling, is the cause of its attempt; a
 * status and reason explain the rest. A strand's fix round is `strand_landing`
 * with one cause for each kind of failure it carries.
 */
export const causesOfRetry = (input: CausesOfRetryInput): AttemptCause[] => {
  const { node, examinations, fix, verifications, strandFailures: strand } = input;

  if (strand !== undefined) {
    const causes: AttemptCause[] = [{ kind: "strand_landing" }];
    if (strand.failedChecks.length > 0) causes.push(withVerification(verifications));
    if (strand.findings.length > 0) causes.push(findingsCause(examinations, strand.findings));
    if (strand.rulings !== undefined && strand.rulings.length > 0) {
      causes.push(rulingCause(examinations, strand.rulings));
    }
    if (strand.conflict !== undefined) {
      causes.push({
        kind: "integration_conflict",
        paths: conflictPaths(strand.conflict),
        detail: strand.conflict.slice(0, MAX_DETAIL),
      });
    }
    return causes;
  }

  const task = fix.task;
  if (task?.kind === "fix") {
    const causes: AttemptCause[] = [
      task.rulings !== undefined && task.rulings.length > 0
        ? rulingCause(examinations, task.rulings)
        : findingsCause(examinations, task.findings),
    ];
    if (node.status === "verification_failed") causes.push(withVerification(verifications));
    return causes;
  }

  const reason = node.outcomeReason ?? "";
  if (node.status === "verification_failed") return [withVerification(verifications)];
  if (reason.startsWith("integration_conflict")) {
    const paths = conflictPaths(reason);
    return [{ kind: "integration_conflict", ...(paths.length === 0 ? {} : { paths }) }];
  }
  if (reason.startsWith("route_unavailable")) {
    return [{ kind: "route_unavailable", detail: reason.slice(0, MAX_DETAIL) }];
  }
  if (reason === UNREPORTED) return [{ kind: "unreported" }];
  if (node.status === "interrupted") return [{ kind: "interrupted" }];
  if (node.status === "failed") {
    return [{ kind: "worker_failed", detail: reason.slice(0, MAX_DETAIL) }];
  }
  return [{ kind: "unknown" }];
};
