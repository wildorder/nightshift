/**
 * A program's status (P13, D-P13-09): what a person opens the Studio to learn.
 * What landed, what waits on them and why, what failed, and what it cost against
 * the budget. Computed from the report and nothing else, so the program card and
 * the run's Status tab cannot disagree, and the CLI's report can say the same.
 */
import type { ExecutionNodeStatus, RunStatus } from "@nightshift/contracts";
import { examinationBlocks } from "../rules/examination.js";
import type { JobReport, RunReport } from "./report.js";

export type WaitingKind = "prerequisite" | "provisional" | "blocked" | "finding" | "failed";

/** One thing that waits on the owner, and why. */
export interface WaitingItem {
  readonly kind: WaitingKind;
  /** What it is about: a prerequisite, a strand, a job. */
  readonly subject: string;
  readonly reason: string;
}

export interface ProgramStatus {
  readonly runStatus: RunStatus;
  readonly strands: { readonly total: number; readonly succeeded: number };
  readonly jobs: {
    readonly total: number;
    readonly landed: number;
    readonly failed: number;
    /** Jobs that took more than one attempt. */
    readonly retried: number;
    /** Jobs a second model examined. */
    readonly examined: number;
  };
  /** Everything that needs the owner, most actionable first. */
  readonly waiting: readonly WaitingItem[];
  readonly spend: {
    readonly usd: number;
    /** Some of `usd` is an estimate from the price table. */
    readonly estimated: boolean;
    /** Routes with no price at all: the spend is unknown, not zero. */
    readonly unpriced: number;
    readonly budgetUsd?: number;
  };
}

const FAILED: ReadonlySet<ExecutionNodeStatus> = new Set([
  "failed",
  "verification_failed",
  "examination_failed",
  "cancelled",
  "interrupted",
]);

const WAITING_ORDER: Readonly<Record<WaitingKind, number>> = {
  prerequisite: 0,
  finding: 1,
  failed: 2,
  blocked: 3,
  provisional: 4,
};

/**
 * The status of the run `report` describes. `unplannedJobs` are the jobs of a
 * run with no strands, which the report does not list; a planned run passes none.
 */
export const programStatus = (
  report: RunReport,
  unplannedJobs: readonly JobReport[] = [],
): ProgramStatus => {
  const jobs = [...report.strands.flatMap((strand) => strand.jobs), ...unplannedJobs];
  const waiting: WaitingItem[] = [];

  for (const prerequisite of report.pendingPrerequisites) {
    waiting.push({
      kind: "prerequisite",
      subject: prerequisite.id,
      reason: prerequisite.description,
    });
  }
  for (const strand of report.strands) {
    const subject = `${strand.id} ${strand.name}`;
    if (strand.outcome === "provisional") {
      waiting.push({
        kind: "provisional",
        subject,
        reason: `done on the provisional line, waiting on ${strand.waitingOn.join(", ") || "a prerequisite"}`,
      });
    } else if (strand.blockedBy.length > 0) {
      waiting.push({
        kind: "blocked",
        subject,
        reason: `blocked by ${strand.blockedBy.join(", ")}`,
      });
    } else if (strand.outcome === "failed" || strand.outcome === "cancelled") {
      waiting.push({
        kind: "failed",
        subject,
        reason: strand.reason ?? `strand ${strand.outcome}`,
      });
    }
  }
  for (const job of jobs) {
    const latest = job.examinations.at(-1);
    if (latest !== undefined && job.status !== "integrated" && examinationBlocks(latest)) {
      waiting.push({
        kind: "finding",
        subject: job.objective,
        reason: "a blocking finding stands",
      });
    }
  }
  if (report.strands.length === 0) {
    for (const job of jobs.filter((j) => FAILED.has(j.status as ExecutionNodeStatus))) {
      waiting.push({ kind: "failed", subject: job.objective, reason: job.reason ?? job.status });
    }
  }
  waiting.sort((a, b) => WAITING_ORDER[a.kind] - WAITING_ORDER[b.kind]);

  const usd = report.usage.reduce((sum, row) => sum + row.costUsd, 0);
  const budgetUsd = report.program.costPolicy.maxUsd;
  return {
    runStatus: report.run.status,
    strands: {
      total: report.strands.length,
      succeeded: report.strands.filter((s) => s.outcome === "succeeded").length,
    },
    jobs: {
      total: jobs.length,
      landed: jobs.filter((j) => j.status === "integrated").length,
      failed: jobs.filter((j) => FAILED.has(j.status as ExecutionNodeStatus)).length,
      retried: jobs.filter((j) => j.attempts > 1).length,
      examined: jobs.filter((j) => j.examinations.length > 0).length,
    },
    waiting,
    spend: {
      usd,
      estimated: report.usage.some((row) => row.estimated),
      unpriced: report.usage.reduce((sum, row) => sum + row.unpriced, 0),
      ...(budgetUsd === undefined ? {} : { budgetUsd }),
    },
  };
};
