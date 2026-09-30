/** The run graph (P13, D-P13-10): built in T4b. */
import type { ExecutionNode, JobContract } from "@nightshift/contracts";
import type { RunReport, RunScope } from "@nightshift/core";

export const RunGraph = (_props: {
  readonly scope: RunScope;
  readonly nodes: readonly ExecutionNode[];
  readonly jobs: readonly JobContract[];
  readonly report: RunReport | undefined;
}) => <p className="text-sm text-muted-foreground">The run graph is coming.</p>;
