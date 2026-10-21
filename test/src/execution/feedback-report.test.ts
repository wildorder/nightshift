/**
 * The human verdict and completion sections of the run report (P20, D-04 and
 * D-05) over the in-memory stores: `gatherReport` reads the verdict, the
 * program's coverage and the completion histories the run belongs to, and
 * `renderReport` states a down-rated run's verdict without naming a cause.
 */
import type {
  CommitSha,
  CompletionCheckpoint,
  CompletionHistory,
  Run,
  RunFeedback,
  UserPrincipal,
} from "@nightshift/contracts";
import {
  buildCompletionHistory,
  buildRunFeedback,
  createFixtures,
  type Fixtures,
  gatherReport,
  makeProgramContract,
  makeRootNode,
  makeRun,
  renderReport,
} from "@nightshift/core";
import { createInMemoryStores } from "@nightshift/persistence/memory";
import { describe, expect, it } from "vitest";

const COMMIT = "3333333333333333333333333333333333333333" as CommitSha;
const ORG = "org_01HF7YAT00GGGGGGGGGGGGGGGG";
const ann: UserPrincipal = { kind: "user", userId: "ann", orgId: ORG } as UserPrincipal;
const bob: UserPrincipal = { kind: "user", userId: "bob", orgId: ORG } as UserPrincipal;
const t = (hhmm: string): string => `2026-09-15T${hhmm}:00.000Z`;

const seed = async () => {
  const stores = createInMemoryStores();
  const a = createFixtures();
  const b = createFixtures();
  const projectId = a.scope.projectId;
  await stores.programContracts.put(makeProgramContract(a));
  await stores.programContracts.put(makeProgramContract(b, { projectId }));

  const put = async (
    f: Fixtures,
    scope: Fixtures["scope"],
    status: Run["status"],
    startedAt: string,
    endedAt?: string,
  ): Promise<Run> => {
    const rootNodeId = scope.runId === f.scope.runId ? f.rootNodeId : f.ids.next("node");
    const run = makeRun(f, {
      ...scope,
      status,
      rootNodeId,
      startedAt,
      ...(endedAt === undefined ? {} : { endedAt }),
      ...(status === "failed" ? { outcomeReason: "verification failed" } : {}),
    });
    await stores.runs.put(run);
    await stores.executionNodes.put(
      makeRootNode(f, { ...scope, executionNodeId: rootNodeId, commitSha: COMMIT }),
    );
    return run;
  };
  const next = (f: Fixtures) => ({ ...f.scope, runId: f.ids.next("run") });

  const run1 = await put(a, a.scope, "failed", t("10:00"), t("10:10"));
  const run2 = await put(a, next(a), "succeeded", t("10:20"), t("10:30"));
  const run3 = await put(a, next(a), "succeeded", t("10:32"), t("10:33"));
  const run4 = await put(a, next(a), "running", t("10:50"));
  const runB = await put(b, { ...b.scope, projectId }, "succeeded", t("10:40"), t("10:50"));

  const vote = async (
    run: Run,
    verdict: RunFeedback["verdict"],
    actor: UserPrincipal,
    at: string,
    resultCommit?: CommitSha,
  ): Promise<RunFeedback> => {
    const feedback = buildRunFeedback({
      scope: run,
      verdict,
      actor,
      at: at as never,
      ...(resultCommit === undefined ? {} : { resultCommit }),
    });
    await stores.feedback.put(feedback);
    return feedback;
  };
  await vote(run1, "did_not_work", bob, t("10:15"));
  const verdict2 = await vote(run2, "worked", ann, t("10:35"), COMMIT);
  await vote(runB, "worked", ann, t("10:55"));

  const refOf = (run: Run, role: "anchor" | "contributing" | "correction") => ({
    programId: run.programId,
    runId: run.runId,
    role,
  });
  const built = buildCompletionHistory({
    scope: run1,
    completionHistoryId: a.ids.next("comp"),
    title: "Orders",
    members: [refOf(run1, "anchor"), refOf(run2, "contributing"), refOf(runB, "correction")],
    actor: ann,
    at: t("10:56") as never,
  });
  const checkpoint: CompletionCheckpoint = {
    name: "first",
    programId: run2.programId,
    runId: run2.runId,
    feedbackVersion: verdict2.version,
    verdictRecordedAt: verdict2.recordedAt,
    members: [refOf(run1, "anchor"), refOf(run2, "contributing")],
    membershipVersion: 1,
    recordedBy: ann,
    recordedAt: t("10:36") as never,
    measured: {
      measuredTo: verdict2.recordedAt,
      readableMembers: 2,
      earliestStart: t("10:00") as never,
      leadTimeSeconds: 2100,
      runCompletionSeconds: 1800,
      activeSeconds: 1200,
      recordedAt: t("10:36") as never,
    },
  };
  const history = { ...built, checkpoints: [checkpoint] } as CompletionHistory;
  await stores.completionHistories.put(history);
  return { stores, run1, run2, run3, run4, runB, history };
};

describe("gatherReport: the human verdict (D-04)", () => {
  it("shows the run's verdict, who gave it, the commit and the calendar delay", async () => {
    const { stores, run2 } = await seed();
    const report = await gatherReport(stores, run2);
    expect(report.feedback).toEqual({
      verdict: "worked",
      recordedAt: t("10:35"),
      by: "ann",
      resultCommit: COMMIT,
      ratingDelaySeconds: 300,
      revisions: 1,
    });
  });

  it("counts the program's ended runs once: three eligible, two rated, one each way; a running run is outside", async () => {
    const { stores, run1, run4 } = await seed();
    const report = await gatherReport(stores, run1);
    expect(report.feedbackCoverage).toEqual({
      eligible: 3,
      rated: 2,
      positive: 1,
      negative: 1,
      positiveShare: 0.5,
      unrated: 1,
    });
    // The running run is unrated, and says so rather than counting against the share.
    expect((await gatherReport(stores, run4)).feedback).toEqual({
      verdict: "not_rated",
      revisions: 0,
    });
  });

  it("reports an unrated run as not rated, not as a negative vote", async () => {
    const { stores, run3 } = await seed();
    const report = await gatherReport(stores, run3);
    expect(report.feedback).toEqual({ verdict: "not_rated", revisions: 0 });
    expect(report.feedbackCoverage.negative).toBe(1);
  });
});

describe("gatherReport: the completion section (D-05)", () => {
  it("lists each member once and reads the checkpoint's figures apart from the current ones", async () => {
    const { stores, run1, run2, runB, history } = await seed();
    const report = await gatherReport(stores, run2);
    expect(report.completions).toHaveLength(1);
    const completion = report.completions[0];
    expect(completion?.completionHistoryId).toBe(history.completionHistoryId);
    expect(completion?.members).toEqual([
      expect.objectContaining({
        runId: run1.runId,
        role: "anchor",
        status: "failed",
        verdict: "did_not_work",
      }),
      expect.objectContaining({
        runId: run2.runId,
        role: "contributing",
        status: "succeeded",
        verdict: "worked",
      }),
      expect.objectContaining({
        runId: runB.runId,
        role: "correction",
        status: "succeeded",
        verdict: "worked",
      }),
    ]);
    expect(completion?.coverage).toEqual({
      eligible: 3,
      rated: 3,
      positive: 2,
      negative: 1,
      positiveShare: 2 / 3,
      unrated: 0,
    });
    expect(completion?.checkpoints).toHaveLength(1);
    expect(completion?.checkpoints[0]).toMatchObject({
      name: "first",
      membershipVersion: 1,
      leadTimeSeconds: 2100,
      runCompletionSeconds: 1800,
      activeSeconds: 1200,
      acceptedRun: { programId: run2.programId, runId: run2.runId },
    });
    expect(completion?.current).toMatchObject({
      leadTimeSeconds: 2100,
      runCompletionSeconds: 1800,
      activeSeconds: 1800,
      membershipVersion: 1,
    });
    expect(completion?.laterFixes.map((m) => m.runId)).toEqual([runB.runId]);
    // The same report from the other member's side names the same history once.
    expect((await gatherReport(stores, run1)).completions).toHaveLength(1);
  });

  it("keeps the checkpoint's figures when the accepted run's verdict is cleared", async () => {
    const { stores, run2 } = await seed();
    const stored = await stores.feedback.get(run2);
    await stores.feedback.put(
      buildRunFeedback({
        ...(stored === undefined ? {} : { stored }),
        scope: run2,
        verdict: null,
        actor: ann,
        at: t("11:00") as never,
      }),
    );
    const completion = (await gatherReport(stores, run2)).completions[0];
    expect(completion?.checkpoints[0]?.leadTimeSeconds).toBe(2100);
    // The other member's worked verdict is the only one left.
    expect(completion?.current.leadTimeSeconds).toBe(3300);
  });
});

describe("renderReport: a down-rated run", () => {
  it("states the verdict without a finding, an examiner or a cause", async () => {
    const { stores, run1 } = await seed();
    const text = renderReport(await gatherReport(stores, run1));
    const start = text.indexOf("## Human verdict");
    expect(start).toBeGreaterThanOrEqual(0);
    const rest = text.slice(start + 1);
    const end = rest.indexOf("\n## ");
    const section = end < 0 ? text.slice(start) : text.slice(start, start + 1 + end);
    expect(section).toContain("- Verdict: **did not work**");
    expect(section).toContain("- By: bob");
    expect(section).toContain(
      "- Rating delay: 5 min 0 s after the run ended (calendar time, not work time)",
    );
    expect(section).toContain(
      "- This program: 2 of 3 ended run(s) rated; 1 worked, 1 did not; positive share among rated 50%; 1 unrated.",
    );
    expect(section).not.toMatch(/\bF-\d+|finding|examiner|cause/i);
  });
});
