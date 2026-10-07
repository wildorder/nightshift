/**
 * GateHealth — a project's gate-health record (P15, D-P15-07).
 *
 * What planning's audit found when it judged the repository's gates against
 * Nightshift's gate standard (D-P15-05): the commit it audited, the gate
 * fingerprint at that commit (D-P15-02), the verdict, each finding with the
 * contract decision that answers it, and the files it named as gate machinery.
 *
 * Project scoped, one per project: the gates are the repository's, not a
 * program's. It lives on the control plane so that a hand edit in the
 * repository cannot fake it; `nightshift gates {id} --record` and the engine
 * write it, `plan check` reads it (D-P15-08).
 */
import { z } from "zod";
import { ProgramIdSchema } from "../ids.js";
import { CommitShaSchema, IsoTimestampSchema, projectScoped } from "./common.js";
import { Sha256HexSchema } from "./plan.js";
import { PrincipalSchema } from "./principal.js";

/** `healthy` passes the standard; `repairing` has findings a gate-health strand is fixing. */
export const GateHealthVerdictSchema = z.enum(["healthy", "repairing"]);
export type GateHealthVerdict = z.infer<typeof GateHealthVerdictSchema>;

/** The rules of the gate standard (§4.1), numbered 1 to 7. */
export const GATE_STANDARD_RULES = 7;

/**
 * A file path inside the repository, in one canonical, portable spelling:
 * `/`-separated, relative, with no `.`, `..` or empty segment.
 *
 * Stricter than `PathGlobSchema` on purpose. A backslash is refused outright,
 * so `..\x`, `\Windows\x` and `\\server\share\x` cannot resolve outside the
 * checkout on Windows; a drive letter or a `:` anywhere is refused for the same
 * reason (`C:x` is drive-relative, `a:b` names an alternate data stream).
 */
export const RepositoryPathSchema = z
  .string()
  .min(1)
  .refine((value) => !value.includes("\\"), {
    message: "must use '/' separators; a backslash is not allowed",
  })
  .refine((value) => !value.includes(":"), {
    message: "must not contain ':' (a drive letter or a stream name)",
  })
  .refine((value) => !value.startsWith("/"), {
    message: "must be repository-relative, not absolute",
  })
  .refine(
    (value) =>
      value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".."),
    {
      message: "must not contain an empty, '.' or '..' segment",
    },
  );
export type RepositoryPath = z.infer<typeof RepositoryPathSchema>;

export const GateFindingIdSchema = z
  .string()
  .regex(/^F-\d{2,}$/, { message: "must be F- followed by at least two digits" });

export const GateFindingSchema = z.strictObject({
  id: GateFindingIdSchema,
  /** The gate-standard rule it breaks. */
  rule: z.int().min(1).max(GATE_STANDARD_RULES),
  found: z.string().min(1),
  /** The contract decision that answers it. */
  decisionId: z.string().min(1),
  /** The gate machinery it touched. */
  paths: z.array(RepositoryPathSchema),
});
export type GateFinding = z.infer<typeof GateFindingSchema>;

const unique = (values: readonly string[]): boolean => new Set(values).size === values.length;

export const GateHealthSchema = z
  .strictObject({
    ...projectScoped,
    /** The program whose planning audited it. */
    programId: ProgramIdSchema,
    /** The commit audited. */
    commit: CommitShaSchema,
    /** The gate fingerprint at that commit (D-P15-02). */
    fingerprint: Sha256HexSchema,
    verdict: GateHealthVerdictSchema,
    findings: z
      .array(GateFindingSchema)
      .refine((findings) => unique(findings.map((finding) => finding.id)), {
        message: "finding ids must be unique",
      }),
    /** The files the auditor named as gate machinery. */
    machinery: z.array(RepositoryPathSchema).refine(unique, {
      message: "machinery paths must be unique",
    }),
    /** Who recorded it: the signed-in operator, or a run's engine. */
    auditedBy: PrincipalSchema,
    auditedAt: IsoTimestampSchema,
  })
  .refine((record) => record.verdict !== "healthy" || record.findings.length === 0, {
    message: "a healthy verdict has no findings",
    path: ["findings"],
  });
export type GateHealth = z.infer<typeof GateHealthSchema>;
