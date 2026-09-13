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
import { EventSchema } from "./event.js";
import { ExaminationSchema } from "./examination.js";
import { ExecutionNodeSchema } from "./execution-node.js";
import { JobContractSchema } from "./job-contract.js";
import { ProgramContractSchema } from "./program-contract.js";
import { ProjectSchema } from "./project.js";
import { RoutingDecisionSchema } from "./routing-decision.js";
import { RunSchema } from "./run.js";
import { VerificationSchema } from "./verification.js";

/** Exactly the aggregates listed in the source plan, Stage 1. */
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
};

/**
 * Aggregates that carry the full run-scoped chain. `Project` and
 * `ProgramContract` sit above a run and so are excluded.
 */
export const RUN_SCOPED_AGGREGATES: readonly AggregateName[] = AGGREGATE_NAMES.filter(
  (name) => name !== "Project" && name !== "ProgramContract",
);
