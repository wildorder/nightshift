/**
 * Primitives shared by every v1 aggregate.
 *
 * Every persisted record carries `schemaVersion` (D-P1-04) and the ownership
 * chain `projectId` / `programId` / `runId` (A-07). Status fields are plain
 * string unions here; which transitions between them are legal is
 * `@nightshift/core`'s concern, not this package's.
 */
import { z } from "zod";
import { ProgramIdSchema, ProjectIdSchema, RunIdSchema } from "../ids.js";

/** The only schema version v1 writes. A reader seeing anything else must refuse it. */
export const SchemaVersionSchema = z.literal(1);
export type SchemaVersion = z.infer<typeof SchemaVersionSchema>;

export const IsoTimestampSchema = z.iso.datetime({ offset: true });
export type IsoTimestamp = z.infer<typeof IsoTimestampSchema>;

/** `low | medium | high`, used for both risk and ambiguity on a Job Contract. */
export const RiskLevelSchema = z.enum(["low", "medium", "high"]);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

export const AmbiguityLevelSchema = RiskLevelSchema;
export type AmbiguityLevel = RiskLevel;

/**
 * Reversibility classes are honest (architecture §6). Nothing may reclassify an
 * irreversible external effect as reversible.
 */
export const ReversibilitySchema = z.enum(["reversible", "compensatable", "irreversible"]);
export type Reversibility = z.infer<typeof ReversibilitySchema>;

/** Where a run executes. One authoritative control plane serves both (A-06). */
export const ExecutionLocationSchema = z.enum(["local", "remote"]);
export type ExecutionLocation = z.infer<typeof ExecutionLocationSchema>;

/**
 * A path glob within the repository. Absolute paths and `..` traversal are
 * rejected: scope containment in `core` compares repository-relative paths, and
 * either of those would make containment unsound.
 */
export const PathGlobSchema = z
  .string()
  .min(1)
  .refine((value) => !value.startsWith("/") && !/^[A-Za-z]:/.test(value), {
    message: "must be repository-relative, not absolute",
  })
  .refine((value) => !value.split("/").includes(".."), {
    message: 'must not traverse upward with ".."',
  });
export type PathGlob = z.infer<typeof PathGlobSchema>;

/** A capability an execution node may exercise, for example `shell.exec`. */
export const PermissionSchema = z.string().min(1);
export type Permission = z.infer<typeof PermissionSchema>;

/**
 * The effective authority of an execution node. Children may narrow any of
 * these four fields and may never widen them (A-11); `core` enforces that
 * structurally.
 */
export const ScopeSchema = z.strictObject({
  includes: z.array(PathGlobSchema).min(1),
  excludes: z.array(PathGlobSchema),
  permissions: z.array(PermissionSchema),
  forbiddenActions: z.array(z.string().min(1)),
});
export type Scope = z.infer<typeof ScopeSchema>;

/**
 * A scope as *requested* by a delegating orchestrator. An omitted field means
 * "inherit the parent's unchanged", which is deliberately different from an
 * empty array (which would mean "narrow to nothing").
 */
export const ScopeRequestSchema = z.strictObject({
  includes: z.array(PathGlobSchema).min(1),
  excludes: z.array(PathGlobSchema).optional(),
  permissions: z.array(PermissionSchema).optional(),
  forbiddenActions: z.array(z.string().min(1)).optional(),
});
export type ScopeRequest = z.infer<typeof ScopeRequestSchema>;

/** A git commit SHA-1, as written by the harnesses Nightshift drives. */
export const CommitShaSchema = z
  .string()
  .regex(/^[0-9a-f]{40}$/, { message: "must be a 40-character lowercase hex commit SHA" });
export type CommitSha = z.infer<typeof CommitShaSchema>;

export const GitRefSchema = z.string().min(1);
export type GitRef = z.infer<typeof GitRefSchema>;

/** Fields every aggregate below `Project` carries. */
export const projectScoped = {
  schemaVersion: SchemaVersionSchema,
  projectId: ProjectIdSchema,
} as const;

export const programScoped = {
  ...projectScoped,
  programId: ProgramIdSchema,
} as const;

export const runScoped = {
  ...programScoped,
  runId: RunIdSchema,
} as const;
