/**
 * Examination — independent scrutiny by a different model or provider (A-12).
 *
 * Judged against evidence: the contract, the diff, the tests and the
 * verification results, rather than the implementer's rationale. Findings stay
 * attached to the exact commit they were raised against, so a later commit
 * cannot inherit a clean examination.
 */
import { z } from "zod";
import {
  AgentIdSchema,
  ArtifactIdSchema,
  ExaminationIdSchema,
  ExecutionNodeIdSchema,
  VerificationIdSchema,
} from "../ids.js";
import { CommitShaSchema, IsoTimestampSchema, RiskLevelSchema, runScoped } from "./common.js";

/** `material` findings can block acceptance when policy says so; `minor` never does. */
export const FindingSeveritySchema = z.enum(["material", "minor"]);
export type FindingSeverity = z.infer<typeof FindingSeveritySchema>;

export const FindingResolutionSchema = z.enum(["unresolved", "fixed", "risk_accepted", "rejected"]);
export type FindingResolution = z.infer<typeof FindingResolutionSchema>;

export const ExaminationFindingSchema = z.strictObject({
  id: z.string().min(1),
  severity: FindingSeveritySchema,
  summary: z.string().min(1),
  /** What in the evidence supports the finding. An unevidenced finding is not actionable. */
  evidence: z.string().min(1),
  resolution: FindingResolutionSchema,
});
export type ExaminationFinding = z.infer<typeof ExaminationFindingSchema>;

export const ExaminationOutcomeSchema = z.enum(["passed", "findings_raised", "failed"]);
export type ExaminationOutcome = z.infer<typeof ExaminationOutcomeSchema>;

export const ExaminationSchema = z
  .strictObject({
    ...runScoped,
    examinationId: ExaminationIdSchema,
    executionNodeId: ExecutionNodeIdSchema,
    /** The verification this examination was run against. Examination follows verification. */
    verificationId: VerificationIdSchema,
    commitSha: CommitShaSchema,
    implementerAgentId: AgentIdSchema,
    examinerAgentId: AgentIdSchema,
    /** The risk level whose policy required this examination. */
    requiredByRisk: RiskLevelSchema,
    outcome: ExaminationOutcomeSchema,
    findings: z.array(ExaminationFindingSchema),
    reportArtifactId: ArtifactIdSchema.optional(),
    createdAt: IsoTimestampSchema,
  })
  .refine((value) => value.examinerAgentId !== value.implementerAgentId, {
    message: "an agent may not examine its own work",
    path: ["examinerAgentId"],
  })
  .refine((value) => (value.outcome === "passed" ? value.findings.length === 0 : true), {
    message: "outcome passed requires no findings",
    path: ["outcome"],
  });
export type Examination = z.infer<typeof ExaminationSchema>;
