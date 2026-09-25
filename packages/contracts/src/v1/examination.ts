/**
 * Examination — independent scrutiny by a different model or provider (A-12).
 *
 * Judged against evidence: the contract, the diff, the tests and the
 * verification results, rather than the implementer's rationale (D-P8-11).
 * Findings stay attached to the exact commit and the exact diff they were raised
 * against (D-P8-12): the commit is where it was examined, and the diff's
 * `patchId` is what lets the examination carry over when the merge queue replays
 * the same change onto a newer head (D-P8-09), and only then.
 *
 * Written once by the examiner. After that, only a finding's `resolution` may
 * move, and only forward (`explainExaminationUpdate` in `core`): a fix, a
 * dispute, an arbiter's ruling, or a human accepting the risk.
 */
import { z } from "zod";
import {
  AgentIdSchema,
  ArtifactIdSchema,
  DecisionIdSchema,
  ExaminationIdSchema,
  ExecutionNodeIdSchema,
  VerificationIdSchema,
} from "../ids.js";
import {
  CommitShaSchema,
  IsoTimestampSchema,
  PathGlobSchema,
  RiskLevelSchema,
  runScoped,
} from "./common.js";
import { DecisionAuthoritySchema } from "./decision.js";
import { RouteTargetSchema } from "./routing-decision.js";

/** `material` findings can block acceptance when policy says so; `minor` never does. */
export const FindingSeveritySchema = z.enum(["material", "minor"]);
export type FindingSeverity = z.infer<typeof FindingSeveritySchema>;

/**
 * Where a finding stands (D-P8-13). `unresolved` until something happens to it;
 * `disputed` while an arbiter is asked; the rest are endings.
 */
export const FindingResolutionSchema = z.enum([
  "unresolved",
  /** A later attempt at the job was examined and the finding was not raised again. */
  "fixed",
  /** The delegating orchestrator says the finding is wrong. Not an ending under a blocking policy. */
  "disputed",
  /** An arbiter ruled the finding wrong. The work may land. */
  "overturned",
  /** An arbiter ruled the finding right. The job fails. */
  "upheld",
  /** A human accepted the risk. Only a human (D-P8-13). */
  "risk_accepted",
]);
export type FindingResolution = z.infer<typeof FindingResolutionSchema>;

/**
 * What in the evidence supports a finding (D-P8-12). At least one per finding,
 * and each points at something a reader can check: a range of lines in the
 * examined commit, a command and what it printed, or a clause of the contract
 * the change contradicts.
 */
export const FindingEvidenceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("location"),
    path: PathGlobSchema,
    startLine: z.int().min(1),
    endLine: z.int().min(1),
    /** What is there, briefly. */
    note: z.string().min(1).optional(),
  }),
  z.strictObject({
    kind: z.literal("command"),
    command: z.string().min(1),
    exitCode: z.int(),
    /** What it printed, or the part that matters. Large output belongs in an artifact. */
    output: z.string().max(4000),
    outputArtifactId: ArtifactIdSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal("contract"),
    /** The clause, quoted or named: an acceptance criterion, a constraint, a scope rule. */
    clause: z.string().min(1),
  }),
]);
export type FindingEvidence = z.infer<typeof FindingEvidenceSchema>;

/** Who moved a finding's resolution, and on what authority. */
export const FindingResolvedBySchema = z.strictObject({
  authority: DecisionAuthoritySchema,
  /** The arbiter's ruling, or the human's, when one moved it. */
  decisionId: DecisionIdSchema.optional(),
  /** A dispute's reason, a fix's attempt, a human's note. */
  reason: z.string().min(1).optional(),
  at: IsoTimestampSchema,
});
export type FindingResolvedBy = z.infer<typeof FindingResolvedBySchema>;

export const ExaminationFindingSchema = z.strictObject({
  id: z.string().min(1),
  severity: FindingSeveritySchema,
  summary: z.string().min(1),
  evidence: z.array(FindingEvidenceSchema).min(1),
  resolution: FindingResolutionSchema,
  resolvedBy: FindingResolvedBySchema.optional(),
  /**
   * On an examination of an attempt that carried out an arbiter's ruling: the
   * ruled finding this one says is still not fixed. Only such a finding can
   * block that examination (D-P8-13, as amended 2026-09-25).
   */
  concerns: z.string().min(1).optional(),
});
export type ExaminationFinding = z.infer<typeof ExaminationFindingSchema>;

/**
 * An arbiter's ruling that a finding stands, as the attempt after it carries it
 * out (D-P8-13, as amended 2026-09-25). The ruling is final: the next attempt is
 * built to it, and its examination checks only that it was.
 */
export const ExaminationRulingSchema = z.strictObject({
  findingId: z.string().min(1),
  decisionId: DecisionIdSchema,
  /** What the finding said. */
  summary: z.string().min(1),
  /** Why the arbiter upheld it: what the next attempt must make true. */
  rationale: z.string().min(1),
});
export type ExaminationRuling = z.infer<typeof ExaminationRulingSchema>;

/**
 * One question the examiner put to the builder, and its answer (D-P8-15).
 * `answeredBy` says whether the builder's own session was resumed or its route
 * read the transcript instead.
 */
export const ExaminationQuestionSchema = z.strictObject({
  question: z.string().min(1),
  answer: z.string().min(1),
  answeredBy: z.enum(["resumed_session", "transcript"]),
});
export type ExaminationQuestion = z.infer<typeof ExaminationQuestionSchema>;

/** At most three questions, in one round (D-P8-15). */
export const MAX_EXAMINATION_QUESTIONS = 3;

/** At most two fixes of one job for a blocking finding (D-P8-13). */
export const MAX_FIX_ATTEMPTS = 2;

/**
 * At most two attempts at carrying out an arbiter's upheld ruling (D-P8-13, as
 * amended 2026-09-25). Past that the builder could not make the change it was
 * ruled to make: a failure of the work, not a disagreement.
 */
export const MAX_RULING_ATTEMPTS = 2;

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
    /**
     * `git patch-id --stable` of the examined diff (D-P8-09, D-P8-12). The same
     * change replayed onto a newer head has the same one; a changed change does not.
     */
    patchId: z.string().regex(/^[0-9a-f]{40}$/),
    implementerAgentId: AgentIdSchema,
    examinerAgentId: AgentIdSchema,
    /** The examiner's harness, provider and model, for the independence checks (SC-P8-10). */
    examinerRoute: RouteTargetSchema,
    /** The risk level whose policy required this examination. */
    requiredByRisk: RiskLevelSchema,
    /** Whether that policy blocks on a material finding. */
    blocking: z.boolean(),
    /** 0 for the job's first attempt; 1 and 2 for its fixes (D-P8-13). */
    fixAttempt: z.int().min(0).max(MAX_FIX_ATTEMPTS),
    questions: z.array(ExaminationQuestionSchema).max(MAX_EXAMINATION_QUESTIONS),
    /**
     * Present when the attempt examined carried out an arbiter's upheld ruling:
     * this examination judges only whether it did, and only a finding that
     * `concerns` one of these can block.
     */
    followsRulings: z.array(ExaminationRulingSchema).min(1).optional(),
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
  })
  .refine(
    (value) => new Set(value.findings.map((finding) => finding.id)).size === value.findings.length,
    { message: "finding ids must be unique within an examination", path: ["findings"] },
  );
export type Examination = z.infer<typeof ExaminationSchema>;

/**
 * The findings that stop this examination's work landing: open material ones,
 * and on an examination of a ruling carried out, only those about the ruling.
 */
export const blockingFindings = (
  examination: Pick<Examination, "blocking" | "findings" | "followsRulings">,
): readonly ExaminationFinding[] => {
  if (!examination.blocking) return [];
  const ruled = examination.followsRulings?.map((ruling) => ruling.findingId);
  return examination.findings.filter(
    (finding) =>
      isOpenMaterialFinding(finding) &&
      (ruled === undefined || (finding.concerns !== undefined && ruled.includes(finding.concerns))),
  );
};

/** A material finding that still stands: unresolved, or disputed and not yet ruled on. */
export const isOpenMaterialFinding = (finding: ExaminationFinding): boolean =>
  finding.severity === "material" &&
  (finding.resolution === "unresolved" || finding.resolution === "disputed");
