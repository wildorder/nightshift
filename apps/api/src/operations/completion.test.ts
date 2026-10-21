/**
 * A person's completion history (P20, D-05), through the handler over the
 * in-memory stores: membership stays inside the path's project, checkpoints are
 * snapshotted by the server from the verdicts it holds, and a stored checkpoint
 * never changes.
 */
import type { CompletionHistory, ExecutionRole, RunId } from "@nightshift/contracts";
import {
  buildCompletionHistory,
  buildRunFeedback,
  createFixedClock,
  createFixtures,
  makeAgent,
  makeCompletionHistory,
  makeMembership,
  makeProgramContract,
  makeProject,
  makeRootNode,
  makeRun,
  nextUserId,
} from "@nightshift/core";
import { createInMemoryStores } from "@nightshift/persistence/memory";
import { describe, expect, it } from "vitest";
import type { RequestPrincipal } from "../auth/principal.js";
import { handleRequest } from "../handler.js";
import type { ApiResponse } from "../http.js";

const NOW = "2026-10-01T10:00:00.000Z";
const EARLIER = "2026-10-01T09:00:00.000Z";

const errorCode = (response: ApiResponse): string =>
  (response.body as { error: { code: string } }).error.code;

const setup = async () => {
  const stores = createInMemoryStores();
  const f = createFixtures();
  const orgId = f.ids.next("org");
  const user = nextUserId(f);
  const stranger = nextUserId(f);
  await stores.memberships.put(makeMembership(user, orgId));
  await stores.memberships.put(makeMembership(stranger, f.ids.next("org")));
  await stores.projects.put(makeProject(f, { orgId }));
  await stores.programContracts.put(makeProgramContract(f));
  const root = makeRootNode(f);
  await stores.executionNodes.put(root);
  await stores.runs.put(
    makeRun(f, { status: "succeeded", endedAt: EARLIER, rootNodeId: root.executionNodeId }),
  );

  // A second program of the same project, with a finished run.
  const otherProgram = f.ids.next("prog");
  await stores.programContracts.put(makeProgramContract(f, { programId: otherProgram }));
  const sibling = makeRun(f, {
    programId: otherProgram,
    runId: f.ids.next("run"),
    status: "succeeded",
    endedAt: EARLIER,
  });
  await stores.runs.put(sibling);

  // A project of its own, in the same organisation, with a finished run.
  const foreignProject = f.ids.next("proj");
  const foreignProgram = f.ids.next("prog");
  await stores.projects.put(makeProject(f, { projectId: foreignProject, orgId }));
  await stores.programContracts.put(
    makeProgramContract(f, { projectId: foreignProject, programId: foreignProgram }),
  );
  const foreign = makeRun(f, {
    projectId: foreignProject,
    programId: foreignProgram,
    runId: f.ids.next("run"),
    status: "succeeded",
    endedAt: EARLIER,
  });
  await stores.runs.put(foreign);

  const deps = { stores, clock: createFixedClock(Date.parse(NOW)) };
  const as: RequestPrincipal = { kind: "user", userId: user };
  const call = (method: string, path: string, body?: unknown, principal: RequestPrincipal = as) =>
    handleRequest(deps, { method, path, query: {}, body, principal });
  const actor = { kind: "user", userId: user, orgId } as const;
  const runPath = `/projects/${f.scope.projectId}/programs/${f.scope.programId}/runs/${f.scope.runId}`;
  const rate = async (
    scope: {
      projectId: typeof f.scope.projectId;
      programId: typeof f.scope.programId;
      runId: RunId;
    },
    verdict: "worked" | "did_not_work",
  ) => {
    const feedback = buildRunFeedback({ scope, verdict, actor, at: EARLIER });
    await stores.feedback.put(feedback);
    return feedback;
  };
  const anchorRef = { programId: f.scope.programId, runId: f.scope.runId, role: "anchor" } as const;
  const first = makeCompletionHistory(f);
  const path = (id = first.completionHistoryId) => `${runPath}/completion-histories/${id}`;
  const revise = (
    stored: CompletionHistory,
    patch: Partial<Parameters<typeof buildCompletionHistory>[0]>,
  ) =>
    buildCompletionHistory({
      stored,
      scope: f.scope,
      completionHistoryId: stored.completionHistoryId,
      title: stored.title,
      members: stored.members,
      actor,
      at: NOW,
      ...patch,
    });
  return {
    f,
    stores,
    call,
    as,
    orgId,
    user,
    stranger,
    root,
    runPath,
    sibling,
    foreign,
    rate,
    first,
    path,
    revise,
    anchorRef,
    actor,
  };
};

type World = Awaited<ReturnType<typeof setup>>;

const created = async (w: World): Promise<CompletionHistory> => {
  const response = await w.call("PUT", w.path(), w.first);
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body as CompletionHistory;
};

describe("writing a completion history (D-05)", () => {
  it("creates one from the anchor alone, with the server's attribution", async () => {
    const w = await setup();
    const forged = {
      ...w.first,
      createdAt: "2020-01-01T00:00:00.000Z",
      updatedAt: "2020-01-01T00:00:00.000Z",
      revisions: [
        {
          version: 1,
          actor: { kind: "user", userId: "someone-else", orgId: w.orgId },
          recordedAt: "2020-01-01T00:00:00.000Z",
          members: w.first.members,
        },
      ],
    };
    const response = await w.call("PUT", w.path(), forged);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const stored = response.body as CompletionHistory;
    expect(stored.revisions).toHaveLength(1);
    expect(stored.revisions[0]).toMatchObject({ actor: w.actor, recordedAt: NOW });
    expect(stored.createdAt).toBe(NOW);
    expect(await w.stores.completionHistories.get(w.f.scope, w.first.completionHistoryId)).toEqual(
      stored,
    );
  });

  it("confirms the same body again as 200 without a new revision", async () => {
    const w = await setup();
    await created(w);
    const again = await w.call("PUT", w.path(), w.first);
    expect(again.status).toBe(200);
    expect((again.body as CompletionHistory).revisions).toHaveLength(1);
  });

  it("adds a run of another program of the same project as a correction", async () => {
    const w = await setup();
    const stored = await created(w);
    const members = [
      ...stored.members,
      { programId: w.sibling.programId, runId: w.sibling.runId, role: "correction" as const },
    ];
    const response = await w.call("PUT", w.path(), w.revise(stored, { members }));
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toMatchObject({ version: 2 });
    expect((response.body as CompletionHistory).members).toHaveLength(2);
    expect((response.body as CompletionHistory).revisions).toHaveLength(2);
  });

  it("refuses a run of another project with 422 and stores nothing", async () => {
    const w = await setup();
    const stored = await created(w);
    const members = [
      ...stored.members,
      { programId: w.foreign.programId, runId: w.foreign.runId, role: "contributing" as const },
    ];
    const response = await w.call("PUT", w.path(), w.revise(stored, { members }));
    expect(response.status).toBe(422);
    expect(errorCode(response)).toBe("completion_membership");
    expect(JSON.stringify(response.body)).toContain(w.foreign.runId);
    expect(await w.stores.completionHistories.get(w.f.scope, w.first.completionHistoryId)).toEqual(
      stored,
    );
  });

  it("refuses a first write that names a run of another project", async () => {
    const w = await setup();
    const members = [
      w.anchorRef,
      { programId: w.foreign.programId, runId: w.foreign.runId, role: "contributing" as const },
    ];
    const response = await w.call(
      "PUT",
      w.path(),
      buildCompletionHistory({
        scope: w.f.scope,
        completionHistoryId: w.first.completionHistoryId,
        title: w.first.title,
        members,
        actor: w.actor,
        at: NOW,
      }),
    );
    expect(response.status).toBe(422);
    expect(await w.stores.completionHistories.listByRun(w.f.scope)).toEqual([]);
  });

  it("snapshots a checkpoint on a member rated worked from the server's own records", async () => {
    const w = await setup();
    const stored = await created(w);
    const feedback = await w.rate(w.f.scope, "worked");
    const proposal = w.revise(stored, {
      checkpoint: { name: "ship", programId: w.f.scope.programId, runId: w.f.scope.runId },
    });
    const forged = {
      ...proposal,
      checkpoints: proposal.checkpoints.map((c) => ({
        ...c,
        feedbackVersion: 9,
        verdictRecordedAt: "2020-01-01T00:00:00.000Z",
        recordedBy: { kind: "user", userId: "someone-else", orgId: w.orgId },
      })),
    };
    const response = await w.call("PUT", w.path(), forged);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const [checkpoint] = (response.body as CompletionHistory).checkpoints;
    expect(checkpoint).toMatchObject({
      name: "ship",
      feedbackVersion: feedback.version,
      verdictRecordedAt: feedback.recordedAt,
      recordedBy: w.actor,
      recordedAt: NOW,
      membershipVersion: 2,
    });
  });

  it("refuses a checkpoint on a member rated did_not_work, or not rated", async () => {
    const w = await setup();
    const stored = await created(w);
    const wanted = {
      checkpoint: { name: "ship", programId: w.f.scope.programId, runId: w.f.scope.runId },
    };
    const unrated = await w.call("PUT", w.path(), w.revise(stored, wanted));
    expect(unrated.status).toBe(422);
    await w.rate(w.f.scope, "did_not_work");
    const negative = await w.call("PUT", w.path(), w.revise(stored, wanted));
    expect(negative.status).toBe(422);
    expect(errorCode(negative)).toBe("completion_membership");
    expect(
      (await w.stores.completionHistories.get(w.f.scope, stored.completionHistoryId))?.version,
    ).toBe(1);
  });

  it("refuses to alter a stored checkpoint", async () => {
    const w = await setup();
    const stored = await created(w);
    await w.rate(w.f.scope, "worked");
    const withCheckpoint = (
      await w.call(
        "PUT",
        w.path(),
        w.revise(stored, {
          checkpoint: { name: "ship", programId: w.f.scope.programId, runId: w.f.scope.runId },
        }),
      )
    ).body as CompletionHistory;
    const altered = {
      ...w.revise(withCheckpoint, { title: "Renamed" }),
      checkpoints: withCheckpoint.checkpoints.map((c) => ({
        ...c,
        name: "ship",
        feedbackVersion: 7,
      })),
    };
    const response = await w.call("PUT", w.path(), altered);
    expect(response.status).toBe(422);
    expect(errorCode(response)).toBe("completion_membership");
    const dropped = { ...w.revise(withCheckpoint, {}), checkpoints: [] };
    expect((await w.call("PUT", w.path(), dropped)).status).toBe(422);
    expect(
      (await w.stores.completionHistories.get(w.f.scope, stored.completionHistoryId))?.checkpoints,
    ).toEqual(withCheckpoint.checkpoints);
  });

  it("refuses a stale version with 409 stale_write", async () => {
    const w = await setup();
    const stored = await created(w);
    await w.call("PUT", w.path(), w.revise(stored, { title: "Second" }));
    const stale = await w.call("PUT", w.path(), w.revise(stored, { title: "Third" }));
    expect(stale.status).toBe(409);
    expect(errorCode(stale)).toBe("stale_write");
  });

  it("refuses a body whose identifier or chain disagrees with the path", async () => {
    const w = await setup();
    const other = makeCompletionHistory(w.f);
    expect((await w.call("PUT", w.path(), other)).status).toBe(400);
    const elsewhere = buildCompletionHistory({
      scope: { ...w.f.scope, programId: w.sibling.programId, runId: w.sibling.runId },
      completionHistoryId: w.first.completionHistoryId,
      title: w.first.title,
      members: [{ programId: w.sibling.programId, runId: w.sibling.runId, role: "anchor" }],
      actor: w.actor,
      at: NOW,
    });
    expect((await w.call("PUT", w.path(), elsewhere)).status).toBe(403);
  });
});

describe("reading completion histories", () => {
  it("round trips get, listByRun and listByProject, and answers 404 for an unknown id", async () => {
    const w = await setup();
    const stored = await created(w);
    const got = await w.call("GET", w.path());
    expect(got.status).toBe(200);
    expect(got.body).toEqual(stored);
    const byRun = await w.call("GET", `${w.runPath}/completion-histories`);
    expect(byRun.status).toBe(200);
    expect(byRun.body).toEqual({ items: [stored] });
    const byProject = await w.call("GET", `/projects/${w.f.scope.projectId}/completion-histories`);
    expect(byProject.status).toBe(200);
    expect(byProject.body).toEqual({ items: [stored] });
    const unknown = await w.call("GET", w.path(w.f.ids.next("comp")));
    expect(unknown.status).toBe(404);
    expect(errorCode(unknown)).toBe("not_found");
  });
});

describe("who may touch completion histories", () => {
  const roles: readonly ExecutionRole[] = [
    "worker",
    "orchestrator",
    "examiner",
    "arbiter",
    "engine",
  ];

  it.each(roles)("refuses a %s token the write and the reads", async (role) => {
    const w = await setup();
    const token: RequestPrincipal = {
      kind: "execution",
      ...w.f.scope,
      nodeId: w.root.executionNodeId,
      agentId: makeAgent(w.f, w.root.executionNodeId).agentId,
      role,
      ...(role === "engine" ? { generation: 1 } : {}),
    };
    for (const response of [
      await w.call("PUT", w.path(), w.first, token),
      await w.call("GET", w.path(), undefined, token),
      await w.call("GET", `${w.runPath}/completion-histories`, undefined, token),
      await w.call(
        "GET",
        `/projects/${w.f.scope.projectId}/completion-histories`,
        undefined,
        token,
      ),
    ]) {
      expect(response.status, JSON.stringify(response.body)).toBe(403);
      expect(errorCode(response)).toBe("execution_forbidden_operation");
    }
    expect(await w.stores.completionHistories.listByRun(w.f.scope)).toEqual([]);
  });

  it("refuses another organisation's user", async () => {
    const w = await setup();
    const outsider: RequestPrincipal = { kind: "user", userId: w.stranger };
    for (const response of [
      await w.call("PUT", w.path(), w.first, outsider),
      await w.call("GET", w.path(), undefined, outsider),
      await w.call("GET", `${w.runPath}/completion-histories`, undefined, outsider),
      await w.call(
        "GET",
        `/projects/${w.f.scope.projectId}/completion-histories`,
        undefined,
        outsider,
      ),
    ]) {
      expect(response.status).toBe(403);
      expect(errorCode(response)).toBe("wrong_org");
    }
    expect(await w.stores.completionHistories.listByRun(w.f.scope)).toEqual([]);
  });
});
