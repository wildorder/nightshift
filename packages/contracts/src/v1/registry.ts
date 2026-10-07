/**
 * The registry of every v1 aggregate schema.
 *
 * Tests iterate this rather than naming schemas one by one, so a new aggregate
 * cannot be added without inheriting the project-scoping and schema-version
 * checks (SC-P1-17). `AGGREGATE_NAMES` is the list from the source plan's
 * Stage 1 deliverables and is asserted against these keys, so neither list can
 * drift from the other unnoticed.
 */
import type { z } from "zod";
import { AgentSchema } from "./agent.js";
import { ArtifactSchema } from "./artifact.js";
import { CheckpointSchema } from "./checkpoint.js";
import { DecisionSchema } from "./decision.js";
import { ComputeUtilizationSchema, DispatchSchema } from "./dispatch.js";
import { EventSchema } from "./event.js";
import { ExaminationSchema } from "./examination.js";
import { ExecutionNodeSchema } from "./execution-node.js";
import { GateHealthSchema } from "./gate-health.js";
import { JobContractSchema } from "./job-contract.js";
import { ProgramContractSchema } from "./program-contract.js";
import { ProjectSchema } from "./project.js";
import { RoutingDecisionSchema } from "./routing-decision.js";
import { RunSchema } from "./run.js";
import { VerificationSchema } from "./verification.js";
import { WarmCacheSchema } from "./warm-cache.js";

/**
 * Exactly the aggregates listed in the source plan, Stage 1, plus the three
 * P10 added for remote execution (D-P10-18, D-P10-14, D-P10-15): a run's
 * `Dispatch` and `ComputeUtilization`, and a project's `WarmCache`; and P15's
 * project `GateHealth` (D-P15-07).
 */
export const AGGREGATE_NAMES = [
  "Project",
  "ProgramContract",
  "Run",
  "ExecutionNode",
  "JobContract",
  "Agent",
  "Decision",
  "Checkpoint",
  "Verification",
  "Examination",
  "RoutingDecision",
  "Artifact",
  "Event",
  "Dispatch",
  "ComputeUtilization",
  "WarmCache",
  "GateHealth",
] as const;

export type AggregateName = (typeof AGGREGATE_NAMES)[number];

export const AGGREGATE_SCHEMAS: {
  readonly [K in AggregateName]: z.ZodType;
} = {
  Project: ProjectSchema,
  ProgramContract: ProgramContractSchema,
  Run: RunSchema,
  ExecutionNode: ExecutionNodeSchema,
  JobContract: JobContractSchema,
  Agent: AgentSchema,
  Decision: DecisionSchema,
  Checkpoint: CheckpointSchema,
  Verification: VerificationSchema,
  Examination: ExaminationSchema,
  RoutingDecision: RoutingDecisionSchema,
  Artifact: ArtifactSchema,
  Event: EventSchema,
  Dispatch: DispatchSchema,
  ComputeUtilization: ComputeUtilizationSchema,
  WarmCache: WarmCacheSchema,
  GateHealth: GateHealthSchema,
};

/**
 * Aggregates that carry the full run-scoped chain. `Project`,
 * `ProgramContract` and a project's `WarmCache` and `GateHealth` sit above a run
 * and so are excluded.
 */
export const RUN_SCOPED_AGGREGATES: readonly AggregateName[] = AGGREGATE_NAMES.filter(
  (name) =>
    name !== "Project" &&
    name !== "ProgramContract" &&
    name !== "WarmCache" &&
    name !== "GateHealth",
);
