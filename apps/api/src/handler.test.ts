import type { Agent, OrgId, RoutingDecision } from "@nightshift/contracts";
import { AGGREGATE_EXAMPLES, ArtifactUploadResponseSchema } from "@nightshift/contracts";
import type { ArtifactUploadRequest, ArtifactUploadSigner } from "@nightshift/core";
import {
  createFixedClock,
  createFixtures,
  type Fixtures,
  makeAgent,
  makeCheckpoint,
  makeDecision,
  makeEvent,
  makeJobContract,
  makeMembership,
  makeNode,
  makeProgramContract,
  makeProject,
  makeRootNode,
  makeRun,
  makeVerification,
  type NightshiftStores,
  nextUserId,
} from "@nightshift/core";
import {
  createInMemoryStores,
  type InMemoryOptions,
  type InMemoryStores,
} from "@nightshift/persistence/memory";
import { describe, expect, it, vi } from "vitest";
import { handleRequest } from "./handler.js";
import type { ApiDeps, ApiResponse } from "./http.js";

const NOW = "2026-09-14T10:00:00.000Z";

interface World {
  readonly stores: InMemoryStores;
  readonly deps: ApiDeps;
  /** What the fake signer was asked for, newest last. */
  readonly signed: ArtifactUploadRequest[];
  readonly a: Fixtures;
  readonly b: Fixtures;
  readonly orgId: OrgId;
  readonly claims: Readonly<Record<string, unknown>>;
}

const setup = async (options: InMemoryOptions = {}): Promise<World> => {
  const stores = createInMemoryStores(options);
  const a = createFixtures();
  const b = createFixtures();
  const subject = nextUserId(a);
  const orgId = a.ids.next("org");
  await stores.memberships.put(makeMembership(subject, orgId));
  const signed: ArtifactUploadRequest[] = [];
  // A stand-in signer. What matters here is that the route passes the path's
  // ownership chain through and returns what it was handed; the real signature
  // is the presigner's business and the smoke suite's proof.
  const uploads: ArtifactUploadSigner = {
    sign: async (request) => {
      signed.push(request);
      const key = `${request.scope.projectId}/${request.scope.programId}/${request.scope.runId}/${request.artifactId}`;
      return {
        uri: `s3://bucket/${key}`,
        uploadUrl: `https://signed.invalid/${key}`,
        key,
        contentType: request.contentType,
        expiresAt: NOW,
      };
    },
  };
  return {
    stores,
    deps: { stores, clock: createFixedClock(Date.parse(NOW)), uploads },
    signed,
    a,
    b,
    orgId,
    claims: { sub: subject },
  };
};

const call = (
  w: World,
  method: string,
  path: string,
  body?: unknown,
  query: Record<string, string> = {},
  claims: Readonly<Record<string, unknown>> = w.claims,
): Promise<ApiResponse> => handleRequest(w.deps, { method, path, query, body, claims });

const paths = (f: Fixtures) => {
  const project = `/projects/${f.scope.projectId}`;
  const program = `${project}/programs/${f.scope.programId}`;
  const run = `${program}/runs/${f.scope.runId}`;
  return { project, program, run };
};

const projectBody = (f: Fixtures, overrides: Record<string, unknown> = {}) => {
  const { orgId: _orgId, ...body } = makeProject(f, overrides);
  return body;
};

const eventBody = (f: Fixtures, idempotencyKey: string) => {
  const {
    sequence: _sequence,
    recordedAt: _recordedAt,
    ...body
  } = makeEvent(f, {
    idempotencyKey,
  });
  return body;
};

const errorCode = (response: ApiResponse): string =>
  (response.body as { error: { code: string } }).error.code;

const seedRun = async (w: World, f: Fixtures): Promise<void> => {
  const p = paths(f);
  expect((await call(w, "PUT", p.project, projectBody(f))).status).toBe(201);
  expect((await call(w, "PUT", p.program, makeProgramContract(f))).status).toBe(201);
  expect((await call(w, "PUT", p.run, makeRun(f))).status).toBe(201);
  expect((await call(w, "PUT", `${p.run}/nodes/${f.rootNodeId}`, makeRootNode(f))).status).toBe(
    201,
  );
};

describe("routing", () => {
  it("returns 404 for an unknown route", async () => {
    const w = await setup();
    const response = await call(w, "GET", "/nowhere");
    expect(response.status).toBe(404);
    expect(errorCode(response)).toBe("route_not_found");
  });

  it("returns 405 for a known path with the wrong method", async () => {
    const w = await setup();
    const response = await call(w, "DELETE", paths(w.a).project);
    expect(response.status).toBe(405);
    expect(errorCode(response)).toBe("method_not_allowed");
  });

  it("returns 400 for a malformed identifier in the path", async () => {
    const w = await setup();
    const response = await call(w, "GET", "/projects/not-a-project");
    expect(response.status).toBe(400);
    expect(errorCode(response)).toBe("invalid_path");
  });

  it("returns a generic 500 for an unexpected failure, with no internal detail", async () => {
    const w = await setup();
    const failing: NightshiftStores = {
      ...w.stores,
      projects: {
        ...w.stores.projects,
        get: async () => {
          throw new Error("secret internal detail");
        },
      },
    };
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await handleRequest(
      { ...w.deps, stores: failing },
      { method: "GET", path: paths(w.a).project, query: {}, body: undefined, claims: w.claims },
    );
    spy.mockRestore();
    expect(response).toEqual({
      status: 500,
      body: { error: { code: "internal_error", message: "internal error" } },
    });
  });
});

describe("projects", () => {
  it("creates a project in the org resolved from the token", async () => {
    const w = await setup();
    const response = await call(w, "PUT", paths(w.a).project, projectBody(w.a));
    expect(response.status).toBe(201);
    expect((response.body as { orgId: string }).orgId).toBe(w.orgId);
    expect((await w.stores.projects.get(w.a.scope.projectId))?.orgId).toBe(w.orgId);
  });

  it("treats an identical retry as 200 and a different body as 409", async () => {
    const w = await setup();
    const body = projectBody(w.a);
    await call(w, "PUT", paths(w.a).project, body);
    expect((await call(w, "PUT", paths(w.a).project, body)).status).toBe(200);
    const changed = await call(w, "PUT", paths(w.a).project, { ...body, name: "renamed" });
    expect(changed.status).toBe(409);
    expect(errorCode(changed)).toBe("conflict");
  });

  it("refuses a body that names an org (D-P2-13)", async () => {
    const w = await setup();
    const response = await call(w, "PUT", paths(w.a).project, {
      ...projectBody(w.a),
      orgId: w.orgId,
    });
    expect(response.status).toBe(400);
    expect(errorCode(response)).toBe("validation_failed");
    expect((response.body as { error: { issues: unknown[] } }).error.issues.length).toBeGreaterThan(
      0,
    );
  });

  it("refuses a body whose projectId disagrees with the path", async () => {
    const w = await setup();
    const response = await call(w, "PUT", paths(w.a).project, projectBody(w.b));
    expect(response.status).toBe(403);
    expect(errorCode(response)).toBe("ownership_violation");
  });

  it("refuses to let a caller in another org take over an existing project", async () => {
    const w = await setup();
    await call(w, "PUT", paths(w.a).project, projectBody(w.a));
    const intruder = nextUserId(w.b);
    await w.stores.memberships.put(makeMembership(intruder, w.b.ids.next("org")));
    const response = await call(
      w,
      "PUT",
      paths(w.a).project,
      projectBody(w.a),
      {},
      { sub: intruder },
    );
    expect(response.status).toBe(403);
    expect(errorCode(response)).toBe("ownership_violation");
  });

  it("reads a project, and 404s one that does not exist", async () => {
    const w = await setup();
    await call(w, "PUT", paths(w.a).project, projectBody(w.a));
    expect((await call(w, "GET", paths(w.a).project)).status).toBe(200);
    const missing = await call(w, "GET", paths(w.b).project);
    expect(missing.status).toBe(404);
    expect(errorCode(missing)).toBe("not_found");
  });

  it("lists only the acting org's projects, a page at a time", async () => {
    const w = await setup();
    const second = createFixtures();
    await call(w, "PUT", paths(w.a).project, projectBody(w.a));
    await call(w, "PUT", paths(second).project, projectBody(second));
    await w.stores.projects.put(makeProject(w.b, { orgId: w.b.ids.next("org") }));

    const first = await call(w, "GET", "/projects", undefined, { limit: "1" });
    expect(first.status).toBe(200);
    const page = first.body as { items: { orgId: string }[]; cursor?: string };
    expect(page.items).toHaveLength(1);
    expect(page.cursor).toBeDefined();

    const rest = await call(w, "GET", "/projects", undefined, {
      limit: "1",
      cursor: page.cursor ?? "",
    });
    const last = rest.body as { items: { orgId: string }[]; cursor?: string };
    expect(last.items).toHaveLength(1);
    expect(last).not.toHaveProperty("cursor");
    expect([...page.items, ...last.items].every((p) => p.orgId === w.orgId)).toBe(true);
  });

  it("rejects an invalid limit or cursor with 400", async () => {
    const w = await setup();
    expect((await call(w, "GET", "/projects", undefined, { limit: "0" })).status).toBe(400);
    expect((await call(w, "GET", "/projects", undefined, { limit: "abc" })).status).toBe(400);
    const cursor = await call(w, "GET", "/projects", undefined, { cursor: "not-a-cursor" });
    expect(cursor.status).toBe(400);
    expect(errorCode(cursor)).toBe("invalid_cursor");
  });

  it("refuses org-requiring operations for a caller with no membership", async () => {
    const w = await setup();
    const stranger = { sub: nextUserId(w.b) };
    const put = await call(w, "PUT", paths(w.a).project, projectBody(w.a), {}, stranger);
    expect(put.status).toBe(403);
    expect(errorCode(put)).toBe("no_membership");
    const list = await call(w, "GET", "/projects", undefined, {}, stranger);
    expect(errorCode(list)).toBe("no_membership");
  });
});

describe("programs and runs", () => {
  it("requires the project before a program, and the program before a run", async () => {
    const w = await setup();
    const p = paths(w.a);
    expect((await call(w, "PUT", p.program, makeProgramContract(w.a))).status).toBe(404);
    await call(w, "PUT", p.project, projectBody(w.a));
    expect((await call(w, "PUT", p.run, makeRun(w.a))).status).toBe(404);
    expect((await call(w, "PUT", p.program, makeProgramContract(w.a))).status).toBe(201);
    expect((await call(w, "PUT", p.run, makeRun(w.a))).status).toBe(201);
    expect((await call(w, "GET", p.program)).status).toBe(200);
    expect((await call(w, "GET", p.run)).status).toBe(200);
  });

  it("refuses a program or run whose body lies about its chain", async () => {
    const w = await setup();
    await seedRun(w, w.a);
    const p = paths(w.a);
    const program = await call(w, "PUT", p.program, makeProgramContract(w.b));
    expect(program.status).toBe(403);
    expect(errorCode(program)).toBe("ownership_violation");
    const run = await call(w, "PUT", p.run, makeRun(w.a, { programId: w.b.scope.programId }));
    expect(run.status).toBe(403);
  });
});

describe("project isolation", () => {
  it("returns 404 for project B's identifiers under project A's path", async () => {
    const w = await setup();
    await seedRun(w, w.a);
    await seedRun(w, w.b);
    const crossed = `/projects/${w.a.scope.projectId}/programs/${w.b.scope.programId}/runs/${w.b.scope.runId}`;
    expect((await call(w, "GET", crossed)).status).toBe(404);
    expect((await call(w, "GET", `${crossed}/state`)).status).toBe(404);
    expect((await call(w, "GET", `${crossed}/nodes/${w.b.rootNodeId}`)).status).toBe(404);
  });

  it("refuses to write project B's record through project A's path", async () => {
    const w = await setup();
    await seedRun(w, w.a);
    await seedRun(w, w.b);
    const response = await call(
      w,
      "PUT",
      `${paths(w.a).run}/checkpoints/${w.b.ids.next("ckpt")}`,
      makeCheckpoint(w.b, w.b.rootNodeId),
    );
    expect(response.status).toBe(403);
    expect(errorCode(response)).toBe("ownership_violation");
    expect((await w.stores.checkpoints.listByRun(w.a.scope)).items).toHaveLength(0);
  });
});

describe.each([
  { mode: "immediate numbering", deferSequencing: false },
  { mode: "deferred numbering (A-22)", deferSequencing: true },
])("events and run state — $mode", ({ deferSequencing }) => {
  const settle = (w: World) => {
    if (deferSequencing) w.stores.materializeSequences();
  };

  it("appends with 201, returns the stored event, and is idempotent with 200", async () => {
    const w = await setup({ deferSequencing });
    await seedRun(w, w.a);
    const events = `${paths(w.a).run}/events`;

    const first = await call(w, "POST", events, eventBody(w.a, "k1"));
    expect(first.status).toBe(201);
    const appended = first.body as {
      stored: boolean;
      event: { sequence: number | null; recordedAt: string };
    };
    expect(appended.stored).toBe(true);
    expect(appended.event.recordedAt).toBe(NOW);
    expect(appended.event.sequence).toBe(deferSequencing ? null : 0);

    const retry = await call(w, "POST", events, eventBody(w.a, "k1"));
    expect(retry.status).toBe(200);
    expect((retry.body as { stored: boolean }).stored).toBe(false);
    expect((await w.stores.events.listByRun(w.a.scope)).items).toHaveLength(1);
  });

  it("refuses a client sequence, an oversized payload, and a missing run", async () => {
    const w = await setup({ deferSequencing });
    await seedRun(w, w.a);
    const events = `${paths(w.a).run}/events`;
    expect((await call(w, "POST", events, { ...eventBody(w.a, "k"), sequence: 7 })).status).toBe(
      400,
    );
    const oversized = { ...eventBody(w.a, "big"), payload: { blob: "x".repeat(20_000) } };
    expect((await call(w, "POST", events, oversized)).status).toBe(400);
    const missing = await call(w, "POST", `${paths(w.b).run}/events`, eventBody(w.b, "k"));
    expect(missing.status).toBe(404);
  });

  it("lists after a sequence, and rejects a malformed one", async () => {
    const w = await setup({ deferSequencing });
    await seedRun(w, w.a);
    const events = `${paths(w.a).run}/events`;
    for (const key of ["k0", "k1", "k2"]) await call(w, "POST", events, eventBody(w.a, key));
    settle(w);

    const tail = await call(w, "GET", events, undefined, { afterSequence: "0" });
    expect(tail.status).toBe(200);
    expect((tail.body as { items: { sequence: number }[] }).items.map((e) => e.sequence)).toEqual([
      1, 2,
    ]);
    expect((await call(w, "GET", events, undefined, { afterSequence: "-1" })).status).toBe(400);
  });

  it("reports current run state, tolerating unnumbered events", async () => {
    const w = await setup({ deferSequencing });
    await seedRun(w, w.a);
    const run = paths(w.a).run;
    for (const key of ["k0", "k1", "k2"])
      await call(w, "POST", `${run}/events`, eventBody(w.a, key));

    const before = await call(w, "GET", `${run}/state`);
    expect(before.status).toBe(200);
    const state = before.body as {
      run: { runId: string };
      nodes: unknown[];
      highestSequence: number | null;
      pendingEvents: number;
    };
    expect(state.run.runId).toBe(w.a.scope.runId);
    expect(state.nodes).toHaveLength(1);
    expect(state.highestSequence).toBe(deferSequencing ? null : 2);
    expect(state.pendingEvents).toBe(deferSequencing ? 3 : 0);

    settle(w);
    const after = (await call(w, "GET", `${run}/state`)).body as typeof state;
    expect(after.highestSequence).toBe(2);
    expect(after.pendingEvents).toBe(0);
  });
});

describe("recording run-scoped records", () => {
  it("records a decision with create semantics", async () => {
    const w = await setup();
    await seedRun(w, w.a);
    const decision = makeDecision(w.a, w.a.rootNodeId);
    const path = `${paths(w.a).run}/decisions/${decision.decisionId}`;
    expect((await call(w, "PUT", path, decision)).status).toBe(201);
    expect((await call(w, "PUT", path, decision)).status).toBe(200);
    expect((await call(w, "PUT", path, { ...decision, rationale: "Changed." })).status).toBe(409);
  });

  it("refuses an agent overriding a human decision (403)", async () => {
    const w = await setup();
    await seedRun(w, w.a);
    const original = makeDecision(w.a, w.a.rootNodeId, { authority: "human" });
    await call(w, "PUT", `${paths(w.a).run}/decisions/${original.decisionId}`, original);
    const override = makeDecision(w.a, w.a.rootNodeId, {
      authority: "agent",
      supersedesDecisionId: original.decisionId,
    });
    const response = await call(
      w,
      "PUT",
      `${paths(w.a).run}/decisions/${override.decisionId}`,
      override,
    );
    expect(response.status).toBe(403);
    expect(errorCode(response)).toBe("decision_authority");
  });

  it("refuses an override that softens reversibility (409)", async () => {
    const w = await setup();
    await seedRun(w, w.a);
    const original = makeDecision(w.a, w.a.rootNodeId, { reversibility: "irreversible" });
    await call(w, "PUT", `${paths(w.a).run}/decisions/${original.decisionId}`, original);
    const override = makeDecision(w.a, w.a.rootNodeId, {
      authority: "human",
      reversibility: "reversible",
      supersedesDecisionId: original.decisionId,
    });
    const response = await call(
      w,
      "PUT",
      `${paths(w.a).run}/decisions/${override.decisionId}`,
      override,
    );
    expect(response.status).toBe(409);
    expect(errorCode(response)).toBe("reversibility_softened");
  });

  it("requires the superseded decision to exist, and allows superseding it once", async () => {
    const w = await setup();
    await seedRun(w, w.a);
    const run = paths(w.a).run;
    const ghost = makeDecision(w.a, w.a.rootNodeId, {
      authority: "human",
      supersedesDecisionId: w.a.ids.next("dec"),
    });
    expect((await call(w, "PUT", `${run}/decisions/${ghost.decisionId}`, ghost)).status).toBe(404);

    const original = makeDecision(w.a, w.a.rootNodeId);
    await call(w, "PUT", `${run}/decisions/${original.decisionId}`, original);
    const first = makeDecision(w.a, w.a.rootNodeId, {
      authority: "human",
      supersedesDecisionId: original.decisionId,
    });
    expect((await call(w, "PUT", `${run}/decisions/${first.decisionId}`, first)).status).toBe(201);
    expect((await call(w, "PUT", `${run}/decisions/${first.decisionId}`, first)).status).toBe(200);
    const second = makeDecision(w.a, w.a.rootNodeId, {
      authority: "human",
      supersedesDecisionId: original.decisionId,
    });
    const competing = await call(w, "PUT", `${run}/decisions/${second.decisionId}`, second);
    expect(competing.status).toBe(409);
    expect(errorCode(competing)).toBe("conflict");
  });

  it("records a checkpoint, refusing a path identifier that disagrees with the body", async () => {
    const w = await setup();
    await seedRun(w, w.a);
    const checkpoint = makeCheckpoint(w.a, w.a.rootNodeId);
    const run = paths(w.a).run;
    expect(
      (await call(w, "PUT", `${run}/checkpoints/${checkpoint.checkpointId}`, checkpoint)).status,
    ).toBe(201);
    const mismatch = await call(w, "PUT", `${run}/checkpoints/${w.a.ids.next("ckpt")}`, checkpoint);
    expect(mismatch.status).toBe(400);
    expect(errorCode(mismatch)).toBe("identifier_mismatch");
  });

  it("records a verification, and refuses one whose outcome contradicts its exit codes", async () => {
    const w = await setup();
    await seedRun(w, w.a);
    const verification = makeVerification(w.a, makeRootNode(w.a));
    const path = `${paths(w.a).run}/verifications/${verification.verificationId}`;
    expect((await call(w, "PUT", path, verification)).status).toBe(201);
    const lying = {
      ...verification,
      commands: [{ stepId: "test", command: "npm test", exitCode: 1, durationMs: 1 }],
    };
    expect((await call(w, "PUT", path, lying)).status).toBe(400);
  });

  it("records a routing decision with create semantics despite the port having no get", async () => {
    const w = await setup();
    await seedRun(w, w.a);
    const decision = {
      ...(AGGREGATE_EXAMPLES.RoutingDecision as RoutingDecision),
      ...w.a.scope,
      routingDecisionId: w.a.ids.next("route"),
      executionNodeId: w.a.rootNodeId,
    };
    const path = `${paths(w.a).run}/routing-decisions/${decision.routingDecisionId}`;
    expect((await call(w, "PUT", path, decision)).status).toBe(201);
    expect((await call(w, "PUT", path, decision)).status).toBe(200);
    expect((await call(w, "PUT", path, { ...decision, ruleId: "other" })).status).toBe(409);
  });

  it("records an artifact reference and refuses inline content (A-08)", async () => {
    const w = await setup();
    await seedRun(w, w.a);
    const artifact = {
      schemaVersion: 1,
      ...w.a.scope,
      artifactId: w.a.ids.next("art"),
      executionNodeId: w.a.rootNodeId,
      kind: "build-log",
      uri: `s3://bucket/${w.a.scope.projectId}/${w.a.scope.programId}/${w.a.scope.runId}/build.log`,
      sizeBytes: 2048,
      contentType: "text/plain",
      createdAt: NOW,
    };
    const path = `${paths(w.a).run}/artifacts/${artifact.artifactId}`;
    expect((await call(w, "PUT", path, { ...artifact, content: "x" })).status).toBe(400);
    expect((await call(w, "PUT", path, artifact)).status).toBe(201);
  });

  it("requires the run to exist", async () => {
    const w = await setup();
    const checkpoint = makeCheckpoint(w.a, w.a.rootNodeId);
    const response = await call(
      w,
      "PUT",
      `${paths(w.a).run}/checkpoints/${checkpoint.checkpointId}`,
      checkpoint,
    );
    expect(response.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// The P3 additions (T2, D-P3-13)
// ---------------------------------------------------------------------------

describe("job contracts (A-03)", () => {
  it("stores a job contract before execution and reads it back", async () => {
    const w = await setup();
    await seedRun(w, w.a);
    const p = paths(w.a);
    const job = makeJobContract(w.a);

    const created = await call(w, "PUT", `${p.run}/jobs/${job.jobContractId}`, job);
    expect(created.status).toBe(201);
    expect((await call(w, "GET", `${p.run}/jobs/${job.jobContractId}`)).body).toEqual(job);
    expect((await call(w, "PUT", `${p.run}/jobs/${job.jobContractId}`, job)).status).toBe(200);
  });

  it("refuses a different body under the same identifier: a job is immutable", async () => {
    const w = await setup();
    await seedRun(w, w.a);
    const p = paths(w.a);
    const job = makeJobContract(w.a);
    await call(w, "PUT", `${p.run}/jobs/${job.jobContractId}`, job);

    const changed = await call(w, "PUT", `${p.run}/jobs/${job.jobContractId}`, {
      ...job,
      objective: "something else entirely",
    });
    expect(changed.status).toBe(409);
    expect(errorCode(changed)).toBe("conflict");
  });

  it("refuses a body whose identifier disagrees with the path", async () => {
    const w = await setup();
    await seedRun(w, w.a);
    const p = paths(w.a);
    const job = makeJobContract(w.a);
    const other = makeJobContract(w.a);
    const response = await call(w, "PUT", `${p.run}/jobs/${other.jobContractId}`, job);
    expect(response.status).toBe(400);
    expect(errorCode(response)).toBe("identifier_mismatch");
  });

  it("lists a run's job contracts and 404s an absent one", async () => {
    const w = await setup();
    await seedRun(w, w.a);
    const p = paths(w.a);
    const job = makeJobContract(w.a);
    await call(w, "PUT", `${p.run}/jobs/${job.jobContractId}`, job);

    const listed = await call(w, "GET", `${p.run}/jobs`);
    expect(listed.status).toBe(200);
    expect((listed.body as { items: unknown[] }).items).toEqual([job]);
    expect((await call(w, "GET", `${p.run}/jobs/${w.a.ids.next("job")}`)).status).toBe(404);
  });
});

describe("agents (A-04)", () => {
  /** A run with its root node, and an agent bound to that node. */
  const withAgent = async (w: World): Promise<{ readonly agent: Agent; readonly run: string }> => {
    await seedRun(w, w.a);
    const p = paths(w.a);
    const agent = makeAgent(w.a, w.a.rootNodeId, { role: "orchestrator" });
    expect((await call(w, "PUT", `${p.run}/agents/${agent.agentId}`, agent)).status).toBe(201);
    return { agent, run: p.run };
  };

  it("creates the execution identity as created, before anything runs", async () => {
    const w = await setup();
    const { agent, run } = await withAgent(w);
    expect((await call(w, "GET", `${run}/agents/${agent.agentId}`)).body).toEqual(agent);
    expect(agent.status).toBe("created");
  });

  it("refuses an agent bound to a node that does not exist", async () => {
    const w = await setup();
    await seedRun(w, w.a);
    const p = paths(w.a);
    const agent = makeAgent(w.a, w.a.ids.next("node"));
    const response = await call(w, "PUT", `${p.run}/agents/${agent.agentId}`, agent);
    expect(response.status).toBe(404);
    expect(errorCode(response)).toBe("not_found");
  });

  it("applies the agent table: created to started is legal", async () => {
    const w = await setup();
    const { agent, run } = await withAgent(w);
    const started = { ...agent, status: "started" as const, startedAt: NOW };
    expect((await call(w, "PUT", `${run}/agents/${agent.agentId}`, started)).status).toBe(200);
    expect((await call(w, "GET", `${run}/agents/${agent.agentId}`)).body).toEqual(started);
  });

  it("refuses a transition outside the table", async () => {
    const w = await setup();
    const { agent, run } = await withAgent(w);
    // An agent that never started cannot have completed.
    const response = await call(w, "PUT", `${run}/agents/${agent.agentId}`, {
      ...agent,
      status: "completed",
      startedAt: NOW,
      endedAt: NOW,
    });
    expect(response.status).toBe(409);
    expect(errorCode(response)).toBe("illegal_transition");
  });

  it("refuses an ending with no reason, and accepts one with a reason", async () => {
    const w = await setup();
    const { agent, run } = await withAgent(w);
    const started = { ...agent, status: "started" as const, startedAt: NOW };
    await call(w, "PUT", `${run}/agents/${agent.agentId}`, started);

    const silent = await call(w, "PUT", `${run}/agents/${agent.agentId}`, {
      ...started,
      status: "failed",
      endedAt: NOW,
    });
    expect(silent.status).toBe(422);
    expect(errorCode(silent)).toBe("incomplete_record");

    const explained = await call(w, "PUT", `${run}/agents/${agent.agentId}`, {
      ...started,
      status: "failed",
      endedAt: NOW,
      outcomeReason: "the worker process exited 2 without reporting completion",
      exitCode: 2,
    });
    expect(explained.status).toBe(200);
  });

  it("refuses to rewrite the model routing chose", async () => {
    const w = await setup();
    const { agent, run } = await withAgent(w);
    const response = await call(w, "PUT", `${run}/agents/${agent.agentId}`, {
      ...agent,
      status: "started",
      startedAt: NOW,
      model: "some-other-model",
    });
    expect(response.status).toBe(409);
    expect(errorCode(response)).toBe("conflict");
  });

  it("lists the agents of one node", async () => {
    const w = await setup();
    const { agent, run } = await withAgent(w);
    const listed = await call(w, "GET", `${run}/nodes/${w.a.rootNodeId}/agents`);
    expect(listed.status).toBe(200);
    expect((listed.body as { items: unknown[] }).items).toEqual([agent]);
  });
});

describe("run transitions (T2)", () => {
  /** A project, a program and a `pending` run with its root node. */
  const pendingRun = async (w: World) => {
    const p = paths(w.a);
    expect((await call(w, "PUT", p.project, projectBody(w.a))).status).toBe(201);
    expect((await call(w, "PUT", p.program, makeProgramContract(w.a))).status).toBe(201);
    const run = makeRun(w.a, { status: "pending" });
    expect((await call(w, "PUT", p.run, run)).status).toBe(201);
    return { run, p };
  };

  it("moves a pending run to running", async () => {
    const w = await setup();
    const { run, p } = await pendingRun(w);
    const started = { ...run, status: "running" as const };
    expect((await call(w, "PUT", p.run, started)).status).toBe(200);
    expect((await call(w, "GET", p.run)).body).toEqual(started);
  });

  it("refuses a transition outside the table", async () => {
    const w = await setup();
    const { run, p } = await pendingRun(w);
    const response = await call(w, "PUT", p.run, {
      ...run,
      status: "succeeded",
      endedAt: NOW,
    });
    expect(response.status).toBe(409);
    expect(errorCode(response)).toBe("illegal_transition");
  });

  it("requires endedAt on a terminal run and a reason on a non-successful one", async () => {
    const w = await setup();
    const { run, p } = await pendingRun(w);
    const running = { ...run, status: "running" as const };
    await call(w, "PUT", p.run, running);

    const noEnd = await call(w, "PUT", p.run, { ...running, status: "succeeded" });
    expect(noEnd.status).toBe(422);
    expect(errorCode(noEnd)).toBe("incomplete_record");

    const noReason = await call(w, "PUT", p.run, {
      ...running,
      status: "interrupted",
      endedAt: NOW,
    });
    expect(noReason.status).toBe(422);

    const complete = await call(w, "PUT", p.run, {
      ...running,
      status: "interrupted",
      endedAt: NOW,
      outcomeReason: "the MCP server shut down with a worker running",
    });
    expect(complete.status).toBe(200);
  });

  it("refuses to move the root node, the location or the start time", async () => {
    const w = await setup();
    const { run, p } = await pendingRun(w);
    for (const change of [
      { location: "remote" as const },
      { rootNodeId: w.a.ids.next("node") },
      { startedAt: NOW },
    ]) {
      const response = await call(w, "PUT", p.run, { ...run, status: "running", ...change });
      expect(response.status, JSON.stringify(change)).toBe(409);
      expect(errorCode(response)).toBe("conflict");
    }
  });

  it("refuses a change that is not a status move", async () => {
    const w = await setup();
    const { run, p } = await pendingRun(w);
    const response = await call(w, "PUT", p.run, { ...run, outcomeReason: "no reason at all" });
    expect(response.status).toBe(422);
  });

  it("lists a program's runs", async () => {
    const w = await setup();
    const { run, p } = await pendingRun(w);
    const listed = await call(w, "GET", `${p.program}/runs`);
    expect(listed.status).toBe(200);
    expect((listed.body as { items: unknown[] }).items).toEqual([run]);
  });

  it("lists a project's programs", async () => {
    const w = await setup();
    await pendingRun(w);
    const listed = await call(w, "GET", `${paths(w.a).project}/programs`);
    expect(listed.status).toBe(200);
    expect((listed.body as { items: unknown[] }).items).toEqual([makeProgramContract(w.a)]);
  });
});

describe("node and record listings (T2)", () => {
  it("lists a run's nodes and one node's children", async () => {
    const w = await setup();
    await seedRun(w, w.a);
    const p = paths(w.a);
    const child = makeNode(w.a, w.a.rootNodeId, { status: "validated" });
    expect((await call(w, "PUT", `${p.run}/nodes/${child.executionNodeId}`, child)).status).toBe(
      201,
    );

    const all = await call(w, "GET", `${p.run}/nodes`);
    expect(
      (all.body as { items: { executionNodeId: string }[] }).items
        .map((n) => n.executionNodeId)
        .sort(),
    ).toEqual([w.a.rootNodeId, child.executionNodeId].sort());

    const children = await call(w, "GET", `${p.run}/nodes/${w.a.rootNodeId}/children`);
    expect((children.body as { items: unknown[] }).items).toEqual([child]);
    expect(
      (
        (await call(w, "GET", `${p.run}/nodes/${child.executionNodeId}/children`)).body as {
          items: unknown[];
        }
      ).items,
    ).toEqual([]);
  });

  it("reads and lists decisions, checkpoints and artifacts", async () => {
    const w = await setup();
    await seedRun(w, w.a);
    const p = paths(w.a);
    const checkpoint = makeCheckpoint(w.a, w.a.rootNodeId);
    await call(w, "PUT", `${p.run}/checkpoints/${checkpoint.checkpointId}`, checkpoint);
    const decision = makeDecision(w.a, w.a.rootNodeId, {
      checkpointBefore: checkpoint.checkpointId,
    });
    await call(w, "PUT", `${p.run}/decisions/${decision.decisionId}`, decision);
    const artifact = {
      schemaVersion: 1,
      ...w.a.scope,
      artifactId: w.a.ids.next("art"),
      executionNodeId: w.a.rootNodeId,
      kind: "verification-log",
      uri: "s3://bucket/key",
      sizeBytes: 12,
      contentType: "text/plain",
      createdAt: NOW,
    };
    await call(w, "PUT", `${p.run}/artifacts/${artifact.artifactId}`, artifact);

    expect((await call(w, "GET", `${p.run}/decisions/${decision.decisionId}`)).body).toEqual(
      decision,
    );
    expect((await call(w, "GET", `${p.run}/checkpoints/${checkpoint.checkpointId}`)).body).toEqual(
      checkpoint,
    );
    expect((await call(w, "GET", `${p.run}/artifacts/${artifact.artifactId}`)).body).toEqual(
      artifact,
    );
    for (const collection of ["decisions", "checkpoints", "artifacts"]) {
      const listed = await call(w, "GET", `${p.run}/${collection}`);
      expect((listed.body as { items: unknown[] }).items, collection).toHaveLength(1);
    }
  });

  it("reads a verification by id and lists a node's verifications and routing decisions", async () => {
    const w = await setup();
    await seedRun(w, w.a);
    const p = paths(w.a);
    const node = makeRootNode(w.a);
    const verification = makeVerification(w.a, node);
    await call(w, "PUT", `${p.run}/verifications/${verification.verificationId}`, verification);
    const routing: RoutingDecision = {
      schemaVersion: 1,
      ...w.a.scope,
      routingDecisionId: w.a.ids.next("route"),
      executionNodeId: w.a.rootNodeId,
      attempt: 1,
      eligibleOptions: [
        { target: { harness: "claude", provider: "anthropic", model: "m" }, eligible: true },
      ],
      chosen: { harness: "claude", provider: "anthropic", model: "m" },
      ruleId: "p3-fixed",
      wasOverride: false,
      usage: {},
      outcome: "pending",
      previousRouteId: null,
      createdAt: NOW,
    };
    await call(w, "PUT", `${p.run}/routing-decisions/${routing.routingDecisionId}`, routing);

    expect(
      (await call(w, "GET", `${p.run}/verifications/${verification.verificationId}`)).body,
    ).toEqual(verification);
    expect(
      (
        (await call(w, "GET", `${p.run}/nodes/${w.a.rootNodeId}/verifications`)).body as {
          items: unknown[];
        }
      ).items,
    ).toEqual([verification]);
    expect(
      (
        (await call(w, "GET", `${p.run}/nodes/${w.a.rootNodeId}/routing-decisions`)).body as {
          items: unknown[];
        }
      ).items,
    ).toEqual([routing]);
  });
});

describe("examinations (port completeness; nothing in P3 writes one)", () => {
  it("round trips an examination and lists it by node", async () => {
    const w = await setup();
    await seedRun(w, w.a);
    const p = paths(w.a);
    const node = makeRootNode(w.a);
    const verification = makeVerification(w.a, node);
    await call(w, "PUT", `${p.run}/verifications/${verification.verificationId}`, verification);

    const examination = {
      schemaVersion: 1,
      ...w.a.scope,
      examinationId: w.a.ids.next("exam"),
      executionNodeId: w.a.rootNodeId,
      verificationId: verification.verificationId,
      commitSha: verification.commitSha,
      implementerAgentId: w.a.ids.next("agent"),
      examinerAgentId: w.a.ids.next("agent"),
      requiredByRisk: "high",
      outcome: "passed",
      findings: [],
      createdAt: NOW,
    };
    const created = await call(
      w,
      "PUT",
      `${p.run}/examinations/${examination.examinationId}`,
      examination,
    );
    expect(created.status).toBe(201);
    expect(
      (await call(w, "GET", `${p.run}/examinations/${examination.examinationId}`)).body,
    ).toEqual(examination);
    expect(
      (
        (await call(w, "GET", `${p.run}/nodes/${w.a.rootNodeId}/examinations`)).body as {
          items: unknown[];
        }
      ).items,
    ).toEqual([examination]);
  });

  it("refuses an agent examining its own work, through the contract's own rule", async () => {
    const w = await setup();
    await seedRun(w, w.a);
    const p = paths(w.a);
    const agentId = w.a.ids.next("agent");
    const examinationId = w.a.ids.next("exam");
    const response = await call(w, "PUT", `${p.run}/examinations/${examinationId}`, {
      schemaVersion: 1,
      ...w.a.scope,
      examinationId,
      executionNodeId: w.a.rootNodeId,
      verificationId: w.a.ids.next("ver"),
      commitSha: "1111111111111111111111111111111111111111",
      implementerAgentId: agentId,
      examinerAgentId: agentId,
      requiredByRisk: "high",
      outcome: "passed",
      findings: [],
      createdAt: NOW,
    });
    expect(response.status).toBe(400);
    expect(errorCode(response)).toBe("validation_failed");
  });
});

describe("the presigned artifact upload (A-08)", () => {
  it("signs a PUT under the run's own prefix and returns the s3 URI", async () => {
    const w = await setup();
    await seedRun(w, w.a);
    const p = paths(w.a);
    const artifactId = w.a.ids.next("art");

    const response = await call(w, "POST", `${p.run}/artifacts/${artifactId}/upload-url`, {
      kind: "verification-log",
      contentType: "text/plain",
      sizeBytes: 4096,
    });
    expect(response.status).toBe(200);
    const target = ArtifactUploadResponseSchema.parse(response.body);
    expect(target.artifactId).toBe(artifactId);
    expect(target.key).toBe(
      `${w.a.scope.projectId}/${w.a.scope.programId}/${w.a.scope.runId}/${artifactId}`,
    );
    expect(target.uri).toBe(`s3://bucket/${target.key}`);
    expect(target.contentType).toBe("text/plain");

    // The chain the signer saw came from the path, never from the body (A-23).
    expect(w.signed).toHaveLength(1);
    expect(w.signed[0]?.scope).toEqual(w.a.scope);
    expect(w.signed[0]?.sizeBytes).toBe(4096);
  });

  it("creates no Artifact record: the reference follows the bytes", async () => {
    const w = await setup();
    await seedRun(w, w.a);
    const p = paths(w.a);
    const artifactId = w.a.ids.next("art");
    await call(w, "POST", `${p.run}/artifacts/${artifactId}/upload-url`, {
      kind: "verification-log",
      contentType: "text/plain",
      sizeBytes: 1,
    });
    expect((await call(w, "GET", `${p.run}/artifacts/${artifactId}`)).status).toBe(404);
  });

  it("refuses to sign for a run that does not exist", async () => {
    const w = await setup();
    const p = paths(w.a);
    const response = await call(w, "POST", `${p.run}/artifacts/${w.a.ids.next("art")}/upload-url`, {
      kind: "other",
      contentType: "text/plain",
      sizeBytes: 1,
    });
    expect(response.status).toBe(404);
  });

  it("refuses a body larger than a single S3 PUT can carry", async () => {
    const w = await setup();
    await seedRun(w, w.a);
    const p = paths(w.a);
    const response = await call(w, "POST", `${p.run}/artifacts/${w.a.ids.next("art")}/upload-url`, {
      kind: "other",
      contentType: "application/octet-stream",
      sizeBytes: 6 * 1024 * 1024 * 1024,
    });
    expect(response.status).toBe(400);
    expect(errorCode(response)).toBe("validation_failed");
  });

  it("says so plainly when the control plane was wired without a signer", async () => {
    const w = await setup();
    await seedRun(w, w.a);
    const p = paths(w.a);
    const { uploads: _uploads, ...withoutSigner } = w.deps;
    const response = await handleRequest(withoutSigner, {
      method: "POST",
      path: `${p.run}/artifacts/${w.a.ids.next("art")}/upload-url`,
      query: {},
      body: { kind: "other", contentType: "text/plain", sizeBytes: 1 },
      claims: w.claims,
    });
    expect(response.status).toBe(501);
    expect(errorCode(response)).toBe("uploads_unavailable");
  });
});
