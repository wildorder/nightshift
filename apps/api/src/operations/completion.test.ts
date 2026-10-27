/**
 * A person's completion history (P20, D-05), through the handler over the
 * in-memory stores: membership stays inside the path's project, checkpoints are
 * snapshotted by the server from the verdicts it holds, and a stored checkpoint
 * never changes.
 */
import type {
  CompletionHistory,
  ExecutionRole,
  MeasurementSummary,
  RoutingDecision,
  RunId,
} from "@nightshift/contracts";
import {
  buildCompletionHistory,
  buildRunFeedback,
  createFixedClock,
  createFixtures,
  makeAgent,
  makeCompletionHistory,
  makeDispatch,
  makeMembership,
  makeNode,
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

const setup = async (
  wrap: (
    stores: ReturnType<typeof createInMemoryStores>,
  ) => ReturnType<typeof createInMemoryStores> = (stores) => stores,
  /** The sibling's run is stored still running, as `seedMeasured` needs it: a stored terminal run is never put back (PIP-9). */
  siblingOpen = false,
  /** The anchor run has a dispatch, stored while it was still pending (D-07). */
  anchorDispatched = false,
) => {
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
  if (anchorDispatched) {
    await stores.runs.put(makeRun(f, { status: "pending", rootNodeId: root.executionNodeId }));
    await stores.dispatches.put(makeDispatch(f, { ...f.scope }));
  }
  await stores.runs.put(
    makeRun(f, {
      status: "succeeded",
      endedAt: EARLIER,
      rootNodeId: root.executionNodeId,
    }),
  );

  // A second program of the same project, with a finished run.
  const otherProgram = f.ids.next("prog");
  await stores.programContracts.put(makeProgramContract(f, { programId: otherProgram }));
  const sibling = makeRun(f, {
    programId: otherProgram,
    runId: f.ids.next("run"),
    ...(siblingOpen
      ? { status: "running" as const, startedAt: "2026-10-01T09:30:00.000Z" }
      : { status: "succeeded" as const, endedAt: EARLIER }),
  });
  await stores.runs.put(sibling);

  // A project of its own, in the same organisation, with a finished run.
  const foreignProject = f.ids.next("proj");
  const foreignProgram = f.ids.next("prog");
  await stores.projects.put(makeProject(f, { projectId: foreignProject, orgId }));
  await stores.programContracts.put(
    makeProgramContract(f, {
      projectId: foreignProject,
      programId: foreignProgram,
    }),
  );
  const foreign = makeRun(f, {
    projectId: foreignProject,
    programId: foreignProgram,
    runId: f.ids.next("run"),
    status: "succeeded",
    endedAt: EARLIER,
  });
  await stores.runs.put(foreign);

  const deps = {
    stores: wrap(stores),
    clock: createFixedClock(Date.parse(NOW)),
  };
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
  const anchorRef = {
    programId: f.scope.programId,
    runId: f.scope.runId,
    role: "anchor",
  } as const;
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
          added: w.first.members,
          removed: [],
        },
      ],
    };
    const response = await w.call("PUT", w.path(), forged);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const stored = response.body as CompletionHistory;
    expect(stored.revisions).toHaveLength(1);
    expect(stored.revisions[0]).toMatchObject({
      actor: w.actor,
      recordedAt: NOW,
    });
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
      {
        programId: w.sibling.programId,
        runId: w.sibling.runId,
        role: "correction" as const,
      },
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
      {
        programId: w.foreign.programId,
        runId: w.foreign.runId,
        role: "contributing" as const,
      },
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
      {
        programId: w.foreign.programId,
        runId: w.foreign.runId,
        role: "contributing" as const,
      },
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
      checkpoint: {
        name: "ship",
        programId: w.f.scope.programId,
        runId: w.f.scope.runId,
      },
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
      checkpoint: {
        name: "ship",
        programId: w.f.scope.programId,
        runId: w.f.scope.runId,
      },
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
          checkpoint: {
            name: "ship",
            programId: w.f.scope.programId,
            runId: w.f.scope.runId,
          },
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
      scope: {
        ...w.f.scope,
        programId: w.sibling.programId,
        runId: w.sibling.runId,
      },
      completionHistoryId: w.first.completionHistoryId,
      title: w.first.title,
      members: [
        {
          programId: w.sibling.programId,
          runId: w.sibling.runId,
          role: "anchor",
        },
      ],
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

describe("measuring a checkpoint (D-05)", () => {
  const VERDICT = "2026-10-01T09:45:00.000Z";
  const LATER = "2026-10-01T12:00:00.000Z";

  /** The anchor finished before the verdict; the sibling is still open, with model figures. */
  const seedMeasured = async (w: World) => {
    const { f, stores } = w;
    await stores.runs.put(
      makeRun(f, {
        status: "succeeded",
        startedAt: "2026-10-01T08:00:00.000Z",
        endedAt: "2026-10-01T09:40:00.000Z",
        rootNodeId: w.root.executionNodeId,
      }),
    );
    const scope = {
      projectId: w.sibling.projectId,
      programId: w.sibling.programId,
      runId: w.sibling.runId,
    };
    const open = w.sibling;
    if (open.status !== "running") throw new Error("seedMeasured needs setup(…, true)");
    const siblingRoot = makeRootNode(f, {
      ...scope,
      executionNodeId: w.sibling.rootNodeId,
    });
    await stores.executionNodes.put(siblingRoot);
    const node = makeNode(f, siblingRoot.executionNodeId, scope);
    await stores.executionNodes.put(node);
    const route = {
      schemaVersion: 1,
      ...scope,
      routingDecisionId: f.ids.next("route"),
      executionNodeId: node.executionNodeId,
      attempt: 1,
      eligibleOptions: [
        {
          target: { harness: "claude", provider: "anthropic", model: "m" },
          eligible: true,
        },
      ],
      chosen: { harness: "claude", provider: "anthropic", model: "m" },
      ruleId: "r",
      wasOverride: false,
      outcome: "verified",
      previousRouteId: null,
      createdAt: "2026-10-01T09:30:00.000Z",
      usage: {
        inputTokens: 100,
        outputTokens: 10,
        estimatedCostUsd: 0.5,
        actualCostUsd: 2,
      },
    } as RoutingDecision;
    await stores.routingDecisions.put(route);
    await stores.measurements.put({
      schemaVersion: 1,
      measurementVersion: 1,
      ...scope,
      measurementSummaryId: f.ids.next("meas"),
      executionNodeId: node.executionNodeId,
      agentId: f.ids.next("agent"),
      role: "worker",
      routingDecisionId: route.routingDecisionId,
      route: route.chosen,
      observedModels: [],
      segments: [],
      totals: { inputTokens: 100, outputTokens: 10, inputIncludesCache: true },
      coverage: "complete",
      gaps: [],
      ledger: {
        chunks: 0,
        artifactIds: [],
        observationCount: 0,
        publishedCount: 0,
      },
      valuation: { source: "unknown" },
      createdAt: "2026-10-01T09:30:00.000Z",
      updatedAt: "2026-10-01T09:40:00.000Z",
    } as unknown as MeasurementSummary);
    await stores.feedback.put(
      buildRunFeedback({
        scope: w.f.scope,
        verdict: "worked",
        actor: w.actor,
        at: VERDICT,
      }),
    );
    return { open, scope };
  };

  const withSibling = (w: World, stored: CompletionHistory, extra: object = {}) =>
    w.revise(stored, {
      members: [
        ...stored.members,
        {
          programId: w.sibling.programId,
          runId: w.sibling.runId,
          role: "contributing" as const,
        },
      ],
      checkpoint: {
        name: "ship",
        programId: w.f.scope.programId,
        runId: w.f.scope.runId,
      },
      ...extra,
    });

  it("bounds an open contributor at the verdict and holds its figures; later reads are unchanged", async () => {
    const w = await setup(undefined, true);
    await seedMeasured(w);
    const stored = await created(w);
    const response = await w.call("PUT", w.path(), withSibling(w, stored));
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const [checkpoint] = (response.body as CompletionHistory).checkpoints;
    expect(checkpoint?.measured).toMatchObject({
      measuredTo: VERDICT,
      readableMembers: 2,
      activeSeconds: 6300,
      tokens: { input: 100, output: 10 },
      usd: { estimated: 0.5, reported: 2 },
      recordedAt: NOW,
    });
    expect(checkpoint?.measured.infrastructure).toBeUndefined();
    const before = JSON.stringify(response.body);

    // The open run ends, and another member joins.
    await w.stores.runs.put({
      ...w.sibling,
      status: "succeeded",
      endedAt: LATER,
    });
    const third = {
      ...w.sibling,
      runId: w.f.ids.next("run"),
      status: "succeeded" as const,
      endedAt: LATER,
    };
    await w.stores.runs.put(third);
    const grown = response.body as CompletionHistory;
    const more = await w.call(
      "PUT",
      w.path(),
      w.revise(grown, {
        members: [
          ...grown.members,
          {
            programId: third.programId,
            runId: third.runId,
            role: "correction" as const,
          },
        ],
      }),
    );
    expect(more.status, JSON.stringify(more.body)).toBe(200);
    expect((more.body as CompletionHistory).checkpoints).toEqual(grown.checkpoints);

    const read = await w.call("GET", w.path());
    const [kept] = (read.body as CompletionHistory).checkpoints;
    expect(JSON.stringify(kept)).toBe(JSON.stringify(JSON.parse(before).checkpoints[0]));
  });

  it("replaces a forged measured block and forged revisions", async () => {
    const w = await setup(undefined, true);
    await seedMeasured(w);
    const stored = await created(w);
    const proposal = withSibling(w, stored);
    const forged = {
      ...proposal,
      revisions: [
        {
          version: 2,
          actor: { kind: "user", userId: "someone-else", orgId: w.orgId },
          recordedAt: "2020-01-01T00:00:00.000Z",
          added: [],
          removed: [],
        },
      ],
      checkpoints: proposal.checkpoints.map((c) => ({
        ...c,
        measured: {
          measuredTo: "2020-01-01T00:00:00.000Z",
          readableMembers: 9,
          measuredMembers: 9,
          unmeasuredMembers: 0,
          activeSeconds: 1,
          tokens: { input: 999999, inputConventionUnknown: 0 },
          usd: { estimated: 123, reported: 456 },
          infrastructure: { usd: 789, members: 9, withoutMachine: 0 },
          recordedAt: "2020-01-01T00:00:00.000Z",
        },
      })),
    };
    const response = await w.call("PUT", w.path(), forged);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const body = response.body as CompletionHistory;
    expect(body.checkpoints[0]?.measured).toMatchObject({
      measuredTo: VERDICT,
      readableMembers: 2,
      activeSeconds: 6300,
      tokens: { input: 100, output: 10 },
      usd: { estimated: 0.5, reported: 2 },
      recordedAt: NOW,
    });
    expect(body.checkpoints[0]?.measured.infrastructure).toBeUndefined();
    expect(body.revisions).toHaveLength(2);
    expect(body.revisions[1]).toMatchObject({
      actor: w.actor,
      recordedAt: NOW,
      checkpoint: "ship",
    });
  });

  it("performs no measurement reads for a write that adds no checkpoint", async () => {
    const reads: string[] = [];
    const count =
      <A extends unknown[], R>(name: string, fn: (...args: A) => R) =>
      (...args: A): R => {
        reads.push(name);
        return fn(...args);
      };
    const w = await setup(
      (s) => ({
        ...s,
        executionNodes: {
          ...s.executionNodes,
          listByRun: count("nodes", s.executionNodes.listByRun),
        },
        measurements: {
          ...s.measurements,
          listByRun: count("measurements", s.measurements.listByRun),
        },
        dispatches: {
          ...s.dispatches,
          get: count("dispatches", s.dispatches.get),
        },
        computeUtilizations: {
          ...s.computeUtilizations,
          get: count("utilization", s.computeUtilizations.get),
        },
        agents: { ...s.agents, listByNode: count("agents", s.agents.listByNode) },
        routingDecisions: {
          ...s.routingDecisions,
          listByNode: count("routes", s.routingDecisions.listByNode),
        },
      }),
      true,
    );
    await seedMeasured(w);
    const stored = await created(w);
    const plain = await w.call(
      "PUT",
      w.path(),
      w.revise(stored, {
        members: [
          ...stored.members,
          {
            programId: w.sibling.programId,
            runId: w.sibling.runId,
            role: "contributing" as const,
          },
        ],
      }),
    );
    expect(plain.status, JSON.stringify(plain.body)).toBe(200);
    expect(reads).toEqual([]);
    const checkpointed = await w.call(
      "PUT",
      w.path(),
      w.revise(plain.body as CompletionHistory, {
        checkpoint: {
          name: "ship",
          programId: w.f.scope.programId,
          runId: w.f.scope.runId,
        },
      }),
    );
    expect(checkpointed.status, JSON.stringify(checkpointed.body)).toBe(200);
    expect(reads.length).toBeGreaterThan(0);
  });

  describe.each(["measurements", "executionNodes"] as const)(
    "when %s cannot be read for a member",
    (store) => {
      const failing = { on: false, programId: "" };
      const guarded = () =>
        setup((s) => {
          const original = s[store].listByRun;
          return {
            ...s,
            [store]: {
              ...s[store],
              listByRun: ((scope: { programId: string }, ...rest: unknown[]) => {
                return failing.on && scope.programId === failing.programId
                  ? Promise.reject(new Error("store down"))
                  : (original as (...a: unknown[]) => unknown)(scope, ...rest);
              }) as unknown as typeof original,
            },
          };
        }, true);

      it("answers 503 measurement_unavailable, stores nothing, and a retry succeeds", async () => {
        failing.on = false;
        const w = await guarded();
        failing.programId = w.sibling.programId;
        await seedMeasured(w);
        const stored = await created(w);
        failing.on = true;
        const refused = await w.call("PUT", w.path(), withSibling(w, stored));
        expect(refused.status, JSON.stringify(refused.body)).toBe(503);
        expect(errorCode(refused)).toBe("measurement_unavailable");
        expect(JSON.stringify(refused.body)).toContain(w.sibling.runId);
        expect(JSON.stringify(refused.body)).toContain("store down");
        const after = await w.stores.completionHistories.get(w.f.scope, stored.completionHistoryId);
        expect(after).toEqual(stored);

        failing.on = false;
        const retried = await w.call("PUT", w.path(), withSibling(w, stored));
        expect(retried.status, JSON.stringify(retried.body)).toBe(200);
        const [checkpoint] = (retried.body as CompletionHistory).checkpoints;
        expect(checkpoint?.measured.tokens).toMatchObject({
          input: 100,
          output: 10,
        });
        expect(checkpoint?.measured.measuredMembers).toBeGreaterThanOrEqual(1);
      });

      it("still accepts a membership-only write", async () => {
        failing.on = false;
        const w = await guarded();
        failing.programId = w.sibling.programId;
        await seedMeasured(w);
        const stored = await created(w);
        failing.on = true;
        const plain = await w.call(
          "PUT",
          w.path(),
          w.revise(stored, {
            members: [
              ...stored.members,
              {
                programId: w.sibling.programId,
                runId: w.sibling.runId,
                role: "contributing",
              },
            ],
          }),
        );
        expect(plain.status, JSON.stringify(plain.body)).toBe(200);
      });
    },
  );

  describe("when the dispatch cannot be read for a member", () => {
    const failing = { on: false };
    const guarded = () =>
      setup(
        (s) => ({
          ...s,
          dispatches: {
            ...s.dispatches,
            get: ((...args: Parameters<typeof s.dispatches.get>) =>
              failing.on
                ? Promise.reject(new Error("dispatch store down"))
                : s.dispatches.get(...args)) as typeof s.dispatches.get,
          },
        }),
        true,
      );

    it("answers 503 measurement_unavailable, stores nothing, and a retry succeeds", async () => {
      failing.on = false;
      const w = await guarded();
      await seedMeasured(w);
      const stored = await created(w);
      failing.on = true;
      const refused = await w.call("PUT", w.path(), withSibling(w, stored));
      expect(refused.status, JSON.stringify(refused.body)).toBe(503);
      expect(errorCode(refused)).toBe("measurement_unavailable");
      expect(JSON.stringify(refused.body)).toContain("dispatch");
      expect(await w.stores.completionHistories.get(w.f.scope, stored.completionHistoryId)).toEqual(
        stored,
      );

      failing.on = false;
      const retried = await w.call("PUT", w.path(), withSibling(w, stored));
      expect(retried.status, JSON.stringify(retried.body)).toBe(200);
    });
  });

  it("stores a local-run member's checkpoint with withoutMachine and no machine dollars", async () => {
    const w = await setup(undefined, true, true);
    await seedMeasured(w);
    // The anchor has a dispatch; the open sibling is a local run with none.
    const stored = await created(w);
    const response = await w.call("PUT", w.path(), withSibling(w, stored));
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const [checkpoint] = (response.body as CompletionHistory).checkpoints;
    expect(checkpoint?.measured.infrastructure).toMatchObject({ members: 1, withoutMachine: 1 });
  });

  it("stores no machine figure for a checkpoint whose members are all local runs", async () => {
    const w = await setup(undefined, true);
    await seedMeasured(w);
    const stored = await created(w);
    const response = await w.call("PUT", w.path(), withSibling(w, stored));
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const [checkpoint] = (response.body as CompletionHistory).checkpoints;
    expect(checkpoint?.measured.infrastructure).toBeUndefined();
  });

  it("stores a checkpoint with an unmeasured member and fabricates no dollars", async () => {
    const w = await setup();
    await w.rate(w.f.scope, "worked");
    const stored = await created(w);
    const response = await w.call("PUT", w.path(), withSibling(w, stored));
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const [checkpoint] = (response.body as CompletionHistory).checkpoints;
    expect(checkpoint?.measured.measuredMembers).toBe(0);
    expect(checkpoint?.measured.unmeasuredMembers).toBe(2);
    expect(checkpoint?.measured.usd).toBeUndefined();
  });
});
