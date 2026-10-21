/**
 * What the runner says of the `orchestrating` stage (2026-10-21): the run's
 * strands and jobs as the plane holds them, in one line. The runner cannot see
 * the engine, which runs the root in a process of its own; it reads the record
 * the engine writes and says where it stands. Without this the stage's first
 * detail, "the root orchestrator is starting", stood on the dispatch for a
 * whole run, and a run twenty hours into its work read as one that had never
 * begun (P20's first run, 2026-10-21).
 */
import type { ExecutionNode, ExecutionNodeStatus, JobContract } from "@nightshift/contracts";

/** The schema's cap on a progress detail. */
export const PROGRESS_DETAIL_MAX = 500;

const LANDED: ReadonlySet<ExecutionNodeStatus> = new Set(["integrated", "succeeded"]);
/** Handed in and on its way through the queue: the word is the status. */
const LANDING: ReadonlySet<ExecutionNodeStatus> = new Set([
  "implemented",
  "verifying",
  "verified",
  "examining",
  "sealed",
]);
const FAILED: ReadonlySet<ExecutionNodeStatus> = new Set([
  "failed",
  "verification_failed",
  "examination_failed",
  "cancelled",
  "interrupted",
]);
const WAITING: ReadonlySet<ExecutionNodeStatus> = new Set(["validated", "queued"]);

const LANDING_WORDS: Partial<Record<ExecutionNodeStatus, string>> = {
  implemented: "landing",
  verifying: "verifying",
  verified: "verified, landing",
  examining: "examining",
  sealed: "sealed, landing",
};

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`;

/** What a strand's jobs are doing, for a strand still building. */
const jobsClause = (jobs: readonly ExecutionNode[]): string => {
  const running = jobs.filter((job) => job.status === "running").length;
  const merged = jobs.filter((job) => job.status === "merged").length;
  const failed = jobs.filter((job) => FAILED.has(job.status)).length;
  const parts = [
    ...(merged === 0 ? [] : [`${merged} merged`]),
    ...(running === 0 ? [] : [`${running} running`]),
    ...(failed === 0 ? [] : [`${failed} failed`]),
  ];
  return parts.length === 0 ? "" : ` (${parts.join(", ")})`;
};

const truncate = (line: string): string =>
  line.length <= PROGRESS_DETAIL_MAX ? line : `${line.slice(0, PROGRESS_DETAIL_MAX - 1)}…`;

/**
 * One line of where the run stands. A planned run is told by its strands: how
 * many have landed, and each other one by name with what it is doing — building
 * (with its jobs' counts), landing (by the queue's word), failed, deferred, or
 * waiting. A run with no strands is told by its jobs. Nothing delegated yet says
 * so. Never longer than the schema allows.
 */
export const orchestratingDetail = (
  nodes: readonly ExecutionNode[],
  jobs: readonly JobContract[],
): string => {
  const jobOf = new Map(jobs.map((job) => [job.jobContractId, job]));
  const strands = nodes
    .filter((node) => node.kind === "sub-program")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (strands.length === 0) {
    const work = nodes.filter((node) => node.kind === "job");
    if (work.length === 0) return "no work delegated yet";
    const landed = work.filter((job) => LANDED.has(job.status) || job.status === "merged").length;
    const running = work.filter((job) => job.status === "running").length;
    const failed = work.filter((job) => FAILED.has(job.status)).length;
    return truncate(
      `${landed} of ${plural(work.length, "job")} landed` +
        (running === 0 ? "" : `; ${running} running`) +
        (failed === 0 ? "" : `; ${failed} failed`),
    );
  }

  const nameOf = (strand: ExecutionNode): string =>
    (strand.jobContractId === null ? undefined : jobOf.get(strand.jobContractId)?.strandId) ??
    `strand ${strand.executionNodeId.slice(-6)}`;
  const landed = strands.filter((strand) => LANDED.has(strand.status));
  const clauses: string[] = [`${landed.length} of ${plural(strands.length, "strand")} landed`];
  const waiting: string[] = [];
  for (const strand of strands) {
    if (LANDED.has(strand.status)) continue;
    const name = nameOf(strand);
    if (WAITING.has(strand.status)) {
      waiting.push(name);
    } else if (strand.status === "running") {
      const own = nodes.filter(
        (node) => node.kind === "job" && node.parentNodeId === strand.executionNodeId,
      );
      clauses.push(`${name} building${jobsClause(own)}`);
    } else if (LANDING.has(strand.status)) {
      clauses.push(`${name} ${LANDING_WORDS[strand.status] ?? "landing"}`);
    } else if (strand.status === "deferred") {
      clauses.push(`${name} deferred`);
    } else if (FAILED.has(strand.status)) {
      clauses.push(
        `${name} ${strand.status === "failed" ? "failed" : strand.status.replaceAll("_", " ")}`,
      );
    }
  }
  if (waiting.length > 0) clauses.push(`${waiting.join(", ")} waiting`);
  return truncate(clauses.join("; "));
};
