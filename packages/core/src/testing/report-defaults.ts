import type { Run } from "@nightshift/contracts";
import { deliveryOf } from "../report/delivery.js";
import { feedbackCoverageOf, runFeedbackOf } from "../report/feedback.js";
import { operationsOf } from "../report/operations.js";
import type { RunReport } from "../report/report.js";
import { reviewOf } from "../report/review.js";

/**
 * The S-05 fields of a `RunReport` for a run with no records: what the
 * reducers give over nothing. For tests that build a report literal.
 */
export const emptyMeasuredReport = (
  run: Run,
): Pick<
  RunReport,
  "operations" | "delivery" | "review" | "asOf" | "feedback" | "feedbackCoverage" | "completions"
> => ({
  feedback: runFeedbackOf(run),
  feedbackCoverage: feedbackCoverageOf([run], []),
  completions: [],
  operations: operationsOf({
    run,
    nodes: [],
    jobs: [],
    agents: [],
    routes: [],
    verifications: [],
    examinations: [],
    observations: [],
    asOf: run.startedAt,
  }),
  delivery: deliveryOf({ nodes: [], jobs: [], routes: [], verifications: [], measurements: [] }),
  review: reviewOf({
    nodes: [],
    jobs: [],
    routes: [],
    examinations: [],
    decisions: [],
    agents: [],
    measurements: [],
    events: [],
  }),
  asOf: run.startedAt,
});
