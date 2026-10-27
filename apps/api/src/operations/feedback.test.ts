/**
 * A person's verdict on a run (P20, D-04), through the handler over the
 * in-memory stores: the server writes the attribution, a run that has not ended
 * cannot be rated, and racing writers leave one current verdict.
 */
import type { ExecutionRole, RunFeedback } from "@nightshift/contracts";
import {
  buildRunFeedback,
  createFixedClock,
  createFixtures,
  makeAgent,
  makeDispatch,
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
const ENDED = "2026-10-01T09:00:00.000Z";
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const OTHER_COMMIT = "fedcba9876543210fedcba9876543210fedcba98";

export const errorCode = (response: ApiResponse): string =>
  (response.body as { error: { code: string } }).error.code;

const setup = async (
  runPatch: Record<string, unknown> = {},
  /** The run's dispatch, stored while it was still pending (D-07). */
  dispatch?: Record<string, unknown>,
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
  const root = makeRootNode(f, { commitSha: COMMIT });
  await stores.executionNodes.put(root);
  if (dispatch !== undefined) {
    await stores.runs.put(makeRun(f, { status: "pending", rootNodeId: root.executionNodeId }));
    await stores.dispatches.put(makeDispatch(f, dispatch));
  }
  await stores.runs.put(
    makeRun(f, {
      status: "succeeded",
      endedAt: ENDED,
      rootNodeId: root.executionNodeId,
      ...runPatch,
    }),
  );
  const deps = { stores, clock: createFixedClock(Date.parse(NOW)) };
  const as: RequestPrincipal = { kind: "user", userId: user };
  const call = (
    method: string,
    path: string,
    body?: unknown,
    principal: RequestPrincipal = as,
    query = {},
  ) => handleRequest(deps, { method, path, query, body, principal });
  const run = `/projects/${f.scope.projectId}/programs/${f.scope.programId}/runs/${f.scope.runId}`;
  const propose = (version: number, verdict: RunFeedback["verdict"]): RunFeedback =>
    buildRunFeedback({
      scope: f.scope,
      verdict,
      actor: { kind: "user", userId: user, orgId },
      at: ENDED,
      ...(version > 1
        ? {
            stored: {
              ...buildRunFeedback({
                scope: f.scope,
                verdict: "worked",
                actor: { kind: "user", userId: user, orgId },
                at: ENDED,
              }),
              version: version - 1,
            },
          }
        : {}),
    });
  return { f, stores, call, run, as, orgId, user, stranger, root, propose, deps };
};

type World = Awaited<ReturnType<typeof setup>>;

describe("rating a run (D-04)", () => {
  it("stores the verdict with the server's actor, time and commit, whatever the body claims", async () => {
    const w = await setup();
    const honest = w.propose(1, "worked");
    const claim = {
      actor: { kind: "user", userId: "someone-else", orgId: w.orgId },
      recordedAt: "2020-01-01T00:00:00.000Z",
      resultCommit: OTHER_COMMIT,
    };
    const forged = {
      ...honest,
      ...claim,
      revisions: [{ version: 1, verdict: "worked", ...claim }],
    };
    const response = await w.call("PUT", `${w.run}/feedback`, forged);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const stored = response.body as RunFeedback;
    expect(stored.actor).toEqual({ kind: "user", userId: w.user, orgId: w.orgId });
    expect(stored.recordedAt).toBe(NOW);
    expect(stored.resultCommit).toBe(COMMIT);
    expect(stored.revisions).toHaveLength(1);
    expect(stored.revisions[0]).toMatchObject({ actor: stored.actor, resultCommit: COMMIT });
    expect(await w.stores.feedback.get(w.f.scope)).toEqual(stored);
  });

  it("takes the commit from a remote dispatch's publication when the root node has none", async () => {
    const w = await setup({}, { publication: { intents: [], head: OTHER_COMMIT } });
    await w.stores.executionNodes.put({ ...w.root, commitSha: null } as typeof w.root);
    const response = await w.call("PUT", `${w.run}/feedback`, w.propose(1, "worked"));
    expect((response.body as RunFeedback).resultCommit).toBe(OTHER_COMMIT);
  });

  it("leaves the commit absent when neither source has one", async () => {
    const w = await setup();
    await w.stores.executionNodes.put({ ...w.root, commitSha: null } as typeof w.root);
    const response = await w.call("PUT", `${w.run}/feedback`, w.propose(1, "worked"));
    expect(response.status).toBe(201);
    expect(response.body).not.toHaveProperty("resultCommit");
  });

  it("confirms the same body again without a new revision", async () => {
    const w = await setup();
    await w.call("PUT", `${w.run}/feedback`, w.propose(1, "worked"));
    const again = await w.call("PUT", `${w.run}/feedback`, w.propose(1, "worked"));
    expect(again.status).toBe(200);
    expect((again.body as RunFeedback).revisions).toHaveLength(1);
    // Asking for the verdict it already holds at the next version changes nothing either.
    const same = await w.call("PUT", `${w.run}/feedback`, w.propose(2, "worked"));
    expect(same.status).toBe(200);
    expect((await w.stores.feedback.get(w.f.scope))?.version).toBe(1);
  });

  it("changes then clears the verdict, keeping every revision", async () => {
    const w = await setup();
    await w.call("PUT", `${w.run}/feedback`, w.propose(1, "worked"));
    const changed = await w.call("PUT", `${w.run}/feedback`, w.propose(2, "did_not_work"));
    expect(changed.status).toBe(200);
    expect(changed.body).toMatchObject({ version: 2, verdict: "did_not_work" });
    expect((changed.body as RunFeedback).revisions).toHaveLength(2);
    const cleared = await w.call("PUT", `${w.run}/feedback`, w.propose(3, null));
    expect(cleared.status).toBe(200);
    expect(cleared.body).toMatchObject({ version: 3, verdict: null });
    expect((cleared.body as RunFeedback).revisions).toHaveLength(3);
  });

  it("answers 404 to clearing a verdict that was never given", async () => {
    const w = await setup();
    const response = await w.call("PUT", `${w.run}/feedback`, w.propose(1, null));
    expect(response.status).toBe(404);
    expect(errorCode(response)).toBe("not_found");
    expect(await w.stores.feedback.get(w.f.scope)).toBeUndefined();
  });

  it("lets exactly one of two writers at the same expected version win", async () => {
    const w = await setup();
    await w.call("PUT", `${w.run}/feedback`, w.propose(1, "worked"));
    const results = await Promise.all([
      w.call("PUT", `${w.run}/feedback`, w.propose(2, "did_not_work")),
      w.call("PUT", `${w.run}/feedback`, w.propose(2, "did_not_work")),
    ]);
    const won = results.filter((r) => r.status >= 200 && r.status < 300);
    const conflicts = results.filter((r) => r.status === 409);
    expect(won).toHaveLength(1);
    expect(conflicts).toHaveLength(1);
    expect(errorCode(conflicts[0] as ApiResponse)).toBe("stale_write");
    const current = await w.stores.feedback.get(w.f.scope);
    expect(current).toMatchObject({ version: 2, verdict: "did_not_work" });
    expect(current?.revisions).toHaveLength(2);
  });

  it("refuses a stale write with 409 stale_write and keeps the current verdict", async () => {
    const w = await setup();
    await w.call("PUT", `${w.run}/feedback`, w.propose(1, "worked"));
    await w.call("PUT", `${w.run}/feedback`, w.propose(2, "did_not_work"));
    const stale = await w.call("PUT", `${w.run}/feedback`, w.propose(2, "worked"));
    expect(stale.status).toBe(409);
    expect(errorCode(stale)).toBe("stale_write");
    expect((await w.stores.feedback.get(w.f.scope))?.verdict).toBe("did_not_work");
  });

  it("answers 200 to a replay of the writer's own write", async () => {
    const w = await setup();
    await w.call("PUT", `${w.run}/feedback`, w.propose(1, "worked"));
    await w.call("PUT", `${w.run}/feedback`, w.propose(2, "did_not_work"));
    const replay = await w.call("PUT", `${w.run}/feedback`, w.propose(2, "did_not_work"));
    expect(replay.status).toBe(200);
    expect((await w.stores.feedback.get(w.f.scope))?.revisions).toHaveLength(2);
  });

  it.each(["running", "pending"] as const)("refuses to rate a %s run", async (status) => {
    const w = await setup({ status, endedAt: undefined });
    const response = await w.call("PUT", `${w.run}/feedback`, w.propose(1, "worked"));
    expect(response.status).toBe(409);
    expect(errorCode(response)).toBe("run_not_finished");
    expect(await w.stores.feedback.get(w.f.scope)).toBeUndefined();
  });

  it("refuses a body that sits in another run", async () => {
    const w = await setup();
    const response = await w.call("PUT", `${w.run}/feedback`, {
      ...w.propose(1, "worked"),
      runId: w.f.ids.next("run"),
    });
    expect(response.status).toBe(403);
  });
});

describe("reading feedback", () => {
  it("answers 404 for an unrated run and lists a program's verdicts in pages", async () => {
    const w = await setup();
    expect((await w.call("GET", `${w.run}/feedback`)).status).toBe(404);
    await w.call("PUT", `${w.run}/feedback`, w.propose(1, "worked"));
    const got = await w.call("GET", `${w.run}/feedback`);
    expect(got.status).toBe(200);
    expect(got.body).toMatchObject({ verdict: "worked", version: 1 });
    const program = w.run.replace(/\/runs\/.*$/, "");
    const listed = await w.call("GET", `${program}/feedback`);
    expect(listed.status).toBe(200);
    expect((listed.body as { items: unknown[] }).items).toHaveLength(1);
    expect(listed.body).not.toHaveProperty("cursor");
  });
});

describe("who may touch feedback", () => {
  const roles: readonly ExecutionRole[] = [
    "worker",
    "orchestrator",
    "examiner",
    "arbiter",
    "engine",
  ];

  const executionAs = (w: World, role: ExecutionRole): RequestPrincipal => ({
    kind: "execution",
    ...w.f.scope,
    nodeId: w.root.executionNodeId,
    agentId: makeAgent(w.f, w.root.executionNodeId).agentId,
    role,
    ...(role === "engine" ? { generation: 1 } : {}),
  });

  it.each(roles)("refuses a %s token the write and the reads", async (role) => {
    const w = await setup({}, {});
    const token = executionAs(w, role);
    const program = w.run.replace(/\/runs\/.*$/, "");
    const attempts = [
      w.call("PUT", `${w.run}/feedback`, w.propose(1, "worked"), token),
      w.call("GET", `${w.run}/feedback`, undefined, token),
      w.call("GET", `${program}/feedback`, undefined, token),
    ];
    for (const response of await Promise.all(attempts)) {
      expect(response.status, JSON.stringify(response.body)).toBe(403);
      expect(errorCode(response)).toBe("execution_forbidden_operation");
    }
    expect(await w.stores.feedback.get(w.f.scope)).toBeUndefined();
  });

  it("refuses another organisation's user", async () => {
    const w = await setup();
    const outsider: RequestPrincipal = { kind: "user", userId: w.stranger };
    const program = w.run.replace(/\/runs\/.*$/, "");
    for (const response of [
      await w.call("PUT", `${w.run}/feedback`, w.propose(1, "worked"), outsider),
      await w.call("GET", `${w.run}/feedback`, undefined, outsider),
      await w.call("GET", `${program}/feedback`, undefined, outsider),
    ]) {
      expect(response.status).toBe(403);
      expect(errorCode(response)).toBe("wrong_org");
    }
    expect(await w.stores.feedback.get(w.f.scope)).toBeUndefined();
  });
});
