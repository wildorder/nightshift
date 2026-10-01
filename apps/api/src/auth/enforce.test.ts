/**
 * The project → organisation cache, and the shape of what `enforce` decides
 * (T3 deliverable 3).
 *
 * The matrix in `../isolation.test.ts` proves the decisions end to end. This
 * file is about the two things that are hard to see from there: how many reads
 * the cache does, and that a miss is never remembered.
 */
import {
  createFixtures,
  createSteppingClock,
  makeMembership,
  makeProject,
  nextUserId,
} from "@nightshift/core";
import { createInMemoryStores } from "@nightshift/persistence/memory";
import { describe, expect, it } from "vitest";
import { HttpError } from "../http.js";
import {
  createProjectOrgCache,
  DEFAULT_PROJECT_ORG_TTL_MS,
  enforce,
  requestedNodeStatusFrom,
  targetFrom,
} from "./enforce.js";

const countingProjects = (stores: ReturnType<typeof createInMemoryStores>) => {
  let reads = 0;
  return {
    reads: () => reads,
    store: {
      ...stores.projects,
      get: async (projectId: Parameters<typeof stores.projects.get>[0]) => {
        reads += 1;
        return stores.projects.get(projectId);
      },
    },
  };
};

describe("the project org cache", () => {
  it("reads once and then answers from memory", async () => {
    const stores = createInMemoryStores();
    const f = createFixtures();
    const project = makeProject(f, { orgId: f.ids.next("org") });
    await stores.projects.put(project);

    const counting = countingProjects(stores);
    const clock = createSteppingClock(0, 0);
    const cache = createProjectOrgCache({ projects: counting.store, clock });

    for (let i = 0; i < 5; i += 1) {
      expect(await cache.orgOf(project.projectId)).toBe(project.orgId);
    }
    expect(counting.reads()).toBe(1);
  });

  it("reads again once the entry has aged out", async () => {
    const stores = createInMemoryStores();
    const f = createFixtures();
    const project = makeProject(f, { orgId: f.ids.next("org") });
    await stores.projects.put(project);

    const counting = countingProjects(stores);
    const clock = createSteppingClock(0, DEFAULT_PROJECT_ORG_TTL_MS + 1);
    const cache = createProjectOrgCache({ projects: counting.store, clock });

    await cache.orgOf(project.projectId);
    await cache.orgOf(project.projectId);
    expect(counting.reads()).toBe(2);
  });

  /**
   * The hole this avoids: if "no such project" were cached, a project created in
   * one organisation would be invisible to the check for the whole TTL, and a
   * caller from any other organisation would sail past `enforce`.
   */
  it("never remembers a miss, so a project created after a miss is seen at once", async () => {
    const stores = createInMemoryStores();
    const f = createFixtures();
    const project = makeProject(f, { orgId: f.ids.next("org") });

    const clock = createSteppingClock(0, 0);
    const cache = createProjectOrgCache({ projects: stores.projects, clock });

    expect(await cache.orgOf(project.projectId)).toBeUndefined();
    await stores.projects.put(project);
    expect(await cache.orgOf(project.projectId)).toBe(project.orgId);
  });
});

describe("targetFrom", () => {
  it("prefers the path's node over the body's", () => {
    const target = targetFrom(
      { projectId: "p", nodeId: "from-path" },
      { executionNodeId: "from-body" },
    );
    expect(target).toEqual({ projectId: "p", nodeId: "from-path" });
  });

  it("falls back to the body's node for a route whose path names none", () => {
    expect(targetFrom({ runId: "r" }, { executionNodeId: "from-body" })).toEqual({
      runId: "r",
      nodeId: "from-body",
    });
  });

  it("leaves the node absent when neither names one, or the body is not an object", () => {
    for (const body of [undefined, null, "text", 7, { executionNodeId: 7 }]) {
      expect(targetFrom({ runId: "r" }, body)).toEqual({ runId: "r" });
    }
  });
});

describe("requestedNodeStatusFrom", () => {
  it("reads a string status and nothing else", () => {
    expect(requestedNodeStatusFrom({ status: "implemented" })).toBe("implemented");
    expect(requestedNodeStatusFrom({ status: 3 })).toBeUndefined();
    expect(requestedNodeStatusFrom({})).toBeUndefined();
    expect(requestedNodeStatusFrom(null)).toBeUndefined();
    expect(requestedNodeStatusFrom("implemented")).toBeUndefined();
  });
});

describe("enforce", () => {
  const world = async () => {
    const stores = createInMemoryStores();
    const f = createFixtures();
    const orgId = f.ids.next("org");
    const userId = nextUserId(f);
    await stores.memberships.put(makeMembership(userId, orgId));
    const project = makeProject(f, { orgId });
    await stores.projects.put(project);
    return {
      stores,
      f,
      orgId,
      userId,
      project,
      projectOrgs: createProjectOrgCache({
        projects: stores.projects,
        clock: createSteppingClock(0, 0),
      }),
    };
  };

  it("returns a complete user principal, organisation included", async () => {
    const w = await world();
    const principal = await enforce({
      principal: { kind: "user", userId: w.userId },
      operation: "project.get",
      params: { projectId: w.project.projectId },
      body: undefined,
      memberships: w.stores.memberships,
      nodes: w.stores.executionNodes,
      dispatches: w.stores.dispatches,
      projectOrgs: w.projectOrgs,
    });
    expect(principal).toEqual({ kind: "user", userId: w.userId, orgId: w.orgId });
  });

  it("refuses a caller with no membership before it looks at the project", async () => {
    const w = await world();
    const stranger = nextUserId(w.f);
    await expect(
      enforce({
        principal: { kind: "user", userId: stranger },
        operation: "project.get",
        params: { projectId: w.project.projectId },
        body: undefined,
        memberships: w.stores.memberships,
        nodes: w.stores.executionNodes,
        dispatches: w.stores.dispatches,
        projectOrgs: w.projectOrgs,
      }),
    ).rejects.toMatchObject({ status: 403, code: "no_membership" });
  });

  it("passes an execution principal straight to `authorize`, touching no store", async () => {
    const w = await world();
    const nodeId = w.f.ids.next("node");
    const principal = {
      kind: "execution" as const,
      projectId: w.f.scope.projectId,
      programId: w.f.scope.programId,
      runId: w.f.scope.runId,
      nodeId,
      agentId: w.f.ids.next("agent"),
      role: "worker" as const,
    };
    const unusable = {
      orgOf: async () => {
        throw new Error("an execution principal must not need the project cache");
      },
    };
    await expect(
      enforce({
        principal,
        operation: "run.get",
        params: {
          projectId: w.f.scope.projectId,
          programId: w.f.scope.programId,
          runId: w.f.scope.runId,
        },
        body: undefined,
        memberships: w.stores.memberships,
        nodes: w.stores.executionNodes,
        dispatches: w.stores.dispatches,
        projectOrgs: unusable,
      }),
    ).resolves.toEqual(principal);
  });

  it("throws an HttpError, so every refusal reaches the client as a 403", async () => {
    const w = await world();
    const other = await world();
    const error = await enforce({
      principal: { kind: "user", userId: other.userId },
      operation: "project.get",
      params: { projectId: w.project.projectId },
      body: undefined,
      memberships: other.stores.memberships,
      nodes: other.stores.executionNodes,
      dispatches: other.stores.dispatches,
      projectOrgs: w.projectOrgs,
    }).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({ status: 403, code: "wrong_org" });
  });
});
