import type {
  CompletionHistory,
  CompletionMemberRef,
  IsoTimestamp,
  Run,
  RunFeedback,
  UserPrincipal,
} from "@nightshift/contracts";
import { describe, expect, it } from "vitest";
import { buildCompletionHistory, reconcileCompletionWrite } from "../rules/completion.js";
import { buildRunFeedback } from "../rules/feedback.js";
import { createFixtures, makeRun } from "../testing/factories.js";
import { completionOf, measureCompletion } from "./completion.js";
import type { ResourceTotals } from "./resources.js";

const f = createFixtures();
const at = (n: number): IsoTimestamp =>
  new Date(Date.UTC(2026, 9, 1, 0, 0, n)).toISOString() as IsoTimestamp;
const ann = {
  kind: "user",
  userId: "ann",
  orgId: "org_01HF7YAT00GGGGGGGGGGGGGGGG",
} as UserPrincipal;
const keyOf = (r: { programId: string; runId: string }) => `${r.programId}/${r.runId}`;
const refOf = (run: Run, role: CompletionMemberRef["role"]): CompletionMemberRef => ({
  programId: run.programId,
  runId: run.runId,
  role,
});
const vote = (
  run: Run,
  verdict: "worked" | "did_not_work" | null,
  when: IsoTimestamp,
  stored?: RunFeedback,
) => buildRunFeedback({ ...(stored ? { stored } : {}), scope: run, verdict, actor: ann, at: when });

// The anchor ran 0..100 and was rated down; the correction (another program) ran 150..200 and was rated up at 260.
const anchor = makeRun(f, {
  status: "failed",
  startedAt: at(0),
  endedAt: at(100),
  outcomeReason: "x",
});
const fix = makeRun(f, {
  programId: f.ids.next("prog"),
  runId: f.ids.next("run"),
  status: "succeeded",
  startedAt: at(150),
  endedAt: at(200),
  carriedStrands: [{ strandId: "S-01", fromRunId: anchor.runId, landed: [] }],
});
const runs = new Map([anchor, fix].map((r) => [keyOf(r), r]));
const history = (
  members: CompletionMemberRef[],
  checkpoints: CompletionHistory["checkpoints"] = [],
) => {
  const base = buildCompletionHistory({
    scope: f.scope,
    completionHistoryId: f.ids.next("comp"),
    title: "Outcome",
    members,
    actor: ann,
    at: at(1),
  });
  return { ...base, checkpoints } as CompletionHistory;
};
const totals = (input: number, reported: number): ResourceTotals => ({
  tokens: { input, inputConventionUnknown: 0 },
  usd: { estimated: 0, reported },
  unpriced: 0,
  coverage: { complete: 1, partial: 0, unknown: 0, legacy: 0, missing: 0 },
  tokenCoverage: "complete",
});

describe("completionOf", () => {
  const members = [refOf(anchor, "anchor"), refOf(fix, "correction")];
  const down = vote(anchor, "did_not_work", at(120));
  const up = vote(fix, "worked", at(260));
  const feedback = new Map([
    [keyOf(anchor), down],
    [keyOf(fix), up],
  ]);

  it("leads to the correction's verdict and counts both runs once", () => {
    const report = completionOf({
      history: history([...members, members[1] as CompletionMemberRef]),
      runs,
      feedback,
      asOf: at(300),
    });
    expect(report.members).toEqual([
      {
        programId: anchor.programId,
        runId: anchor.runId,
        role: "anchor",
        status: "failed",
        verdict: "did_not_work",
        carriedStrands: 0,
      },
      {
        programId: fix.programId,
        runId: fix.runId,
        role: "correction",
        status: "succeeded",
        verdict: "worked",
        carriedStrands: 1,
      },
    ]);
    expect(report.coverage).toEqual({
      eligible: 2,
      rated: 2,
      positive: 1,
      negative: 1,
      positiveShare: 0.5,
      unrated: 0,
    });
    expect(report.current).toEqual({
      leadTimeSeconds: 260,
      acceptedRun: { programId: fix.programId, runId: fix.runId },
      runCompletionSeconds: 200,
      activeSeconds: 150,
      membershipVersion: 1,
    });
    expect(report.checkpoints).toEqual([]);
    expect(report.laterFixes).toEqual([]);
  });

  it("unions overlapping intervals and runs open ones to asOf", () => {
    const overlap = makeRun(f, { runId: f.ids.next("run"), status: "running", startedAt: at(50) });
    const withOverlap = new Map(runs).set(keyOf(overlap), overlap);
    const report = completionOf({
      history: history([...members, refOf(overlap, "contributing")]),
      runs: withOverlap,
      feedback,
      asOf: at(400),
    });
    // [0,100] ∪ [150,200] ∪ [50,400] = [0,400]
    expect(report.current.activeSeconds).toBe(400);
    expect(report.coverage.eligible).toBe(2);
  });

  it("marks a missing run unreadable and leaves it out of the figures", () => {
    const ghost: CompletionMemberRef = {
      programId: fix.programId,
      runId: f.ids.next("run"),
      role: "contributing",
    };
    const report = completionOf({
      history: history([...members, ghost]),
      runs,
      feedback,
      asOf: at(300),
    });
    expect(report.members[2]).toEqual({
      programId: ghost.programId,
      runId: ghost.runId,
      role: "contributing",
      verdict: "not_rated",
      carriedStrands: 0,
      unreadable: true,
    });
    expect(report.coverage.eligible).toBe(2);
    expect(report.current.activeSeconds).toBe(150);
  });

  it("sums resources and infrastructure once per member", () => {
    const report = completionOf({
      history: history(members),
      runs,
      feedback,
      resources: new Map([
        [keyOf(anchor), totals(100, 1)],
        [keyOf(fix), totals(50, 0.5)],
      ]),
      asOf: at(300),
    });
    expect(report.current.resources?.tokens.input).toBe(150);
    expect(report.current.resources?.usd.reported).toBe(1.5);
    expect(report.current.resources?.coverage.complete).toBe(2);
  });

  it("keeps a checkpoint's figures when the verdict is later cleared", () => {
    const fixRef = refOf(fix, "correction");
    const proposed = buildCompletionHistory({
      scope: f.scope,
      completionHistoryId: f.ids.next("comp"),
      title: "Outcome",
      members,
      actor: ann,
      at: at(270),
      checkpoint: { name: "accepted", programId: fix.programId, runId: fix.runId },
    });
    const stored = reconcileCompletionWrite({
      proposed,
      actor: ann,
      at: at(270),
      memberRuns: runs,
      feedbackOf: feedback,
    }).history;
    expect(fixRef.role).toBe("correction");
    const cleared = new Map(feedback).set(keyOf(fix), vote(fix, null, at(280), up));
    const later = makeRun(f, {
      runId: f.ids.next("run"),
      status: "succeeded",
      startedAt: at(210),
      endedAt: at(250),
    });
    const grown = {
      ...stored,
      members: [...stored.members, refOf(later, "contributing")],
      version: 2,
    } as CompletionHistory;
    const report = completionOf({
      history: grown,
      runs: new Map(runs).set(keyOf(later), later),
      feedback: cleared,
      asOf: at(300),
    });
    expect(report.current.leadTimeSeconds).toBeUndefined();
    expect(report.current.acceptedRun).toBeUndefined();
    expect(report.current.runCompletionSeconds).toBeUndefined();
    expect(report.current.activeSeconds).toBe(190);
    expect(report.checkpoints).toEqual([
      {
        name: "accepted",
        recordedAt: at(270),
        verdictRecordedAt: at(260),
        leadTimeSeconds: 260,
        acceptedRun: { programId: fix.programId, runId: fix.runId },
        runCompletionSeconds: 200,
        activeSeconds: 150,
        membershipVersion: 1,
      },
    ]);
    expect(report.laterFixes.map((m) => m.runId)).toEqual([later.runId]);
    expect(report.version).toBe(2);
  });

  describe("a frozen checkpoint measurement", () => {
    // Time zero is 09:00. The anchor ran 09:00..10:00 and was rated worked at 10:00;
    // a contributing run started at 09:00 and is still open.
    const hour = 3600;
    const anchor1 = makeRun(f, {
      status: "succeeded",
      startedAt: at(0),
      endedAt: at(hour),
    });
    const open = makeRun(f, {
      runId: f.ids.next("run"),
      status: "running",
      startedAt: at(0),
    });
    const rated = vote(anchor1, "worked", at(hour));
    const fb = new Map([[keyOf(anchor1), rated]]);
    const open1 = new Map([anchor1, open].map((r) => [keyOf(r), r]));
    const both = [refOf(anchor1, "anchor"), refOf(open, "contributing")];
    const resources = new Map([
      [keyOf(anchor1), totals(100, 1)],
      [keyOf(open), totals(50, 0.5)],
    ]);
    const infra = (usd: number) =>
      ({
        components: { total: { usd } },
      }) as unknown as import("./infrastructure.js").InfrastructureReport;
    const stored = (
      extra: Parameters<typeof reconcileCompletionWrite>[0]["resources"] = resources,
    ) => {
      const proposed = buildCompletionHistory({
        scope: f.scope,
        completionHistoryId: f.ids.next("comp"),
        title: "T",
        members: both,
        actor: ann,
        at: at(hour),
        checkpoint: { name: "cp", programId: anchor1.programId, runId: anchor1.runId },
      });
      return reconcileCompletionWrite({
        proposed,
        actor: ann,
        at: at(hour),
        memberRuns: open1,
        feedbackOf: fb,
        ...(extra === undefined ? {} : { resources: extra }),
        infrastructure: new Map([[keyOf(anchor1), infra(2)]]),
      }).history;
    };

    it("reports the same checkpoint at 10:00 and 12:00 while the current view grows", () => {
      const history = stored();
      const at10 = completionOf({ history, runs: open1, feedback: fb, asOf: at(hour) });
      const at12 = completionOf({ history, runs: open1, feedback: fb, asOf: at(3 * hour) });
      expect(at10.checkpoints[0]?.activeSeconds).toBe(3600);
      expect(at12.checkpoints[0]).toEqual(at10.checkpoints[0]);
      expect(at12.checkpoints[0]?.leadTimeSeconds).toBe(3600);
      expect(at10.current.activeSeconds).toBe(3600);
      expect(at12.current.activeSeconds).toBe(10800);
    });

    it("leaves tokens, dollars and infrastructure alone when members or measurements change", () => {
      const history = stored();
      const before = completionOf({ history, runs: open1, feedback: fb, asOf: at(hour) });
      const grown = new Map([
        [keyOf(anchor1), totals(1000, 10)],
        [keyOf(open), totals(500, 5)],
      ]);
      const after = completionOf({
        history: { ...history, members: [history.members[0] as CompletionMemberRef] },
        runs: open1,
        feedback: fb,
        resources: grown,
        infrastructure: new Map([[keyOf(anchor1), infra(99)]]),
        asOf: at(3 * hour),
      });
      expect(after.checkpoints[0]).toEqual(before.checkpoints[0]);
      expect(after.checkpoints[0]?.resources?.tokens.input).toBe(150);
      expect(after.checkpoints[0]?.resources?.usd).toEqual({ estimated: 0, reported: 1.5 });
      expect(after.checkpoints[0]?.infrastructure).toEqual({ usd: 2, members: 1 });
    });

    it("counts a run started after the boundary for nothing", () => {
      const late = makeRun(f, {
        runId: f.ids.next("run"),
        status: "succeeded",
        startedAt: at(2 * hour),
        endedAt: at(3 * hour),
      });
      const measured = measureCompletion({
        members: [...both, refOf(late, "contributing")],
        runs: new Map(open1).set(keyOf(late), late),
        feedback: fb,
        resources: new Map(resources).set(keyOf(late), totals(7, 7)),
        accepted: { ref: refOf(anchor1, "anchor"), verdictAt: at(hour) },
        boundary: at(hour),
      });
      expect(measured.readableMembers).toBe(2);
      expect(measured.activeSeconds).toBe(3600);
      expect(measured.tokens?.input).toBe(150);
      expect(measured.runCompletionSeconds).toBe(3600);
    });
  });
});
