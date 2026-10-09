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
 * rejected: the plan checks in `core` compare repository-relative paths, and
 * either of those would make their containment and overlap answers unsound.
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

/**
 * Until the owner's ruling of 2026-10-09 an execution node and a Job Contract
 * carried a path scope, and a job was refused, confined or failed for the paths
 * it changed. Jobs carry no path scope now: a job's reach is the environment it
 * runs in. A record stored before the ruling still has the key; it is dropped on
 * read, and nothing writes it again.
 */
export const dropRetiredScope = (raw: unknown): unknown => {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw) || !("scope" in raw)) {
    return raw;
  }
  const { scope: _retired, ...rest } = raw as { scope?: unknown };
  return rest;
};

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
