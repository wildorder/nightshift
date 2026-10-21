/**
 * Completion history (D-05): an explicit, project-bounded grouping of runs that
 * delivered one outcome.
 *
 * Membership is never inferred from program identity; a person names it. A
 * member reference carries no projectId because every member is in the
 * record's project by construction. Checkpoints are named positive-verdict
 * snapshots that later changes never rewrite.
 *
 * `version` counts writes; a write names the version it replaces plus one.
 */
import { z } from "zod";
import { CompletionHistoryIdSchema, ProgramIdSchema, RunIdSchema } from "../ids.js";
import { IsoTimestampSchema, runScoped } from "./common.js";
import { UserPrincipalSchema } from "./principal.js";

export const MAX_COMPLETION_MEMBERS = 50;
export const MAX_COMPLETION_CHECKPOINTS = 20;
export const MAX_COMPLETION_REVISIONS = 100;
/**
 * The most JSON bytes a valid history may serialize to. Membership snapshots in
 * up to 20 checkpoints and a bounded revision log would otherwise exceed
 * DynamoDB's 400 KiB item; this bound keeps every valid record under the AWS
 * adapter's item guard with margin for its keys and attributes.
 */
export const MAX_COMPLETION_HISTORY_BYTES = 300_000;

export const CompletionMemberRoleSchema = z.enum(["anchor", "contributing", "correction"]);
export type CompletionMemberRole = z.infer<typeof CompletionMemberRoleSchema>;

export const CompletionMemberRefSchema = z.strictObject({
  programId: ProgramIdSchema,
  runId: RunIdSchema,
  role: CompletionMemberRoleSchema,
});
export type CompletionMemberRef = z.infer<typeof CompletionMemberRefSchema>;

const nonNegativeInt = z.int().min(0);
const nonNegative = z.number().min(0);

/**
 * The figures a checkpoint froze, computed by the server when it was recorded.
 * Time figures are bounded at the verdict: intervals are clipped to
 * `measuredTo`, runs still open end there, and runs started after it
 * contribute nothing. Tokens and dollars are the totals observed when the
 * checkpoint was recorded, because measurement summaries carry no time slices.
 * Nothing later rewrites any of it. `usd`, `tokens` and `coverage` are absent when
 * no member contributed evidence, never zero.
 */
export const CompletionMeasurementSchema = z
  .strictObject({
    /** The boundary: the verdict's recordedAt. */
    measuredTo: IsoTimestampSchema,
    readableMembers: nonNegativeInt,
    /** Readable members that contributed resource evidence to `tokens`, `usd` and `coverage`. */
    measuredMembers: nonNegativeInt,
    /** Readable members with no resource evidence, whether unavailable or genuinely unmeasured. */
    unmeasuredMembers: nonNegativeInt,
    earliestStart: IsoTimestampSchema.optional(),
    leadTimeSeconds: nonNegative.optional(),
    runCompletionSeconds: nonNegative.optional(),
    activeSeconds: nonNegative,
    tokens: z
      .strictObject({
        input: nonNegativeInt.optional(),
        output: nonNegativeInt.optional(),
        cacheRead: nonNegativeInt.optional(),
        cacheWrite: nonNegativeInt.optional(),
        reasoning: nonNegativeInt.optional(),
        inputConventionUnknown: nonNegativeInt,
      })
      .optional(),
    usd: z.strictObject({ estimated: nonNegative, reported: nonNegative }).optional(),
    coverage: z
      .strictObject({
        complete: nonNegativeInt,
        partial: nonNegativeInt,
        unknown: nonNegativeInt,
        legacy: nonNegativeInt,
        missing: nonNegativeInt,
      })
      .optional(),
    /** Absent, not zero, when no readable member has a machine report. */
    infrastructure: z
      .strictObject({
        usd: nonNegative,
        members: nonNegativeInt,
        /** Readable members with no machine report: local runs, or none observed. */
        withoutMachine: nonNegativeInt,
      })
      .optional(),
    /** When the server measured it. */
    recordedAt: IsoTimestampSchema,
  })
  .superRefine((value, ctx) => {
    if (value.measuredMembers + value.unmeasuredMembers !== value.readableMembers) {
      ctx.addIssue({
        code: "custom",
        path: ["unmeasuredMembers"],
        message: "measuredMembers and unmeasuredMembers must add up to readableMembers",
      });
    }
    if (
      value.infrastructure !== undefined &&
      value.infrastructure.members + value.infrastructure.withoutMachine !== value.readableMembers
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["infrastructure", "withoutMachine"],
        message: "infrastructure members and withoutMachine must add up to readableMembers",
      });
    }
    if (
      value.measuredMembers === 0 &&
      (value.usd !== undefined || value.tokens !== undefined || value.coverage !== undefined)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "usd, tokens and coverage are absent, not zero, when no member was measured",
      });
    }
  });
export type CompletionMeasurement = z.infer<typeof CompletionMeasurementSchema>;

export const CompletionCheckpointSchema = z.strictObject({
  name: z.string().min(1).max(80),
  programId: ProgramIdSchema,
  runId: RunIdSchema,
  feedbackVersion: z.int().min(1),
  verdictRecordedAt: IsoTimestampSchema,
  /** The membership snapshot at that time. */
  members: z.array(CompletionMemberRefSchema).min(1),
  membershipVersion: z.int().min(1),
  recordedBy: UserPrincipalSchema,
  recordedAt: IsoTimestampSchema,
  measured: CompletionMeasurementSchema,
});
export type CompletionCheckpoint = z.infer<typeof CompletionCheckpointSchema>;

export const CompletionRevisionSchema = z.strictObject({
  version: z.int().min(1),
  actor: UserPrincipalSchema,
  recordedAt: IsoTimestampSchema,
  /** Members added in this write; the first revision lists the initial members. */
  added: z.array(CompletionMemberRefSchema),
  removed: z.array(CompletionMemberRefSchema),
  /** Present when the title changed in this write. */
  title: z.string().min(1).max(200).optional(),
  /** The checkpoint name added in this write. */
  checkpoint: z.string().min(1).max(80).optional(),
});
export type CompletionRevision = z.infer<typeof CompletionRevisionSchema>;

const memberKey = (m: { programId: string; runId: string }): string => `${m.programId}/${m.runId}`;

export const CompletionHistorySchema = z
  .strictObject({
    /** The anchor run's scope. */
    ...runScoped,
    completionHistoryId: CompletionHistoryIdSchema,
    title: z.string().min(1).max(200),
    version: z.int().min(1),
    members: z.array(CompletionMemberRefSchema).min(1).max(MAX_COMPLETION_MEMBERS),
    checkpoints: z.array(CompletionCheckpointSchema).max(MAX_COMPLETION_CHECKPOINTS),
    revisions: z.array(CompletionRevisionSchema).min(1).max(MAX_COMPLETION_REVISIONS),
    createdAt: IsoTimestampSchema,
    updatedAt: IsoTimestampSchema,
  })
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    value.members.forEach((member, i) => {
      const key = memberKey(member);
      if (seen.has(key)) {
        ctx.addIssue({
          code: "custom",
          path: ["members", i],
          message: "members must be unique by programId and runId",
        });
      }
      seen.add(key);
    });
    const anchors = value.members.filter((m) => m.role === "anchor");
    const anchor = anchors[0];
    if (
      anchors.length !== 1 ||
      !anchor ||
      anchor.programId !== value.programId ||
      anchor.runId !== value.runId
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["members"],
        message: "exactly one member must be the anchor, and it must be the record's own run",
      });
    }
    const names = new Set<string>();
    value.checkpoints.forEach((checkpoint, i) => {
      if (names.has(checkpoint.name)) {
        ctx.addIssue({
          code: "custom",
          path: ["checkpoints", i, "name"],
          message: "checkpoint names must be unique",
        });
      }
      names.add(checkpoint.name);
    });
    const last = value.revisions[value.revisions.length - 1];
    if (last && last.version !== value.version) {
      ctx.addIssue({
        code: "custom",
        path: ["revisions"],
        message: "the last revision must equal the record's version",
      });
    }
    if (new TextEncoder().encode(JSON.stringify(value)).length > MAX_COMPLETION_HISTORY_BYTES) {
      ctx.addIssue({
        code: "custom",
        message: `a completion history must serialize to at most ${MAX_COMPLETION_HISTORY_BYTES} bytes`,
      });
    }
  });
export type CompletionHistory = z.infer<typeof CompletionHistorySchema>;
