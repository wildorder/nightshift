import type {
  CompletionHistory,
  CompletionMemberRef,
  IsoTimestamp,
  ProgramContract,
  Run,
  RunFeedback,
  UserPrincipal,
} from "@nightshift/contracts";
import { describe, expect, it } from "vitest";
import { CompletionMembershipError, StaleWriteError } from "../errors.js";
import { createFixtures, makeProgramContract, makeRun } from "../testing/factories.js";
import {
  buildCompletionHistory,
  reconcileCompletionWrite,
  suggestCompletionMembers,
} from "./completion.js";
import { buildRunFeedback } from "./feedback.js";

const f = createFixtures();
const at = (n: number): IsoTimestamp =>
  new Date(Date.UTC(2026, 9, 1, 0, 0, n)).toISOString() as IsoTimestamp;
const ann = {
  kind: "user",
  userId: "ann",
  orgId: "org_01HF7YAT00GGGGGGGGGGGGGGGG",
} as UserPrincipal;
const bob = { ...ann, userId: "bob" } as UserPrincipal;

const otherProgram = f.ids.next("prog");
const anchorRun = makeRun(f, { status: "failed", endedAt: at(10), outcomeReason: "x" });
const fixRun = makeRun(f, {
  programId: otherProgram,
  runId: f.ids.next("run"),
  status: "succeeded",
  endedAt: at(30),
});
const keyOf = (r: { programId: string; runId: string }) => `${r.programId}/${r.runId}`;
const runs = new Map<string, Run>([
  [keyOf(anchorRun), anchorRun],
  [keyOf(fixRun), fixRun],
]);
const vote = (run: Run, verdict: "worked" | "did_not_work", recordedAt = at(40)): RunFeedback =>
  buildRunFeedback({ scope: run, verdict, actor: ann, at: recordedAt });
const worked = (run: Run, recordedAt = at(40)): RunFeedback => vote(run, "worked", recordedAt);
const anchorRef: CompletionMemberRef = { ...f.scope, role: "anchor" } as CompletionMemberRef;
const fixRef: CompletionMemberRef = {
  programId: fixRun.programId,
  runId: fixRun.runId,
  role: "correction",
};
const build = (over: Partial<Parameters<typeof buildCompletionHistory>[0]> = {}) =>
  buildCompletionHistory({
    scope: f.scope,
    completionHistoryId: f.ids.next("comp"),
    title: "Outcome",
    members: [anchorRef],
    actor: ann,
    at: at(1),
    ...over,
  });
const reconcile = (
  proposed: CompletionHistory,
  over: Partial<Parameters<typeof reconcileCompletionWrite>[0]> = {},
) =>
  reconcileCompletionWrite({
    proposed,
    actor: ann,
    at: at(50),
    memberRuns: runs,
    feedbackOf: new Map(),
    ...over,
  });
const reason = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    if (error instanceof CompletionMembershipError) return error.reason;
    throw error;
  }
  return undefined;
};

describe("buildCompletionHistory", () => {
  it("builds version 1 and then appends revisions with the members", () => {
    const one = build();
    expect(one.version).toBe(1);
    expect(one.revisions).toEqual([
      { version: 1, actor: ann, recordedAt: at(1), members: [anchorRef] },
    ]);
    const two = build({
      stored: one,
      completionHistoryId: one.completionHistoryId,
      members: [anchorRef, fixRef],
      at: at(2),
    });
    expect(two.version).toBe(2);
    expect(two.createdAt).toBe(at(1));
    expect(two.updatedAt).toBe(at(2));
    expect(two.revisions.map((r) => r.members.length)).toEqual([1, 2]);
  });

  it("carries placeholders for a new checkpoint", () => {
    const h = build({
      checkpoint: { name: "first", programId: f.scope.programId, runId: f.scope.runId },
    });
    expect(h.checkpoints).toEqual([
      {
        name: "first",
        programId: f.scope.programId,
        runId: f.scope.runId,
        feedbackVersion: 1,
        verdictRecordedAt: at(1),
        members: [anchorRef],
        membershipVersion: 1,
        recordedBy: ann,
        recordedAt: at(1),
      },
    ]);
  });
});

describe("reconcileCompletionWrite", () => {
  it("stores a first history with the server's attribution", () => {
    const result = reconcile(build({ actor: bob, at: at(3) }));
    expect(result.outcome).toBe("stored");
    expect(result.history.revisions[0]).toMatchObject({ actor: ann, recordedAt: at(50) });
    expect(result.history.createdAt).toBe(at(50));
  });

  it("refuses an unknown member run", () => {
    const ghost: CompletionMemberRef = {
      programId: otherProgram,
      runId: f.ids.next("run"),
      role: "contributing",
    };
    const proposed = build({ members: [anchorRef, ghost] });
    expect(reason(() => reconcile(proposed))).toBe("unknown_run");
  });

  it("refuses an anchor that is not the record's run", () => {
    const wrong = build({ members: [{ ...fixRef, role: "anchor" }] });
    expect(reason(() => reconcile(wrong))).toBe("anchor_mismatch");
    const none = build({ members: [{ ...anchorRef, role: "contributing" }] });
    expect(reason(() => reconcile(none))).toBe("anchor_mismatch");
  });

  it("refuses a duplicate member", () => {
    const dup = build({ members: [anchorRef, fixRef, fixRef] });
    expect(reason(() => reconcile(dup))).toBe("duplicate");
  });

  it("refuses a checkpoint on a run that is not currently worked", () => {
    const cp = { name: "c", programId: f.scope.programId, runId: f.scope.runId };
    expect(reason(() => reconcile(build({ checkpoint: cp })))).toBe("checkpoint_not_positive");
    const down = vote(anchorRun, "did_not_work", at(2));
    expect(
      reason(() =>
        reconcile(build({ checkpoint: cp }), { feedbackOf: new Map([[keyOf(down), down]]) }),
      ),
    ).toBe("checkpoint_not_positive");
  });

  it("refuses a checkpoint on a non-member", () => {
    const cp = { name: "c", programId: fixRun.programId, runId: fixRun.runId };
    const fb = worked(fixRun);
    expect(
      reason(() =>
        reconcile(build({ checkpoint: cp }), { feedbackOf: new Map([[keyOf(fixRun), fb]]) }),
      ),
    ).toBe("checkpoint_not_member");
  });

  it("snapshots a checkpoint from the server's feedback and refuses to alter it", () => {
    const fb = buildRunFeedback({
      stored: buildRunFeedback({
        stored: worked(fixRun, at(20)),
        scope: fixRun,
        verdict: "did_not_work",
        actor: ann,
        at: at(30),
      }),
      scope: fixRun,
      verdict: "worked",
      actor: ann,
      at: at(40),
    });
    const feedbackOf = new Map([[keyOf(fixRun), fb]]);
    const cp = { name: "done", programId: fixRun.programId, runId: fixRun.runId };
    const stored = reconcile(build({ members: [anchorRef, fixRef], checkpoint: cp }), {
      feedbackOf,
    }).history;
    expect(stored.checkpoints).toEqual([
      {
        name: "done",
        programId: fixRun.programId,
        runId: fixRun.runId,
        feedbackVersion: 3,
        verdictRecordedAt: at(40),
        members: [anchorRef, fixRef],
        membershipVersion: 1,
        recordedBy: ann,
        recordedAt: at(50),
      },
    ]);
    const next = (over: Partial<CompletionHistory>): CompletionHistory => ({
      ...build({
        stored,
        completionHistoryId: stored.completionHistoryId,
        members: [anchorRef, fixRef],
        at: at(60),
      }),
      ...over,
    });
    const altered = next({
      checkpoints: [{ ...stored.checkpoints[0], feedbackVersion: 9 } as never],
    });
    expect(reason(() => reconcile(altered, { stored, feedbackOf }))).toBe("checkpoint_immutable");
    const removed = next({ checkpoints: [] });
    expect(reason(() => reconcile(removed, { stored, feedbackOf }))).toBe("checkpoint_immutable");
  });

  it("returns unchanged when nothing differs, and stores a title change", () => {
    const stored = reconcile(build()).history;
    const same = build({ stored, completionHistoryId: stored.completionHistoryId, at: at(60) });
    expect(reconcile(same, { stored })).toEqual({ outcome: "unchanged", history: stored });
    const retitled = build({
      stored,
      completionHistoryId: stored.completionHistoryId,
      title: "New",
      at: at(60),
    });
    const result = reconcile(retitled, { stored });
    expect(result.outcome).toBe("stored");
    expect(result.history.version).toBe(2);
    expect(result.history.title).toBe("New");
  });

  it("replays the writer's own retry and refuses a stale write", () => {
    const stored = reconcile(build()).history;
    const retry = build({ at: at(2) });
    expect(reconcile(retry, { stored })).toEqual({ outcome: "replayed", history: stored });
    expect(() => reconcile(retry, { stored, actor: bob })).toThrow(
      new StaleWriteError("completion history", 0, 1),
    );
    const changed = build({ members: [anchorRef, fixRef] });
    expect(() => reconcile(changed, { stored })).toThrow(StaleWriteError);
    const skipped = {
      ...build({ stored, completionHistoryId: stored.completionHistoryId }),
      version: 4,
    };
    expect(() => reconcile(skipped, { stored })).toThrow(
      new StaleWriteError("completion history", 3, 1),
    );
    expect(() => reconcile({ ...build(), version: 2 })).toThrow(
      new StaleWriteError("completion history", 1, 0),
    );
  });
});

describe("suggestCompletionMembers", () => {
  const programOf = (programId: string, over: Record<string, unknown> = {}): ProgramContract =>
    makeProgramContract(f, { programId, ...over } as never);
  const target = (run: Run) => ({
    programId: run.programId,
    runId: run.runId,
    decisionId: "dec_01HF7YAT00GGGGGGGGGGGGGGGG",
    reversedBy: "dec_01HF7YAT00GGGGGGGGGGGGGGGH",
  });
  const history = reconcile(build()).history;

  it("suggests the run that built a carried strand", () => {
    const earlier = makeRun(f, { runId: f.ids.next("run"), status: "failed", endedAt: at(5) });
    const carrying = {
      ...anchorRun,
      carriedStrands: [{ strandId: "S-01", fromRunId: earlier.runId, landed: [] }],
    } as Run;
    const out = suggestCompletionMembers({
      history,
      anchorRun: carrying,
      programs: [],
      runs: [carrying, earlier],
    });
    expect(out).toEqual([
      {
        programId: earlier.programId,
        runId: earlier.runId,
        role: "contributing",
        reason: "carried_strand",
        detail: `built strand S-01, which ${keyOf(carrying)} carried`,
      },
    ]);
  });

  it("suggests every run of a program that corrects a member, and what a member corrects", () => {
    const second = makeRun(f, { programId: fixRun.programId, runId: f.ids.next("run") });
    const corrector = programOf(fixRun.programId, { corrects: [target(anchorRun)] });
    const out = suggestCompletionMembers({
      history,
      anchorRun,
      programs: [corrector],
      runs: [anchorRun, fixRun, second],
    });
    expect(out.map((s) => [s.runId, s.role, s.reason])).toEqual([
      [fixRun.runId, "correction", "corrects_member"],
      [second.runId, "correction", "corrects_member"],
    ]);

    const withFix = { ...history, members: [anchorRef, fixRef] } as CompletionHistory;
    const back = suggestCompletionMembers({
      history: withFix,
      anchorRun,
      programs: [corrector],
      runs: [anchorRun, fixRun, second],
    });
    expect(back.map((s) => [s.runId, s.role, s.reason])).toEqual([
      [second.runId, "correction", "corrects_member"],
    ]);
    const third = makeRun(f, { programId: otherProgram, runId: f.ids.next("run") });
    const historyOfCorrector = { ...history, members: [anchorRef, fixRef] } as CompletionHistory;
    const reverse = suggestCompletionMembers({
      history: historyOfCorrector,
      anchorRun,
      programs: [programOf(f.scope.programId, { corrects: [target(third)] })],
      runs: [anchorRun, fixRun, third],
    });
    expect(reverse).toEqual([
      expect.objectContaining({
        runId: third.runId,
        role: "contributing",
        reason: "corrected_by_member",
      }),
    ]);
  });

  it("never suggests a run for sharing a program with a member", () => {
    const sibling = makeRun(f, { runId: f.ids.next("run"), status: "succeeded", endedAt: at(9) });
    expect(
      suggestCompletionMembers({
        history,
        anchorRun,
        programs: [programOf(f.scope.programId)],
        runs: [anchorRun, sibling],
      }),
    ).toEqual([]);
  });
});
