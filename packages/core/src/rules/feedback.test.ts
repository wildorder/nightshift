import type { IsoTimestamp, RunFeedback, UserPrincipal } from "@nightshift/contracts";
import { MAX_FEEDBACK_REVISIONS } from "@nightshift/contracts";
import { describe, expect, it } from "vitest";
import { StaleWriteError } from "../errors.js";
import { createFixtures, makeRun } from "../testing/factories.js";
import { buildRunFeedback, isRunRateable, reconcileFeedbackWrite } from "./feedback.js";

const f = createFixtures();
const at = (n: number): IsoTimestamp =>
  new Date(Date.UTC(2026, 9, 1, 0, 0, n)).toISOString() as IsoTimestamp;
const user = (userId: string): UserPrincipal =>
  ({
    kind: "user",
    userId,
    orgId: "org_01HF7YAT00GGGGGGGGGGGGGGGG",
  }) as UserPrincipal;
const ann = user("ann");
const bob = user("bob");
const commit = "a".repeat(40) as never;

const first = (verdict: "worked" | "did_not_work" | null = "worked"): RunFeedback =>
  buildRunFeedback({ scope: f.scope, verdict, actor: ann, at: at(1), resultCommit: commit });

describe("buildRunFeedback", () => {
  it("starts at version 1 with one revision", () => {
    const fb = first();
    expect(fb.version).toBe(1);
    expect(fb.verdict).toBe("worked");
    expect(fb.recordedAt).toBe(at(1));
    expect(fb.resultCommit).toBe(commit);
    expect(fb.revisions).toEqual([
      { version: 1, verdict: "worked", actor: ann, recordedAt: at(1), resultCommit: commit },
    ]);
  });

  it("appends a revision and bumps the version", () => {
    const next = buildRunFeedback({
      stored: first(),
      scope: f.scope,
      verdict: "did_not_work",
      actor: bob,
      at: at(2),
    });
    expect(next.version).toBe(2);
    expect(next.actor).toEqual(bob);
    expect(next.resultCommit).toBeUndefined();
    expect(next.revisions.map((r) => r.version)).toEqual([1, 2]);
  });

  it("drops the oldest revision past the cap", () => {
    let fb = first();
    for (let i = 0; i < MAX_FEEDBACK_REVISIONS + 5; i++) {
      fb = buildRunFeedback({
        stored: fb,
        scope: f.scope,
        verdict: i % 2 === 0 ? "did_not_work" : "worked",
        actor: ann,
        at: at(2 + i),
      });
    }
    expect(fb.version).toBe(MAX_FEEDBACK_REVISIONS + 6);
    expect(fb.revisions).toHaveLength(MAX_FEEDBACK_REVISIONS);
    expect(fb.revisions[0]?.version).toBe(7);
    expect(fb.revisions[MAX_FEEDBACK_REVISIONS - 1]?.version).toBe(fb.version);
  });
});

describe("reconcileFeedbackWrite", () => {
  const forged = (over: Partial<RunFeedback>): RunFeedback => ({
    ...first("did_not_work"),
    actor: bob,
    recordedAt: at(99),
    ...over,
  });

  it("stores a first vote with the server's attribution, ignoring the proposal's", () => {
    const proposed = forged({ version: 1 });
    const result = reconcileFeedbackWrite({
      proposed,
      actor: ann,
      at: at(5),
      resultCommit: commit,
    });
    expect(result.outcome).toBe("stored");
    if (result.outcome === "nothing_to_clear") throw new Error("unreachable");
    expect(result.feedback.actor).toEqual(ann);
    expect(result.feedback.recordedAt).toBe(at(5));
    expect(result.feedback.resultCommit).toBe(commit);
    expect(result.feedback.revisions).toEqual([
      { version: 1, verdict: "did_not_work", actor: ann, recordedAt: at(5), resultCommit: commit },
    ]);
  });

  it("does not take a proposed resultCommit the server did not capture", () => {
    const result = reconcileFeedbackWrite({
      proposed: forged({ version: 1, resultCommit: "b".repeat(40) as never }),
      actor: ann,
      at: at(5),
    });
    if (result.outcome === "nothing_to_clear") throw new Error("unreachable");
    expect(result.feedback.resultCommit).toBeUndefined();
  });

  it("reports nothing to clear when nothing is stored", () => {
    const proposed = buildRunFeedback({ scope: f.scope, verdict: null, actor: ann, at: at(1) });
    expect(reconcileFeedbackWrite({ proposed, actor: ann, at: at(2) })).toEqual({
      outcome: "nothing_to_clear",
    });
  });

  it("refuses a first write that names a later version", () => {
    const proposed = forged({ version: 3 });
    expect(() => reconcileFeedbackWrite({ proposed, actor: ann, at: at(2) })).toThrow(
      new StaleWriteError("run feedback", 2, 0),
    );
  });

  it("treats a repeated vote as unchanged, with no new revision", () => {
    const stored = first("worked");
    const result = reconcileFeedbackWrite({
      stored,
      proposed: forged({ version: 2, verdict: "worked" }),
      actor: bob,
      at: at(9),
    });
    expect(result).toEqual({ outcome: "unchanged", feedback: stored });
    if (result.outcome === "unchanged") expect(result.feedback.revisions).toHaveLength(1);
  });

  it("stores a changed vote as a new revision by the server's actor", () => {
    const stored = first("worked");
    const result = reconcileFeedbackWrite({
      stored,
      proposed: forged({ version: 2, verdict: "did_not_work" }),
      actor: bob,
      at: at(9),
    });
    expect(result.outcome).toBe("stored");
    if (result.outcome === "nothing_to_clear") throw new Error("unreachable");
    expect(result.feedback.version).toBe(2);
    expect(result.feedback.verdict).toBe("did_not_work");
    expect(result.feedback.actor).toEqual(bob);
    expect(result.feedback.recordedAt).toBe(at(9));
    expect(result.feedback.revisions.map((r) => [r.version, r.verdict])).toEqual([
      [1, "worked"],
      [2, "did_not_work"],
    ]);
  });

  it("clears a stored verdict", () => {
    const result = reconcileFeedbackWrite({
      stored: first("worked"),
      proposed: forged({ version: 2, verdict: null }),
      actor: ann,
      at: at(9),
    });
    if (result.outcome === "nothing_to_clear") throw new Error("unreachable");
    expect(result.outcome).toBe("stored");
    expect(result.feedback.verdict).toBeNull();
  });

  it("clearing an already cleared verdict is unchanged", () => {
    const cleared = buildRunFeedback({
      stored: first(),
      scope: f.scope,
      verdict: null,
      actor: ann,
      at: at(2),
    });
    const result = reconcileFeedbackWrite({
      stored: cleared,
      proposed: forged({ version: 3, verdict: null }),
      actor: ann,
      at: at(3),
    });
    expect(result.outcome).toBe("unchanged");
  });

  it("replays the same writer's retried write", () => {
    const stored = first("worked");
    const result = reconcileFeedbackWrite({
      stored,
      proposed: forged({ version: 1, verdict: "worked" }),
      actor: ann,
      at: at(9),
    });
    expect(result).toEqual({ outcome: "replayed", feedback: stored });
  });

  it("refuses the same version from another writer or with another verdict", () => {
    const stored = first("worked");
    expect(() =>
      reconcileFeedbackWrite({
        stored,
        proposed: forged({ version: 1, verdict: "worked" }),
        actor: bob,
        at: at(9),
      }),
    ).toThrow(new StaleWriteError("run feedback", 0, 1));
    expect(() =>
      reconcileFeedbackWrite({
        stored,
        proposed: forged({ version: 1, verdict: "did_not_work" }),
        actor: ann,
        at: at(9),
      }),
    ).toThrow(StaleWriteError);
  });

  it("refuses a stale or skipped version", () => {
    const stored = buildRunFeedback({
      stored: first(),
      scope: f.scope,
      verdict: "did_not_work",
      actor: ann,
      at: at(2),
    });
    for (const version of [1, 4]) {
      expect(() =>
        reconcileFeedbackWrite({
          stored,
          proposed: forged({ version, verdict: "worked" }),
          actor: ann,
          at: at(9),
        }),
      ).toThrow(new StaleWriteError("run feedback", version - 1, 2));
    }
  });
});

describe("isRunRateable", () => {
  it("needs a terminal status and an end time", () => {
    expect(isRunRateable(makeRun(f, { status: "running" }))).toBe(false);
    expect(isRunRateable(makeRun(f, { status: "succeeded" }))).toBe(false);
    expect(
      isRunRateable(makeRun(f, { status: "failed", endedAt: at(3), outcomeReason: "x" })),
    ).toBe(true);
    expect(isRunRateable(makeRun(f, { status: "succeeded", endedAt: at(3) }))).toBe(true);
  });
});
