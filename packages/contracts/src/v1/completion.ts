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

export const CompletionMemberRoleSchema = z.enum(["anchor", "contributing", "correction"]);
export type CompletionMemberRole = z.infer<typeof CompletionMemberRoleSchema>;

export const CompletionMemberRefSchema = z.strictObject({
  programId: ProgramIdSchema,
  runId: RunIdSchema,
  role: CompletionMemberRoleSchema,
});
export type CompletionMemberRef = z.infer<typeof CompletionMemberRefSchema>;

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
});
export type CompletionCheckpoint = z.infer<typeof CompletionCheckpointSchema>;

export const CompletionRevisionSchema = z.strictObject({
  version: z.int().min(1),
  actor: UserPrincipalSchema,
  recordedAt: IsoTimestampSchema,
  members: z.array(CompletionMemberRefSchema).min(1),
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
    if (
      last &&
      (last.version !== value.version ||
        JSON.stringify(last.members) !== JSON.stringify(value.members))
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["revisions"],
        message: "the last revision must equal the record's version and members",
      });
    }
  });
export type CompletionHistory = z.infer<typeof CompletionHistorySchema>;
