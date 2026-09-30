/**
 * Program Contract — the stable authority for a run (vision, Core Concepts).
 *
 * The orchestrator may continuously revise its *implementation plan*. It may
 * not silently revise this contract to make its implementation pass, which is
 * why nothing here is writable by a worker.
 */
import { z } from "zod";
import { DecisionIdSchema, ProgramIdSchema, RunIdSchema } from "../ids.js";
import { IsoTimestampSchema, programScoped, RiskLevelSchema, ScopeSchema } from "./common.js";
import {
  MAX_RATIFICATION_HISTORY,
  PlanDocumentRefSchema,
  PlanHashSchema,
  PlannedDecisionSchema,
  PlanStatusSchema,
  PrerequisiteIdSchema,
  PrerequisiteSchema,
  RatificationSchema,
  StoryIdSchema,
  StorySchema,
  StrandSchema,
} from "./plan.js";
import { RoutingNarrowingSchema } from "./routing-policy.js";

/** A program-level outcome the run is judged against. */
export const SuccessCriterionSchema = z.strictObject({
  id: z.string().min(1),
  outcome: z.string().min(1),
  /** P14 (D-P14-01): the user stories this criterion serves. */
  serves: z.array(StoryIdSchema).optional(),
});
export type SuccessCriterion = z.infer<typeof SuccessCriterionSchema>;

/**
 * One deterministic verification command. Steps are identified so a
 * `Verification` result can attach an exit code and a log artifact to the exact
 * step that produced it.
 */
export const VerificationStepSchema = z.strictObject({
  id: z.string().min(1),
  command: z.string().min(1),
  description: z.string().optional(),
  /**
   * The human prerequisites this step cannot run without (P7, D-P7-10): a
   * deploy check that needs a credential, say. While one of them is unmet the
   * step is **deferred**, not failed, every other step still runs, and the work
   * carries on a provisional line that never reaches the program branch until
   * the step has run and passed.
   */
  requires: z.array(PrerequisiteIdSchema).optional(),
});
export type VerificationStep = z.infer<typeof VerificationStepSchema>;

/**
 * Which providers and models this program may use. An empty `allowedModels`
 * means "any model offered by an allowed provider"; `forbiddenModels` always
 * wins over both.
 */
export const ModelPolicySchema = z.strictObject({
  allowedProviders: z.array(z.string().min(1)).min(1),
  allowedModels: z.array(z.string().min(1)),
  forbiddenModels: z.array(z.string().min(1)),
});
export type ModelPolicy = z.infer<typeof ModelPolicySchema>;

/**
 * What independent scrutiny a given risk level demands (A-12, Stage 7).
 * Examination is risk-based, never blanket ceremony, so `required: false` is a
 * legitimate setting for low risk.
 */
export const ExaminationRequirementSchema = z.strictObject({
  required: z.boolean(),
  mustDifferModel: z.boolean(),
  mustDifferProvider: z.boolean(),
  blockOnMaterialFindings: z.boolean(),
});
export type ExaminationRequirement = z.infer<typeof ExaminationRequirementSchema>;

/** Risk level to examination requirement. Changing this changes behaviour with no code change. */
export const ExaminationPolicySchema = z.strictObject({
  low: ExaminationRequirementSchema,
  medium: ExaminationRequirementSchema,
  high: ExaminationRequirementSchema,
});
export type ExaminationPolicy = z.infer<typeof ExaminationPolicySchema>;

const stricterRequirement = (
  a: ExaminationRequirement,
  b: ExaminationRequirement,
): ExaminationRequirement => ({
  required: a.required || b.required,
  mustDifferModel: a.mustDifferModel || b.mustDifferModel,
  mustDifferProvider: a.mustDifferProvider || b.mustDifferProvider,
  blockOnMaterialFindings: a.blockOnMaterialFindings || b.blockOnMaterialFindings,
});

/**
 * The stricter of two policies, level by level and field by field (P8,
 * D-P8-03). A repository or a contract can add scrutiny to what its org
 * requires and can never take any away: a looser setting simply has no effect.
 */
export const stricterExaminationPolicy = (
  a: ExaminationPolicy,
  b: ExaminationPolicy | undefined,
): ExaminationPolicy =>
  b === undefined
    ? a
    : {
        low: stricterRequirement(a.low, b.low),
        medium: stricterRequirement(a.medium, b.medium),
        high: stricterRequirement(a.high, b.high),
      };

export const DelegationLimitsSchema = z.strictObject({
  maxDepth: z.int().min(1),
  maxConcurrency: z.int().min(1),
});
export type DelegationLimits = z.infer<typeof DelegationLimitsSchema>;

/** Every bound is optional; an absent bound means "not capped by this program". */
export const CostPolicySchema = z.strictObject({
  maxUsd: z.number().positive().optional(),
  maxTokens: z.int().positive().optional(),
  maxWallClockSeconds: z.int().positive().optional(),
});
export type CostPolicy = z.infer<typeof CostPolicySchema>;

export const RepositorySchema = z.strictObject({
  url: z.string().min(1),
  baseBranch: z.string().min(1),
  programBranch: z.string().min(1),
});
export type Repository = z.infer<typeof RepositorySchema>;

const uniqueIds = (items: readonly { readonly id: string }[]): boolean =>
  new Set(items.map((item) => item.id)).size === items.length;

/**
 * What a correction corrects (P9, D-P9-04): a decision in a run of a program of
 * the same project, and the human decision that reversed it.
 */
export const CorrectionTargetSchema = z.strictObject({
  programId: ProgramIdSchema,
  runId: RunIdSchema,
  decisionId: DecisionIdSchema,
  reversedBy: DecisionIdSchema,
});
export type CorrectionTarget = z.infer<typeof CorrectionTargetSchema>;

export const ProgramContractSchema = z
  .strictObject({
    ...programScoped,
    objective: z.string().min(1),
    repository: RepositorySchema,
    successCriteria: z.array(SuccessCriterionSchema).min(1),
    /** Prose guidance for the orchestrator. Unlike `scope`, not machine-enforced. */
    constraints: z.array(z.string().min(1)),
    /** The root authority every execution node inherits from and may only narrow. */
    scope: ScopeSchema,
    verification: z.array(VerificationStepSchema).min(1),
    modelPolicy: ModelPolicySchema,
    examinationPolicy: ExaminationPolicySchema,
    delegationLimits: DelegationLimitsSchema,
    costPolicy: CostPolicySchema,
    /** Default risk when a Job Contract does not state one. */
    defaultRisk: RiskLevelSchema,
    /**
     * P8 (D-P8-03): how this program narrows its org's routing policy. Only
     * ever less; `effectivePolicy` in `core` refuses a widening by name.
     */
    routing: RoutingNarrowingSchema.optional(),
    createdAt: IsoTimestampSchema,
    /**
     * The planned part (P7, `./plan.ts`). Every field is optional and absent
     * means empty, so a contract written before P7 parses to exactly what it
     * was, and one with no strands runs exactly as it always did.
     */
    status: PlanStatusSchema.optional(),
    /** P14 (D-P14-01): why the program exists, for the people it is for. */
    stories: z.array(StorySchema).optional(),
    /**
     * P14 (D-P14-06): whether the planning conversation is kept beside the plan.
     * Absent means kept; usually inherited from `nightshift.config.json`.
     */
    keepConversation: z.boolean().optional(),
    strands: z.array(StrandSchema).optional(),
    prerequisites: z.array(PrerequisiteSchema).optional(),
    decisions: z.array(PlannedDecisionSchema).optional(),
    /**
     * P9 (D-P9-04): a correction names the decisions it corrects, each with the
     * human decision that reversed it. Absent for every other program.
     */
    corrects: z.array(CorrectionTargetSchema).optional(),
    /** What this program deliberately does not deliver. Prose, for the human and the orchestrator. */
    outOfScope: z.array(z.string().min(1)).optional(),
    /** `planHash` in `core` over this contract and the plan document, as ratified (D-P7-02). */
    planHash: PlanHashSchema.optional(),
    planDocument: PlanDocumentRefSchema.optional(),
    /** P14: the conversation kept at the current ratification. Written by the control plane. */
    conversation: PlanDocumentRefSchema.optional(),
    /** Every ratification so far, oldest first, the current one last. Written by the control plane. */
    ratifications: z.array(RatificationSchema).max(MAX_RATIFICATION_HISTORY).optional(),
  })
  /**
   * Step identifiers are what a `Verification` attaches an exit code and a log
   * artifact to, so two steps sharing one would put two results under the same
   * label and silently lose a log. Checked here because it is a property of the
   * authored contract, not of any one runner.
   */
  .refine((value) => uniqueIds(value.verification), {
    message: "verification step ids must be unique within a program contract",
    path: ["verification"],
  })
  .refine((value) => uniqueIds(value.successCriteria), {
    message: "success criterion ids must be unique within a program contract",
    path: ["successCriteria"],
  })
  /**
   * Ids are how the plan document, the engine and the report refer to these, so
   * a duplicate is a broken reference rather than an unready plan.
   */
  .refine((value) => uniqueIds(value.stories ?? []), {
    message: "story ids must be unique within a program contract",
    path: ["stories"],
  })
  .refine((value) => uniqueIds(value.strands ?? []), {
    message: "strand ids must be unique within a program contract",
    path: ["strands"],
  })
  .refine((value) => uniqueIds(value.prerequisites ?? []), {
    message: "prerequisite ids must be unique within a program contract",
    path: ["prerequisites"],
  })
  .refine((value) => uniqueIds(value.decisions ?? []), {
    message: "planned decision ids must be unique within a program contract",
    path: ["decisions"],
  })
  /** A gate that can be recorded without what was approved is not a gate (D-P7-02). */
  .refine(
    (value) =>
      value.status !== "ratified" ||
      (value.planHash !== undefined && value.planDocument !== undefined),
    {
      message: "a ratified contract carries its plan hash and its plan document",
      path: ["status"],
    },
  );
export type ProgramContract = z.infer<typeof ProgramContractSchema>;
