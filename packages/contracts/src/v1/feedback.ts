/**
 * Run feedback (D-04): a human's one-click verdict on a run.
 *
 * A verdict is a human saying the run worked or did not. It creates no
 * Verification, changes no execution outcome and names no defect. Unrated is
 * absence of a record, not a negative vote, and revisions are history of what
 * the person said, not extra votes.
 *
 * One record per run, keyed by the run: it has no id of its own. `version`
 * counts writes; a write names the version it replaces plus one, and the store
 * refuses anything else. `verdict: null` means the person cleared their verdict.
 */
import { z } from "zod";
import { CommitShaSchema, IsoTimestampSchema, runScoped } from "./common.js";
import { UserPrincipalSchema } from "./principal.js";

export const MAX_FEEDBACK_REVISIONS = 100;

export const RunVerdictSchema = z.enum(["worked", "did_not_work"]);
export type RunVerdict = z.infer<typeof RunVerdictSchema>;

export const RunFeedbackRevisionSchema = z.strictObject({
  version: z.int().min(1),
  /** Null when the verdict was cleared. */
  verdict: RunVerdictSchema.nullable(),
  actor: UserPrincipalSchema,
  recordedAt: IsoTimestampSchema,
  resultCommit: CommitShaSchema.optional(),
});
export type RunFeedbackRevision = z.infer<typeof RunFeedbackRevisionSchema>;

export const RunFeedbackSchema = z
  .strictObject({
    ...runScoped,
    version: z.int().min(1),
    verdict: RunVerdictSchema.nullable(),
    actor: UserPrincipalSchema,
    recordedAt: IsoTimestampSchema,
    resultCommit: CommitShaSchema.optional(),
    revisions: z.array(RunFeedbackRevisionSchema).min(1).max(MAX_FEEDBACK_REVISIONS),
  })
  .superRefine((value, ctx) => {
    const { revisions } = value;
    for (let i = 1; i < revisions.length; i++) {
      const previous = revisions[i - 1];
      const current = revisions[i];
      if (previous && current && current.version <= previous.version) {
        ctx.addIssue({
          code: "custom",
          path: ["revisions", i, "version"],
          message: "revision versions must be strictly ascending",
        });
      }
    }
    const last = revisions[revisions.length - 1];
    if (
      last &&
      (last.version !== value.version ||
        last.verdict !== value.verdict ||
        last.recordedAt !== value.recordedAt ||
        last.resultCommit !== value.resultCommit ||
        JSON.stringify(last.actor) !== JSON.stringify(value.actor))
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["revisions"],
        message:
          "the last revision must equal the record's version, verdict, actor, recordedAt and resultCommit",
      });
    }
  });
export type RunFeedback = z.infer<typeof RunFeedbackSchema>;
