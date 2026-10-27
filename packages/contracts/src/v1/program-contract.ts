/**
 * Program Contract — the stable authority for a run (vision, Core Concepts).
 *
 * The orchestrator may continuously revise its *implementation plan*. It may
 * not silently revise this contract to make its implementation pass, which is
 * why nothing here is writable by a worker.
 */
import { z } from "zod";
import { DecisionIdSchema, ProgramIdSchema, RunIdSchema } from "../ids.js";
import { IsoTimestampSchema, PathGlobSchema, programScoped, RiskLevelSchema } from "./common.js";
import { ComputeChoiceSchema } from "./compute.js";
import { LineConfigSchema } from "./line-config.js";
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
import { SecretNameSchema } from "./secrets.js";

/** A program-level outcome the run is judged against. */
export const SuccessCriterionSchema = z.strictObject({
  id: z.string().min(1),
  outcome: z.string().min(1),
  /** P14 (D-P14-01): the user stories this criterion serves. */
  serves: z.array(StoryIdSchema).optional(),
});
export type SuccessCriterion = z.infer<typeof SuccessCriterionSchema>;

/** How long a step may run when it does not say: ten minutes. */
export const DEFAULT_STEP_TIMEOUT_SECONDS = 600;
/** How long a timed-out step has, after SIGTERM, to clean up before SIGKILL, when it does not say. */
export const DEFAULT_STEP_CLEANUP_SECONDS = 30;
/** The most a step may declare for `timeoutSeconds` (D-02): two hours. Past that, skip the step (D-04). */
export const MAX_STEP_TIMEOUT_SECONDS = 7200;
/** The most a step may declare for `cleanupSeconds` (D-02): one hour. */
export const MAX_STEP_CLEANUP_SECONDS = 3600;

/**
 * The time a step declares for itself (P19), shared by verification and setup
 * steps. Both are positive whole seconds, absent meaning the defaults above.
 * `timeoutSeconds` is how long the step may run; `cleanupSeconds` is how long,
 * after SIGTERM on timeout, its trap has to remove what it made before SIGKILL.
 * The run's orchestrators may raise either mid-run (D-01); that adjustment
 * lives in the run's records, never here.
 */
const stepTimeFields = {
  timeoutSeconds: z.int().positive().optional(),
  cleanupSeconds: z.int().positive().optional(),
};

const OVER_MAXIMUM_WORDS = {
  timeoutSeconds: "7200 seconds (two hours); past that, skip the step (D-04)",
  cleanupSeconds: "3600 seconds (one hour)",
} as const;

/** Enforces the maximums on the step object, so the issue names the step, the field and the maximum. */
const refineStepTime = (
  step: { id: string; timeoutSeconds?: number | undefined; cleanupSeconds?: number | undefined },
  ctx: z.RefinementCtx,
): void => {
  const limits = [
    ["timeoutSeconds", step.timeoutSeconds, MAX_STEP_TIMEOUT_SECONDS],
    ["cleanupSeconds", step.cleanupSeconds, MAX_STEP_CLEANUP_SECONDS],
  ] as const;
  for (const [field, value, max] of limits) {
    if (value !== undefined && value > max) {
      ctx.addIssue({
        code: "custom",
        path: [field],
        message: `step "${step.id}": ${field} ${value} is over the maximum of ${OVER_MAXIMUM_WORDS[field]}`,
      });
    }
  }
};

/** A step's time in milliseconds, defaults filled in. */
export interface StepTime {
  readonly timeoutMs: number;
  readonly cleanupMs: number;
}

/**
 * One deterministic verification command. Steps are identified so a
 * `Verification` result can attach an exit code and a log artifact to the exact
 * step that produced it.
 */
export const VerificationStepSchema = z
  .strictObject({
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
    /**
     * When the step runs (A-57). `landing`, the default: on every job's
     * verification, in the merge queue, on the program head it is about to join.
     * `end`: once, when the run's work has all landed, on the program head, and
     * again after each fix that lands; never per job. For a gate that proves the
     * whole and costs too much to pay on every landing: an end-to-end suite
     * against a built, migrated system. The gate audit before a run runs both.
     */
    at: z.enum(["landing", "end"]).optional(),
    /**
     * How long the step may run, in seconds; absent is 600. At most 7200. On
     * timeout the step is sent SIGTERM and given `cleanupSeconds` before SIGKILL.
     * The run's orchestrators may raise it mid-run (D-01, strand S-02).
     */
    timeoutSeconds: stepTimeFields.timeoutSeconds,
    /**
     * How long, after SIGTERM on timeout, the step's trap has to remove what it
     * made before SIGKILL, in seconds; absent is 30. At most 3600. The run's
     * orchestrators may raise it mid-run (D-01, strand S-02).
     */
    cleanupSeconds: stepTimeFields.cleanupSeconds,
  })
  .superRefine(refineStepTime);
export type VerificationStep = z.infer<typeof VerificationStepSchema>;

/** Where a step runs; absent reads as `landing`. */
export const stepRunsAt = (step: Pick<VerificationStep, "at">): "landing" | "end" =>
  step.at ?? "landing";

/**
 * One command that prepares a checkout before anything runs in it: installing
 * dependencies, generating code, anything the repository needs and does not
 * commit.
 *
 * Nightshift creates checkouts of its own — a job's worktree, the detached
 * checkout an examiner's evidence is gathered in, the one resume makes when a
 * worktree was tidied away — and none of them holds a repository's ignored
 * files. Setup is how a program says what makes one usable, so its
 * verification states only what is checked. Nightshift runs every setup step,
 * in order, in each checkout it creates before a worker starts in it, and again
 * before every verification, because the commit under verification may have
 * changed what setup produces (a new dependency, say).
 *
 * Setup runs often, so it is made cheap when there is nothing to do: an
 * install step is skipped, and recorded as skipped, when the checkout's
 * lockfiles hash as they did for the installed tree it holds or is seeded with
 * (D-P10-24). Every other step runs every time. Setup is
 * recorded in a verification as its own commands, under `setup:<id>`, and a
 * setup step that fails fails the verification without the checks running: a
 * test suite run without its dependencies proves nothing.
 */
export const SetupStepSchema = z
  .strictObject({
    id: z.string().min(1),
    command: z.string().min(1),
    description: z.string().optional(),
    /** How long the step may run, in seconds; absent is 600, at most 7200. See `stepTimeFields`. */
    timeoutSeconds: stepTimeFields.timeoutSeconds,
    /** Seconds between SIGTERM on timeout and SIGKILL; absent is 30, at most 3600. */
    cleanupSeconds: stepTimeFields.cleanupSeconds,
  })
  .superRefine(refineStepTime);
export type SetupStep = z.infer<typeof SetupStepSchema>;

/** The time a step gets, in milliseconds, with the defaults filled in; use it wherever a step runs. */
export const stepTime = (
  step: Pick<VerificationStep | SetupStep, "timeoutSeconds" | "cleanupSeconds">,
): StepTime => ({
  timeoutMs: (step.timeoutSeconds ?? DEFAULT_STEP_TIMEOUT_SECONDS) * 1000,
  cleanupMs: (step.cleanupSeconds ?? DEFAULT_STEP_CLEANUP_SECONDS) * 1000,
});

/** The prefix a setup step's id carries in a `Verification`, so it cannot collide with a check's. */
export const SETUP_STEP_ID_PREFIX = "setup:";

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
/**
 * What happens when no examiner independent enough can run **now**, because a
 * usage limit has the routes the policy asks for out (amending D-P8-10,
 * 2026-10-12): `wait` holds the job until the first of them resets, and is what
 * an absent setting means; `strongest` examines at once on the strongest route
 * that can run, whatever model or provider built the work, and says so.
 */
export const IndependenceFallbackSchema = z.enum(["wait", "strongest"]);
export type IndependenceFallback = z.infer<typeof IndependenceFallbackSchema>;

export const ExaminationRequirementSchema = z.strictObject({
  required: z.boolean(),
  mustDifferModel: z.boolean(),
  mustDifferProvider: z.boolean(),
  blockOnMaterialFindings: z.boolean(),
  whenIndependentUnavailable: IndependenceFallbackSchema.optional(),
});
export type ExaminationRequirement = z.infer<typeof ExaminationRequirementSchema>;

/** Risk level to examination requirement. Changing this changes behaviour with no code change. */
export const ExaminationPolicySchema = z.strictObject({
  low: ExaminationRequirementSchema,
  medium: ExaminationRequirementSchema,
  high: ExaminationRequirementSchema,
});
export type ExaminationPolicy = z.infer<typeof ExaminationPolicySchema>;

/**
 * `strongest` only where the org (`a`) says it and the narrower (`b`) does not
 * say `wait`. An org that says nothing waits, and nothing narrower can loosen
 * that, so the field stays absent.
 */
const stricterFallback = (
  a: IndependenceFallback | undefined,
  b: IndependenceFallback | undefined,
): IndependenceFallback | undefined => {
  if (a === undefined) return undefined;
  return a === "strongest" && b !== "wait" ? "strongest" : "wait";
};

const stricterRequirement = (
  a: ExaminationRequirement,
  b: ExaminationRequirement,
): ExaminationRequirement => {
  const fallback = stricterFallback(a.whenIndependentUnavailable, b.whenIndependentUnavailable);
  return {
    required: a.required || b.required,
    mustDifferModel: a.mustDifferModel || b.mustDifferModel,
    mustDifferProvider: a.mustDifferProvider || b.mustDifferProvider,
    blockOnMaterialFindings: a.blockOnMaterialFindings || b.blockOnMaterialFindings,
    ...(fallback === undefined ? {} : { whenIndependentUnavailable: fallback }),
  };
};

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

/**
 * What a program says about where its work lies and what no agent may do.
 *
 * Since the owner's ruling of 2026-10-09 nothing here confines, refuses or fails
 * a job for the paths it changes: a job's reach is the environment it runs in.
 *
 * - `includes` and `excludes` are planning information. `plan check` holds each
 *   strand's planned paths inside them and finds strands that may overlap.
 * - `forbiddenActions` are rules, not paths ("deploy any stack", "push to
 *   main"), and every agent's brief lists them.
 * - `permissions` is read so a contract written before the ruling parses, and
 *   is told to nobody.
 */
export const ProgramContractScopeSchema = z.strictObject({
  includes: z.array(PathGlobSchema).min(1),
  excludes: z.array(PathGlobSchema),
  permissions: z.array(z.string().min(1)).optional(),
  forbiddenActions: z.array(z.string().min(1)),
});
export type ProgramContractScope = z.infer<typeof ProgramContractScopeSchema>;

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
    /** Prose guidance, told to agents in their briefs. */
    constraints: z.array(z.string().min(1)),
    /** Planning information and the forbidden actions every agent is told. Confines no job. */
    scope: ProgramContractScopeSchema,
    /** What makes a checkout usable before anything runs in it. Absent means nothing does. */
    setup: z.array(SetupStepSchema).optional(),
    /** A-62: the project's secrets, by name, given to every step and agent. */
    secrets: z.array(SecretNameSchema).optional(),
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
    /**
     * P10 (D-P10-14): the machine a remote run of this program gets, when it
     * says; usually inherited from `nightshift.config.json`. Absent means the
     * recommendation, else `good`.
     */
    compute: ComputeChoiceSchema.optional(),
    /** The project line this program's landed work is composed onto; inherited from `nightshift.config.json`. Absent means off. */
    line: LineConfigSchema.optional(),
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
  .refine((value) => uniqueIds(value.setup ?? []), {
    message: "setup step ids must be unique within a program contract",
    path: ["setup"],
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
