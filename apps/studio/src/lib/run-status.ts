/**
 * A run's report and its program status (D-P13-09), loaded once per run and
 * shared by the program card and the run's Status tab through the query cache.
 */
import type { ExecutionNode, JobContract } from "@nightshift/contracts";
import {
  gatherReport,
  type JobReport,
  type ProgramStatus,
  type ProjectStores,
  programStatus,
  type RunReport,
  type RunScope,
} from "@nightshift/core";
import { useQuery } from "@tanstack/react-query";
import { useStudio } from "../studio.js";
import { readAll } from "./read-all.js";

const firstLine = (text: string): string =>
  (text.split("\n").find((line) => line.trim() !== "") ?? "").replace(/^#+\s*/, "").slice(0, 120);

/** The jobs of a run with no strands, which the report does not list. */
export const unplannedJobsOf = (
  nodes: readonly ExecutionNode[],
  jobs: readonly JobContract[],
): JobReport[] => {
  const objective = new Map(
    jobs.map((job) => [job.jobContractId as string, firstLine(job.objective)]),
  );
  return nodes
    .filter((node) => node.kind === "job")
    .map((node) => ({
      nodeId: node.executionNodeId,
      objective: node.jobContractId === null ? "" : (objective.get(node.jobContractId) ?? ""),
      status: node.status,
      commitSha: node.commitSha,
      attempts: 1,
      reason: node.outcomeReason,
      routes: [],
      examinations: [],
    }));
};

export interface RunStatus {
  readonly report: RunReport;
  readonly status: ProgramStatus;
  readonly unplannedJobs: readonly JobReport[];
}

export const loadRunStatus = async (stores: ProjectStores, scope: RunScope): Promise<RunStatus> => {
  const report = await gatherReport(stores, scope);
  const unplannedJobs =
    report.strands.length > 0
      ? []
      : unplannedJobsOf(
          await readAll((page) => stores.executionNodes.listByRun(scope, page)),
          await readAll((page) => stores.jobContracts.listByRun(scope, page)),
        );
  return { report, status: programStatus(report, unplannedJobs), unplannedJobs };
};

export const useRunStatus = (scope: RunScope | undefined) => {
  const { stores } = useStudio();
  return useQuery({
    queryKey: ["run-status", scope?.runId],
    queryFn: () => (scope === undefined ? undefined : loadRunStatus(stores, scope)),
    enabled: scope !== undefined,
  });
};
