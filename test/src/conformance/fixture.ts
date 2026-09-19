/**
 * The conformance fixture: three Job Contracts, the same for every adapter
 * (D-P5-03, SC-P5-10).
 *
 * They are delegations against `test/fixtures/slice-repo`, written for a real
 * model and followed to the letter by the scripted harness's `conform`,
 * `conform-broken` and `hang` scripts. Nothing in them names a provider, and
 * nothing in them may: the identical contract has to execute through every
 * adapter, which is the whole of harness neutrality.
 */
import type { ScriptName } from "../harness/scripts.js";

export interface ConformanceJob {
  /** What the scripted harness does in a real model's place. */
  readonly script: ScriptName;
  readonly delegation: {
    readonly objective: string;
    readonly scope: { readonly includes: readonly string[]; readonly excludes?: readonly string[] };
    readonly acceptance: readonly string[];
  };
}

/**
 * Exploration, a source edit, a test edit, a shell command, progress, a decision
 * and completion: every Stage 4 item a working job can show, in one job.
 *
 * It does not say where the helpers live or how they are exported. Finding out
 * is the exploration.
 */
export const COMPLETING_JOB: ConformanceJob = {
  script: "conform",
  delegation: {
    objective:
      "This package has a small set of statistical helpers. Add a `median` helper that follows " +
      "the conventions the existing helpers already follow — where they live, how they treat an " +
      "empty list, how the package exports them, and how they are tested. Report progress when " +
      "you start and after each step. For an even-length list there is more than one defensible " +
      "answer: choose one, and record the choice with decision.record before you finish. Run " +
      "the test suite yourself, then report completion.",
    scope: { includes: ["src/**", "test/**"] },
    acceptance: [
      "median([3, 1, 2]) is 2, and an empty list is refused the way mean refuses one",
      "median is exported from the package's entry point beside the existing helpers",
      "new tests cover an odd-length and an even-length list, and the whole suite passes",
      "one decision is recorded about even-length lists",
    ],
  },
};

/**
 * The deterministic failure: the job asks for behaviour the fixture's own tests
 * contradict, and puts those tests out of scope. A worker that does exactly what
 * it was asked and says so ends `verification_failed`, because verification is
 * Nightshift's and the worker's report is only a claim (A-05).
 */
export const FAILING_JOB: ConformanceJob = {
  script: "conform-broken",
  delegation: {
    objective:
      "Change `sum` in src/math.js so that an empty list answers null rather than 0. Change " +
      "nothing else. The tests are outside your scope and are being updated by a separate job: " +
      "do not edit them, and do not wait for them. Report progress once, make the change, and " +
      "report completion.",
    scope: { includes: ["src/**"] },
    acceptance: ["sum([]) is null", "sum of a non-empty list is unchanged"],
  },
};

/** A worker that is still going when it is cancelled. */
export const CANCELLED_JOB: ConformanceJob = {
  script: "hang",
  delegation: {
    objective:
      "First report progress with the message 'waiting'. Then write, in your reply and not in " +
      "any file, a 20000 word history of the median as a statistic, in full, without stopping " +
      "early. Do not report completion until the essay is finished.",
    scope: { includes: ["src/**"] },
    acceptance: ["the essay is complete"],
  },
};
