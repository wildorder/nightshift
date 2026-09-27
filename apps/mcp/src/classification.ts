/**
 * What a job says about itself, as both `delegate` tools ask for it (P8,
 * D-P8-01). One home, because the root's orchestrator and a strand's see the
 * same routing rules: the first planned runs on a real repository showed a
 * strand orchestrator never claiming low ambiguity, so nothing ever started on
 * the cheap rung, when the only guidance it had was a bare enum.
 */
import { JobKindSchema, RiskLevelSchema, TestabilitySchema } from "@nightshift/contracts";

export const CLASSIFICATION_INPUTS = {
  risk: RiskLevelSchema.optional().describe(
    "What goes wrong if this is wrong. low: a mistake is cheap and local. medium: it would " +
      "break something users or other code rely on. high: data, money, security, authorization " +
      "or anything hard to undo. It also decides examination: low is not examined; medium and " +
      "high are, by a different model, and a material finding stops the work landing until it " +
      "is fixed or an arbiter rules. Unset is the program's own risk.",
  ),
  ambiguity: RiskLevelSchema.optional().describe(
    "How much of the job is judgement rather than specification. low: the objective and " +
      "acceptance criteria say exactly what to change and how to know it is done, so no design " +
      "choice is left to the worker (a copy change, a rename, a deletion, a function whose " +
      "behaviour and tests you have specified). medium: some choices are the worker's. high: " +
      "the worker has to work out what is wanted. Unset is medium. A job that is low risk, low " +
      "ambiguity and strongly tested starts on the cheapest model, so say low when it is true.",
  ),
  testability: TestabilitySchema.optional().describe(
    "strong: the program's own checks exercise this change, so a cheap model's mistake is caught; " +
      "weak: they touch it only in passing; none: nothing checks it. Leave it unset if unsure: " +
      "unset is treated as weak, the conservative choice, not the cheap one.",
  ),
  jobKind: JobKindSchema.optional().describe(
    "What kind of work it is: implement, fix, refactor, test, docs. Routing rules may start " +
      "some kinds lower or higher on the ladder.",
  ),
};
