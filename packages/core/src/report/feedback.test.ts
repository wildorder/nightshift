import type { IsoTimestamp, Run, UserPrincipal } from "@nightshift/contracts";
import { describe, expect, it } from "vitest";
import { buildRunFeedback } from "../rules/feedback.js";
import { createFixtures, makeRun } from "../testing/factories.js";
import { feedbackCoverageOf, runFeedbackOf } from "./feedback.js";

const f = createFixtures();
const at = (n: number): IsoTimestamp =>
  new Date(Date.UTC(2026, 9, 1, 0, 0, n)).toISOString() as IsoTimestamp;
const ann = {
  kind: "user",
  userId: "ann",
  orgId: "org_01HF7YAT00GGGGGGGGGGGGGGGG",
} as UserPrincipal;
const ended = (status: Run["status"], endedAt = at(10)): Run =>
  makeRun(f, { runId: f.ids.next("run"), status, endedAt, startedAt: at(0) });
const vote = (run: Run, verdict: "worked" | "did_not_work" | null, when = at(70)) =>
  buildRunFeedback({ scope: run, verdict, actor: ann, at: when });

describe("feedbackCoverageOf", () => {
  it("counts rated, unrated and failed runs once, with rated runs as the denominator", () => {
    const a = ended("succeeded");
    const b = ended("failed");
    const c = ended("succeeded");
    const d = ended("succeeded");
    const open = makeRun(f, { runId: f.ids.next("run"), status: "running" });
    const coverage = feedbackCoverageOf(
      [a, b, c, d, open, a],
      [vote(a, "worked"), vote(b, "did_not_work"), vote(c, null), vote(open, "worked")],
    );
    expect(coverage).toEqual({
      eligible: 4,
      rated: 2,
      positive: 1,
      negative: 1,
      positiveShare: 0.5,
      unrated: 2,
    });
  });

  it("has no share when nothing is rated", () => {
    expect(feedbackCoverageOf([ended("succeeded")], [])).toEqual({
      eligible: 1,
      rated: 0,
      positive: 0,
      negative: 0,
      unrated: 1,
    });
  });
});

describe("runFeedbackOf", () => {
  it("reports not rated without a record or after a clear", () => {
    const run = ended("succeeded");
    expect(runFeedbackOf(run)).toEqual({ verdict: "not_rated", revisions: 0 });
    const cleared = buildRunFeedback({
      stored: vote(run, "worked"),
      scope: run,
      verdict: null,
      actor: ann,
      at: at(80),
    });
    expect(runFeedbackOf(run, cleared)).toEqual({ verdict: "not_rated", revisions: 2 });
  });

  it("reports who, when and the calendar delay from the run's end", () => {
    const run = ended("failed", at(10));
    const commit = "c".repeat(40) as never;
    const fb = buildRunFeedback({
      scope: run,
      verdict: "did_not_work",
      actor: ann,
      at: at(70),
      resultCommit: commit,
    });
    expect(runFeedbackOf(run, fb)).toEqual({
      verdict: "did_not_work",
      recordedAt: at(70),
      by: "ann",
      resultCommit: commit,
      ratingDelaySeconds: 60,
      revisions: 1,
    });
  });
});
