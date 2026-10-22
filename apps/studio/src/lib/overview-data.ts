/**
 * The attempt rows the Overview reads (P20): every routing decision with the
 * measurement summary behind it. Read through the stores, not downloaded: the
 * request-evidence artifacts a summary names are only linked. Keyed under
 * `["run-status", runId]`, so the live poll's invalidations refresh it.
 */
import type { MeasurementSummary } from "@nightshift/contracts";
import { type AttemptRow, attemptRowsOf, type RunScope } from "@nightshift/core";
import { useQuery } from "@tanstack/react-query";
import { useStudio } from "../studio.js";
import { readAll } from "./read-all.js";

export const useAttemptRows = (scope: RunScope) => {
  const { stores } = useStudio();
  return useQuery({
    queryKey: ["run-status", scope.runId, "attempts"],
    queryFn: async (): Promise<{
      rows: AttemptRow[];
      measurements: readonly MeasurementSummary[];
    }> => {
      const nodes = await readAll((page) => stores.executionNodes.listByRun(scope, page));
      const measurements = await readAll((page) => stores.measurements.listByRun(scope, page));
      const agents = (
        await Promise.all(nodes.map((n) => stores.agents.listByNode(scope, n.executionNodeId)))
      ).flat();
      const routes = (
        await Promise.all(
          nodes.map((n) => stores.routingDecisions.listByNode(scope, n.executionNodeId)),
        )
      ).flat();
      const strandOf = new Map<string, string>();
      for (const node of nodes) {
        let parent = node.parentNodeId;
        while (parent !== null) {
          const up = nodes.find((n) => n.executionNodeId === parent);
          if (up === undefined) break;
          if (up.kind === "sub-program") {
            strandOf.set(node.executionNodeId, up.executionNodeId);
            break;
          }
          parent = up.parentNodeId;
        }
      }
      const roleOf = new Map(
        measurements.map((summary) => [summary.measurementSummaryId as string, summary.role]),
      );
      return {
        // A route need not name its role; the agent's own summary does.
        rows: attemptRowsOf({
          routes,
          measurements,
          agents,
          nodes,
          strandOfNode: (nodeId) => strandOf.get(nodeId) ?? null,
        }).map((row) => ({
          ...row,
          role: row.role ?? roleOf.get(row.measurementSummaryId ?? "") ?? null,
        })),
        measurements,
      };
    },
  });
};
