/**
 * PlanDraft — a plan's home on the control plane (P21 S-01).
 *
 * A draft is a series of immutable, content-hashed versions (`PlanDraftVersion`)
 * and one small mutable record (`PlanDraft`) that says where the series stands:
 * which version is latest and what the owner has done about it. Documents are
 * referenced by sha256 only, through the same `PlanDocumentRef` the plan-documents
 * upload produces; nothing large lives in either record.
 *
 * Project scoped, keyed by program. A version is never changed once written: an
 * edit or an answer is a new version.
 */
import { z } from "zod";
import { ProgramIdSchema } from "../ids.js";
import { IsoTimestampSchema, projectScoped } from "./common.js";
import { PlanDocumentRefSchema, Sha256HexSchema } from "./plan.js";
import { PrincipalSchema } from "./principal.js";

/** What a version's author did to make it. */
export const PlanDraftActSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("write") }),
  z.strictObject({
    kind: z.literal("answer"),
    /** The contract decision answered. */
    decisionId: z.string().min(1),
    answer: z.string().min(1),
    rationale: z.string().min(1).optional(),
  }),
]);
export type PlanDraftAct = z.infer<typeof PlanDraftActSchema>;

export const PlanDraftVersionSchema = z.strictObject({
  ...projectScoped,
  programId: ProgramIdSchema,
  version: z.int().min(1),
  contract: PlanDocumentRefSchema,
  plan: PlanDocumentRefSchema,
  /** The kept planning conversation; evidence, not plan. */
  conversation: PlanDocumentRefSchema.optional(),
  /** The plan hash, computed as ever; present when the contract parses. */
  planHash: Sha256HexSchema.optional(),
  /** Recorded from the caller, never claimed. */
  author: PrincipalSchema,
  act: PlanDraftActSchema,
  createdAt: IsoTimestampSchema,
});
export type PlanDraftVersion = z.infer<typeof PlanDraftVersionSchema>;

/** `draft` is being worked on; `awaiting_owner` waits for a person; the others are final or terminal. */
export const PlanDraftStateSchema = z.enum(["draft", "awaiting_owner", "ratified", "declined"]);
export type PlanDraftState = z.infer<typeof PlanDraftStateSchema>;

/** A draft keeps the newest this-many recorded acts; older ones are dropped. */
export const MAX_PLAN_DRAFT_ACTS = 50;

export const PlanDraftRecordedActSchema = z.strictObject({
  kind: z.enum(["awaiting_owner", "changes_requested", "declined", "ratified"]),
  /** The version the act named. */
  version: z.int().min(1),
  by: PrincipalSchema,
  note: z.string().min(1).optional(),
  /** The hash ratified; present on `ratified`. */
  planHash: Sha256HexSchema.optional(),
  at: IsoTimestampSchema,
});
export type PlanDraftRecordedAct = z.infer<typeof PlanDraftRecordedActSchema>;

/** A program's directory name (`p1-billing`): how a person names a draft before it has a hash. */
export const PlanDraftNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
  .refine((value) => !value.endsWith(".json"), "a name is not a file name");
export type PlanDraftName = z.infer<typeof PlanDraftNameSchema>;

export const PlanDraftSchema = z.strictObject({
  ...projectScoped,
  programId: ProgramIdSchema,
  /** The program's directory name; unique among the project's drafts. */
  name: PlanDraftNameSchema.optional(),
  state: PlanDraftStateSchema,
  latestVersion: z.int().min(1),
  /** The newest {@link MAX_PLAN_DRAFT_ACTS} acts, oldest first. */
  acts: z.array(PlanDraftRecordedActSchema).max(MAX_PLAN_DRAFT_ACTS),
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
});
export type PlanDraft = z.infer<typeof PlanDraftSchema>;
