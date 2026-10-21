/**
 * `nightshift rate` and `nightshift completion` (P20, D-04 and D-05), through the
 * real CLI against the real handler over in-memory stores: one verdict per run
 * that revises rather than multiplies, a refusal on an unfinished run, a lost
 * race that stores exactly one verdict, and a completion history that stays
 * inside its project and keeps its checkpoints after a vote is cleared.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "@nightshift/cli";
import type {
  CommitSha,
  CompletionHistory,
  Decision,
  ProgramContract,
  Run,
} from "@nightshift/contracts";
import {
  buildRunFeedback,
  createFixtures,
  type Fixtures,
  makeCheckpoint,
  makeNode,
  makeProgramContract,
  makeProject,
  makeRootNode,
  makeRun,
  StaleWriteError,
} from "@nightshift/core";
import {
  createFetchTransport,
  createHttpStores,
  staticTokenProvider,
} from "@nightshift/persistence/http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Operator, SUBJECT, signIn } from "./operator.js";

let op: Operator;
let repo: string;

beforeEach(async () => {
  op = await signIn();
  repo = await mkdtemp(join(tmpdir(), "nightshift-feedback-"));
});

afterEach(async () => {
  await op.cleanup();
  await rm(repo, { recursive: true, force: true });
});

const COMMIT = "2222222222222222222222222222222222222222" as CommitSha;
const RUN1_START = "2026-09-15T11:00:00.000Z";

const cli = async (...argv: string[]): Promise<number> => {
  op.out.length = 0;
  op.err.length = 0;
  return runCli(op.environment, [...argv, "--repo", repo]);
};

const said = (): string => op.out.join("\n");

/** The CLI's own spelling of a duration, for the figures it prints. */
const spelled = (total: number): string => {
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  return hours > 0
    ? `${hours}h ${minutes}m`
    : minutes > 0
      ? `${minutes}m ${total % 60}s`
      : `${total}s`;
};

const seed = async () => {
  const stores = createHttpStores({
    transport: createFetchTransport({
      endpoint: op.plane.url,
      tokens: staticTokenProvider("unused"),
    }),
  });
  const a = createFixtures();
  const b = createFixtures();
  const other = createFixtures();
  const projectId = a.scope.projectId;
  await stores.projects.put(makeProject(a, { orgId: op.orgId, name: "feedback" }));
  await stores.projects.put(makeProject(other, { orgId: op.orgId, name: "elsewhere" }));

  const putRun = async (
    f: Fixtures,
    scope: Fixtures["scope"],
    overrides: Partial<Record<keyof Run, unknown>>,
    rootOverrides: Record<string, unknown> = {},
  ) => {
    const run = makeRun(f, { ...scope, ...overrides });
    await stores.runs.put(run);
    await stores.executionNodes.put(makeRootNode(f, { ...scope, ...rootOverrides }));
    return run;
  };

  const progA = makeProgramContract(a, { repository: repoOf() });
  await stores.programContracts.put(progA);

  // Program A: run1 failed, run2 succeeded with a commit, run4 still running.
  const run1 = await putRun(a, a.scope, {
    status: "failed",
    startedAt: RUN1_START,
    endedAt: "2026-09-15T11:30:00.000Z",
    outcomeReason: "verification failed twice",
  });
  const root1 = a.rootNodeId;
  const checkpoint = makeCheckpoint(a, root1, { ref: "refs/nightshift/checkpoints/before-choice" });
  await stores.checkpoints.put(checkpoint);
  const node = makeNode(a, root1);
  await stores.executionNodes.put(node);
  const decision: Decision = {
    schemaVersion: 1,
    ...a.scope,
    decisionId: a.ids.next("dec"),
    executionNodeId: node.executionNodeId,
    agentId: null,
    context: "How to store orders",
    alternatives: [{ summary: "a table per region", rejectedBecause: "more to migrate" }],
    choice: "one table",
    rationale: "simplest",
    reversibility: "reversible",
    checkpointBefore: checkpoint.checkpointId,
    affectedNodes: [],
    authority: "agent",
    supersedesDecisionId: null,
    createdAt: "2026-09-15T11:10:00.000Z",
  };
  await stores.decisions.put(decision);
  const reversal: Decision = {
    ...decision,
    decisionId: a.ids.next("dec"),
    choice: "a table per region",
    rationale: "regions diverge",
    authority: "human",
    supersedesDecisionId: decision.decisionId,
    createdAt: "2026-09-15T11:40:00.000Z",
  };
  await stores.decisions.put(reversal);

  const scope2 = { ...a.scope, runId: a.ids.next("run") };
  const root2Id = a.ids.next("node");
  const run2 = makeRun(a, {
    ...scope2,
    status: "succeeded",
    rootNodeId: root2Id,
    startedAt: "2026-09-15T11:45:00.000Z",
    endedAt: "2026-09-15T11:50:00.000Z",
  });
  await stores.runs.put(run2);
  await stores.executionNodes.put(
    makeRootNode(a, { ...scope2, executionNodeId: root2Id, commitSha: COMMIT }),
  );

  const scope4 = { ...a.scope, runId: a.ids.next("run") };
  const root4Id = a.ids.next("node");
  const run4 = makeRun(a, {
    ...scope4,
    status: "running",
    rootNodeId: root4Id,
    startedAt: "2026-09-15T11:55:00.000Z",
  });
  await stores.runs.put(run4);
  await stores.executionNodes.put(makeRootNode(a, { ...scope4, executionNodeId: root4Id }));

  // Program B corrects the decision of A/run1; run3 is its finished run.
  const progB = makeProgramContract(b, {
    projectId,
    repository: repoOf(),
    corrects: [
      {
        programId: a.scope.programId,
        runId: a.scope.runId,
        decisionId: decision.decisionId,
        reversedBy: reversal.decisionId,
      },
    ],
  });
  await stores.programContracts.put(progB);
  const scope3 = { projectId, programId: b.scope.programId, runId: b.scope.runId };
  const run3 = await putRun(b, scope3, {
    status: "succeeded",
    startedAt: "2026-09-15T11:42:00.000Z",
    endedAt: "2026-09-15T11:44:00.000Z",
  });

  // A second project with its own finished run.
  const progC = makeProgramContract(other, { repository: repoOf() });
  await stores.programContracts.put(progC);
  const runC = await putRun(other, other.scope, {
    status: "succeeded",
    startedAt: "2026-09-15T11:00:00.000Z",
    endedAt: "2026-09-15T11:05:00.000Z",
  });

  for (const [name, program] of [
    ["alpha", progA],
    ["beta", progB],
  ] as const) {
    await mkdir(join(repo, "docs", "programs", name), { recursive: true });
    await writeFile(
      join(repo, "docs", "programs", name, "contract.json"),
      JSON.stringify(program satisfies ProgramContract),
    );
    await writeFile(join(repo, "docs", "programs", name, "plan.md"), `# ${name}\n`);
  }
  return { stores, a, b, other, run1, run2, run3, run4, runC };
};

const repoOf = () => ({
  url: "https://example.invalid/repo.git",
  baseBranch: "main",
  programBranch: "program/fixture",
});

describe("nightshift rate (D-04)", () => {
  it("stores a verdict with its attribution, ignores a repeat, revises and clears it, and refuses an unfinished run", async () => {
    const { stores, run1, run2, run4 } = await seed();
    const scope2 = { projectId: run2.projectId, programId: run2.programId, runId: run2.runId };

    expect(await cli("rate", "alpha", "up", "--run", run2.runId), op.err.join("\n")).toBe(0);
    expect(said()).toBe(`rated run ${run2.runId} as worked (revision 1)`);
    const first = await stores.feedback.get(scope2);
    expect(first).toMatchObject({ version: 1, verdict: "worked", resultCommit: COMMIT });
    expect(first?.actor.userId).toBe(SUBJECT);
    expect(first?.revisions).toHaveLength(1);

    // The same verdict again is not a second vote.
    expect(await cli("rate", "alpha", "up", "--run", run2.runId)).toBe(0);
    expect(said()).toBe(`run ${run2.runId} is already rated as worked (revision 1)`);
    expect(await stores.feedback.get(scope2)).toEqual(first);

    expect(await cli("rate", "alpha", "down", "--run", run2.runId)).toBe(0);
    expect(said()).toBe(`rated run ${run2.runId} as did not work (revision 2)`);
    expect(await cli("rate", "alpha", "clear", "--run", run2.runId)).toBe(0);
    expect(said()).toBe(`cleared the verdict on run ${run2.runId}`);
    const cleared = await stores.feedback.get(scope2);
    expect(cleared?.verdict).toBeNull();
    expect(cleared?.version).toBe(3);
    expect(cleared?.revisions.map((r) => [r.version, r.verdict])).toEqual([
      [1, "worked"],
      [2, "did_not_work"],
      [3, null],
    ]);

    // An unrated run stays unrated: clearing nothing stores nothing.
    expect(await cli("rate", "alpha", "clear", "--run", run1.runId)).toBe(0);
    expect(said()).toBe(`run ${run1.runId} is not rated`);
    expect(
      await stores.feedback.get({
        projectId: run1.projectId,
        programId: run1.programId,
        runId: run1.runId,
      }),
    ).toBeUndefined();

    // A running run cannot be rated.
    expect(await cli("rate", "alpha", "up", "--run", run4.runId)).toBe(1);
    expect(op.err.join("\n")).toBe(
      `run ${run4.runId} is not finished (running); a verdict can be given once it has ended`,
    );
    expect(
      await stores.feedback.get({
        projectId: run4.projectId,
        programId: run4.programId,
        runId: run4.runId,
      }),
    ).toBeUndefined();
  });

  it("leaves exactly one verdict when two writes name the same version", async () => {
    const { stores, runC } = await seed();
    const scope = { projectId: runC.projectId, programId: runC.programId, runId: runC.runId };
    const actor = { kind: "user", userId: SUBJECT as never, orgId: op.orgId } as const;
    const at = "2026-09-15T12:00:00.000Z";
    const stored = buildRunFeedback({ scope, verdict: "worked", actor, at });
    await stores.feedback.put(stored);

    const settled = await Promise.allSettled([
      stores.feedback.put(buildRunFeedback({ stored, scope, verdict: "did_not_work", actor, at })),
      stores.feedback.put(buildRunFeedback({ stored, scope, verdict: null, actor, at })),
    ]);
    const rejected = settled.filter((s) => s.status === "rejected");
    expect(settled.filter((s) => s.status === "fulfilled")).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(StaleWriteError);

    const now = await stores.feedback.get(scope);
    expect(now?.version).toBe(2);
    expect(now?.revisions).toHaveLength(2);
    expect(["did_not_work", null]).toContain(now?.verdict);
  });
});

describe("nightshift completion (D-05)", () => {
  it("groups runs of one project by name, snapshots a checkpoint, and keeps it after the vote is cleared", async () => {
    const { stores, a, b, run1, run2, run3, run4, runC } = await seed();
    const projectId = a.scope.projectId;
    const at = (run: Run) => `${run.programId}/${run.runId}`;

    expect(
      await cli("completion", "create", "alpha", "--title", "Orders", "--run", run1.runId),
      op.err.join("\n"),
    ).toBe(0);
    const history = (await stores.completionHistories.listByProject(projectId)).items[0];
    const id = (history as CompletionHistory).completionHistoryId;
    expect(said()).toBe(
      `created completion history ${id} "Orders" anchored on run ${run1.runId} (version 1)`,
    );

    // A correction program's run is suggested; program identity alone is not a reason.
    expect(await cli("completion", "suggest", "alpha", "--history", id)).toBe(0);
    expect(op.out).toEqual([
      `suggest ${at(run3)} as correction: corrects_member — program ${b.scope.programId} corrects decision ${progADecision(await stores.decisions.listByRun(a.scope))} in ${at(run1)}`,
    ]);
    expect(said()).not.toContain(run2.runId);
    expect(said()).not.toContain(run4.runId);

    expect(
      await cli(
        "completion",
        "add",
        "alpha",
        "--history",
        id,
        "--member",
        at(run3),
        "--role",
        "correction",
      ),
      op.err.join("\n"),
    ).toBe(0);
    expect(said()).toBe(`added ${at(run3)} to completion history ${id} as correction (version 2)`);
    expect(
      await cli("completion", "add", "alpha", "--history", id, "--member", at(run2)),
      op.err.join("\n"),
    ).toBe(0);
    expect(said()).toBe(
      `added ${at(run2)} to completion history ${id} as contributing (version 3)`,
    );

    // A down-rated run followed by an up-rated correction.
    expect(await cli("rate", "alpha", "down", "--run", run1.runId)).toBe(0);
    expect(await cli("rate", "beta", "up")).toBe(0);
    const verdict3 = await stores.feedback.get({
      projectId,
      programId: run3.programId,
      runId: run3.runId,
    });
    expect(verdict3?.verdict).toBe("worked");

    expect(
      await cli(
        "completion",
        "checkpoint",
        "alpha",
        "--history",
        id,
        "--name",
        "first",
        "--member",
        at(run3),
      ),
      op.err.join("\n"),
    ).toBe(0);
    expect(said()).toBe(
      `recorded checkpoint \`first\` at ${at(run3)} on completion history ${id} (version 4)`,
    );

    // A down-rated run cannot be a checkpoint, and nothing changes.
    expect(
      await cli(
        "completion",
        "checkpoint",
        "alpha",
        "--history",
        id,
        "--name",
        "second",
        "--member",
        at(run1),
      ),
    ).toBe(1);
    expect(op.err.length).toBeGreaterThan(0);
    const afterRefusal = (await stores.completionHistories.listByProject(projectId)).items[0];
    expect(afterRefusal?.version).toBe(4);
    expect(afterRefusal?.checkpoints.map((c) => c.name)).toEqual(["first"]);

    // Another project's run is refused, and nothing changes.
    expect(await cli("completion", "add", "alpha", "--history", id, "--member", at(runC))).toBe(1);
    const afterForeign = (await stores.completionHistories.listByProject(projectId)).items[0];
    expect(afterForeign).toEqual(afterRefusal);

    const leadSeconds =
      (Date.parse(verdict3?.recordedAt as string) - Date.parse(RUN1_START)) / 1000;
    expect(Number.isInteger(leadSeconds)).toBe(true);
    const checkpointAt = afterRefusal?.checkpoints[0]?.recordedAt as string;

    expect(await cli("completion", "show", "alpha", "--history", id), op.err.join("\n")).toBe(0);
    const shown = [...op.out];
    expect(shown[0]).toBe(`completion history ${id} "Orders" (version 4)`);
    expect(shown.slice(1, 4)).toEqual([
      `member ${at(run1)} anchor failed did_not_work`,
      `member ${at(run3)} correction succeeded worked`,
      `member ${at(run2)} contributing succeeded not_rated`,
    ]);
    expect(shown[4]).toBe("rated 2 of 3 finished runs, positive share 50%");
    const checkpointLine = shown[6] as string;
    expect(shown[5]).toMatch(/^now: lead time /);
    expect(shown[5]).toContain(`lead time ${spelled(leadSeconds)}, run completion `);
    expect(checkpointLine).toContain(
      `checkpoint \`first\` (${checkpointAt}): lead time ${spelled(leadSeconds)}`,
    );
    expect(shown).toHaveLength(7);

    // Clearing the accepted run's vote leaves the checkpoint's figures where they were.
    expect(await cli("rate", "beta", "clear")).toBe(0);
    expect(await cli("completion", "show", "alpha", "--history", id)).toBe(0);
    const later = [...op.out];
    expect(later[4]).toBe("rated 1 of 3 finished runs, positive share 0%");
    expect(later[5]).toMatch(/^now: lead time none, run completion none, /);
    expect(later[6]).toBe(checkpointLine);
    const finalHistory = (await stores.completionHistories.listByProject(projectId)).items[0];
    expect(finalHistory?.checkpoints).toEqual(afterRefusal?.checkpoints);
  });
});

const progADecision = (decisions: { items: readonly Decision[] }): string => {
  const original = decisions.items.find((d) => d.supersedesDecisionId === null);
  return (original as Decision).decisionId;
};
