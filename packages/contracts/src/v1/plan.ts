/**
 * The planned part of a Program Contract (P7; D-P7-03 … D-P7-06).
 *
 * Planning ends where a wrong choice becomes cheap (D-P7-01), so these are the
 * records of what a human fixes before a run: the **seams** (strands), the
 * **human prerequisites** and the **decisions** that can be seen coming.
 *
 * **There is nowhere to put a job.** How a strand is cut into jobs, in what
 * order and on which model is the run's, decided by an orchestrator with the
 * code in front of it. A field for it here would be the layer D-P7-01 says the
 * plan does not own.
 *
 * A contract is drafted over many rounds, so these schemas accept an incomplete
 * plan: an empty `verifyCommand`, a decision with no answer, a `dependsOn` that
 * names nothing. Whether a plan is *executable* is `checkPlan`'s to say in
 * `@nightshift/core`, with every reason at once, not a parse error's.
 */
import { z } from "zod";
import { RunIdSchema } from "../ids.js";
import { IsoTimestampSchema, PathGlobSchema } from "./common.js";

/** A program is `planning` until a human ratifies it, and nothing executes before that (D-P7-02). */
export const PlanStatusSchema = z.enum(["planning", "ratified"]);
export type PlanStatus = z.infer<typeof PlanStatusSchema>;

export const StrandIdSchema = z.string().regex(/^S-\d{2,}$/, { message: 'must look like "S-01"' });
export type StrandId = z.infer<typeof StrandIdSchema>;

export const PrerequisiteIdSchema = z
  .string()
  .regex(/^HP-\d{2,}$/, { message: 'must look like "HP-01"' });
export type PrerequisiteId = z.infer<typeof PrerequisiteIdSchema>;

/**
 * Where a strand works. `excludes` is how a strand tells its neighbours "not
 * here" (D-P7-04). Permissions and forbidden actions are the program's and are
 * inherited unchanged; a strand narrows paths only.
 */
export const StrandScopeSchema = z.strictObject({
  summary: z.string().min(1),
  includes: z.array(PathGlobSchema).min(1),
  excludes: z.array(PathGlobSchema),
});
export type StrandScope = z.infer<typeof StrandScopeSchema>;

/**
 * A seam: a sub-program chosen by a human (D-P7-04). Its section of the plan
 * document, found by `id`, is its spec and is handed to its orchestrator
 * verbatim. Fixed by ratification; the jobs inside it are free.
 */
export const StrandSchema = z.strictObject({
  id: StrandIdSchema,
  name: z.string().min(1),
  scope: StrandScopeSchema,
  /** What must be true for this strand to be done, independently green. */
  acceptance: z.array(z.string().min(1)).min(1),
  /** The ids of the program success criteria this strand claims. */
  successCriteria: z.array(z.string().min(1)),
  /** Only where it is causal. The engine holds a strand until these have succeeded. */
  dependsOn: z.array(StrandIdSchema),
  prerequisites: z.array(PrerequisiteIdSchema),
});
export type Strand = z.infer<typeof StrandSchema>;

export const PrerequisiteStatusSchema = z.enum(["pending", "satisfied"]);
export type PrerequisiteStatus = z.infer<typeof PrerequisiteStatusSchema>;

/** The last deterministic run of a prerequisite's `verifyCommand`. */
export const PrerequisiteCheckSchema = z.strictObject({
  exitCode: z.int(),
  checkedAt: IsoTimestampSchema,
});
export type PrerequisiteCheck = z.infer<typeof PrerequisiteCheckSchema>;

/**
 * Something only a human can do, found at planning time and done before the run
 * (D-P7-05). Something the crew *cannot* do, never something merely tedious.
 *
 * `status` is only ever moved to `satisfied` by the deterministic preflight,
 * with the command's exit code in `lastCheck`: never by a planner and never by
 * a model.
 */
export const PrerequisiteSchema = z
  .strictObject({
    id: PrerequisiteIdSchema,
    description: z.string().min(1),
    /** The exact commands or console steps. Empty while drafting; `checkPlan` refuses it. */
    remediation: z.string(),
    /**
     * Exits zero iff the prerequisite is done, headless, with credentials the
     * runner holds. Run verbatim, in the same trust class as the program's
     * verification commands.
     */
    verifyCommand: z.string(),
    status: PrerequisiteStatusSchema,
    lastCheck: PrerequisiteCheckSchema.optional(),
    /**
     * Set when the engine recorded this hurdle mid-run (D-P7-10) rather than a
     * human planning it. Such a prerequisite is no part of what was ratified, so
     * it is left out of the plan hash.
     */
    discoveredInRunId: RunIdSchema.optional(),
  })
  .refine((value) => value.status !== "satisfied" || value.lastCheck?.exitCode === 0, {
    message: "a satisfied prerequisite carries the check that satisfied it, with exit code 0",
    path: ["status"],
  });
export type Prerequisite = z.infer<typeof PrerequisiteSchema>;

/**
 * A choice that could be seen coming, answered before the run (D-P7-06). At the
 * start of a run each answer is recorded as a `Decision` with authority `human`
 * on the program node.
 */
export const PlannedDecisionSchema = z.strictObject({
  id: z.string().min(1),
  question: z.string().min(1),
  options: z.array(z.string().min(1)),
  leaning: z.string().min(1).optional(),
  /** Absent until the human answers. `checkPlan` refuses a plan with one unanswered. */
  answer: z.string().min(1).optional(),
  rationale: z.string().min(1).optional(),
  /** The strands whose agents are handed this decision. */
  touches: z.union([z.literal("all"), z.array(StrandIdSchema)]),
});
export type PlannedDecision = z.infer<typeof PlannedDecisionSchema>;

const Sha256HexSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, { message: "must be a lowercase hex SHA-256" });

/**
 * The plan document as the control plane holds it (D-P7-02): stored at
 * ratification through a program-scoped upload, so a run is reconstructable
 * without the repository (A-06).
 */
export const PlanDocumentRefSchema = z.strictObject({
  uri: z.string().min(1),
  sha256: Sha256HexSchema,
  sizeBytes: z.int().min(0),
});
export type PlanDocumentRef = z.infer<typeof PlanDocumentRefSchema>;

/** One ratification: exactly what was approved, and when. */
export const RatificationSchema = z.strictObject({
  planHash: Sha256HexSchema,
  planDocument: PlanDocumentRefSchema,
  ratifiedAt: IsoTimestampSchema,
});
export type Ratification = z.infer<typeof RatificationSchema>;

/** How many past ratifications a contract keeps. The newest is last. */
export const MAX_RATIFICATION_HISTORY = 10;

/** A plan document is prose. Anything near this is not one. */
export const MAX_PLAN_DOCUMENT_BYTES = 1024 * 1024;

export const PlanHashSchema = Sha256HexSchema;
