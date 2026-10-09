/**
 * Job Contract — a bounded unit of delegated work.
 *
 * Deliberately lean. What *Nightshift* decides (harness, model, workspace,
 * worktree, priority, examination requirement, fallback policy) is not on this
 * record: it lives on `ExecutionNode` and `RoutingDecision`. An orchestrator
 * that wants to pin a model states an override on the delegation request, and
 * routing records that it honoured one.
 */
import { z } from "zod";
import { DecisionIdSchema, JobContractIdSchema } from "../ids.js";
import {
  AmbiguityLevelSchema,
  dropRetiredScope,
  IsoTimestampSchema,
  RiskLevelSchema,
  runScoped,
} from "./common.js";
import { StrandIdSchema } from "./plan.js";
import { JobKindSchema, TestabilitySchema } from "./routing-policy.js";

/** `red_base`: the gate was red when the run started. `flaky`: a check failed and then passed on a rerun on the same commit. */
export const RepairCauseSchema = z.enum(["red_base", "flaky"]);
export type RepairCause = z.infer<typeof RepairCauseSchema>;

/**
 * P15 (D-P15-03, D-P15-04): what a repair job repairs. `gates` names the
 * setup or verification step ids that were red or flaked; `decisionId` is the
 * decision recorded with the repair, which D-P15-04 requires of every one.
 */
export const RepairSchema = z.strictObject({
  cause: RepairCauseSchema,
  gates: z.array(z.string().min(1)).min(1),
  decisionId: DecisionIdSchema,
});
export type Repair = z.infer<typeof RepairSchema>;

const JobContractRecordSchema = z
  .strictObject({
    ...runScoped,
    jobContractId: JobContractIdSchema,
    objective: z.string().min(1),
    acceptance: z.array(z.string().min(1)).min(1),
    /** Other Job Contracts that must reach `integrated` before this one starts. */
    dependencies: z.array(JobContractIdSchema),
    risk: RiskLevelSchema,
    ambiguity: AmbiguityLevelSchema,
    /**
     * P8 (D-P8-01): what the job says about itself, so routing can place it. Both
     * optional, so every stored contract parses as it did. Never read directly:
     * `classificationOf` in `core` fills the **conservative** default for
     * anything unset (`weak`, and no kind), so an unclassified job is never sent
     * to the cheapest rung by accident.
     */
    testability: TestabilitySchema.optional(),
    kind: JobKindSchema.optional(),
    /**
     * Set when this contract **is a strand** of a ratified plan (P7, D-P7-04): a
     * sub-program directly under the program node, whose objective carries its
     * section of the plan verbatim. The engine gates it on the strands it depends
     * on and parks its cone when it fails. Never set on a job inside a strand:
     * those are the run's, and the plan does not name them.
     */
    strandId: StrandIdSchema.optional(),
    /**
     * Set when this contract **is a repair job** (P15, D-P15-03, D-P15-04): a job
     * a planned run's root may add outside its strands, to fix a gate that was
     * red at the start or a check that flaked. It is examined at high risk
     * against the gate standard. Never set together with `strandId`: a repair sits
     * outside every strand by definition.
     */
    repair: RepairSchema.optional(),
    createdAt: IsoTimestampSchema,
  })
  .refine((value) => value.repair === undefined || value.strandId === undefined, {
    message: "a repair job sits outside every strand, so repair and strandId are never both set",
    path: ["repair"],
  });

/**
 * A Job Contract carries no path scope (the owner's ruling, 2026-10-09): one
 * stored before the ruling has a `scope`, which is dropped on read.
 */
export const JobContractSchema = z.preprocess(dropRetiredScope, JobContractRecordSchema);
export type JobContract = z.infer<typeof JobContractRecordSchema>;
