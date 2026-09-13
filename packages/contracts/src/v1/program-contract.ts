/**
 * Program Contract — the stable authority for a run (vision, Core Concepts).
 *
 * The orchestrator may continuously revise its *implementation plan*. It may
 * not silently revise this contract to make its implementation pass, which is
 * why nothing here is writable by a worker.
 */
import { z } from "zod";
import { IsoTimestampSchema, programScoped, RiskLevelSchema, ScopeSchema } from "./common.js";

/** A program-level outcome the run is judged against. */
export const SuccessCriterionSchema = z.strictObject({
  id: z.string().min(1),
  outcome: z.string().min(1),
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

export const ProgramContractSchema = z.strictObject({
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
  createdAt: IsoTimestampSchema,
});
export type ProgramContract = z.infer<typeof ProgramContractSchema>;
