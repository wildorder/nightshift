/**
 * `@nightshift/persistence/http` against the real control plane (T3).
 *
 * The adapter drives the **production handler** over a loopback socket, with the
 * in-memory stores behind it and deferred sequence numbering, so every route,
 * every schema and every domain rule is in the loop. Nothing here is mocked
 * except the identity the API Gateway authorizer would have validated.
 *
 * ## Why this is not `describePortConformance`
 *
 * T3 asked for the P1 port-conformance suite, run against this adapter. It
 * cannot be, and the reason is worth stating because it is a property of the
 * design rather than a gap in the adapter.
 *
 * The conformance suite specifies a **storage** port: it writes a program
 * contract without a project, an event without a run, and a project into any
 * organisation it likes, because a store is a place records go. The control-plane
 * API is a **domain** surface layered on top of that store, and it deliberately
 * refuses all three — referential integrity (`requireProject`, `requireRun`),
 * the execution-tree and transition rules, and D-P2-13's rule that the acting
 * organisation comes from the caller's validated token and never from a payload.
 * An adapter over the API therefore cannot satisfy a suite that writes records
 * without their parents, and that is the API being right.
 *
 * T3's own note anticipates this case: "either a route is missing or wrong (fix
 * T2) or the suite predates a real change (a conversation)." This is the latter,
 * and the conversation is recorded in the contract §12.
 *
 * So this file does the job the conformance suite would have done, in the order
 * the domain permits: **every** method of every project-scoped port is exercised
 * against the real handler, and `afterAll` fails if any method was not. A port
 * method added without a test here fails that check rather than going unproven.
 */
import type {
  Agent,
  Artifact,
  Checkpoint,
  Decision,
  ExecutionRole,
  GateHealth,
  JobContract,
  OrgId,
  Principal,
  Project,
  RoutingDecision,
  Run,
  UserId,
  Verification,
} from "@nightshift/contracts";
import { DEFAULT_EXAMINATION_POLICY, DEFAULT_ROUTING_POLICY } from "@nightshift/contracts";
import {
  createFixedClock,
  createFixtures,
  type Fixtures,
  type IdentityStores,
  IllegalTransitionError,
  isSequenced,
  makeAgent,
  makeCheckpoint,
  makeComputeUtilization,
  makeDecision,
  makeDispatch,
  makeEvent,
  makeGateHealth,
  makeJobContract,
  makeMembership,
  makeNode,
  makeProgramContract,
  makeProject,
  makeRootNode,
  makeRun,
  makeVerification,
  makeWarmCache,
  nextUserId,
  type ProjectStores,
  rejectionOf,
  StaleWriteError,
} from "@nightshift/core";
import {
  ControlPlaneError,
  createFetchTransport,
  createHttpArtifactBodyStore,
  createHttpStores,
  routes,
  send,
  staticTokenProvider,
  type Transport,
} from "@nightshift/persistence/http";
import { createInMemoryStores, type InMemoryStores } from "@nightshift/persistence/memory";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RequestPrincipal } from "./auth/principal.js";
import {
  encodeTestPrincipal,
  type LocalControlPlane,
  startLocalControlPlane,
} from "./testing/local-control-plane.js";

const NOW = "2026-09-15T12:00:00.000Z";

/**
 * Every method of every project-scoped port.
 *
 * Declared, not derived, so that adding a method to a port and forgetting to
 * prove it over HTTP fails the completeness check below rather than passing
 * unnoticed.
 */
const PORT_METHODS = {
  projects: ["put", "get", "listByOrg"],
  programContracts: ["put", "get", "listByProject", "update"],
  runs: ["put", "get", "listByProgram"],
  executionNodes: ["put", "get", "listByRun", "listChildren"],
  jobContracts: ["put", "get", "listByRun"],
  agents: ["put", "get", "listByNode"],
  events: ["append", "listByRun", "nextSequence"],
  decisions: ["put", "get", "listByRun"],
  checkpoints: ["put", "get", "listByRun"],
  verifications: ["put", "get", "listByNode"],
  examinations: ["put", "get", "listByNode"],
  routingDecisions: ["put", "listByNode"],
  artifacts: ["put", "get", "listByRun"],
  orgConfigs: ["get", "put"],
  // P10: the control plane owns these records; the adapter reads them and names
  // the route that writes them when asked to write one whole.
  dispatches: ["put", "get", "listByStatus"],
  installationClaims: ["claim", "release"],
  computeUtilizations: ["put", "get", "listByProject"],
  warmCaches: ["put", "get", "delete"],
  // P15: written whole by the operator or the engine, so it has a write route.
  gateHealth: ["put", "get"],
} as const satisfies Record<keyof ProjectStores, readonly string[]>;

/** `store.method` for every entry above. */
const everyPortMethod = (): readonly string[] =>
  Object.entries(PORT_METHODS).flatMap(([store, methods]) =>
    methods.map((method) => `${store}.${method}`),
  );

/** What this file has actually called, accumulated across every test. */
const exercised = new Set<string>();

/** Wraps the stores so each call records itself. Behaviour is unchanged. */
const recording = (stores: ProjectStores): ProjectStores =>
  Object.fromEntries(
    Object.entries(stores).map(([name, store]) => [
      name,
      Object.fromEntries(
        Object.entries(store as Record<string, (...args: never[]) => unknown>).map(
          ([method, implementation]) => [
            method,
            (...args: never[]) => {
              exercised.add(`${name}.${method}`);
              return implementation(...args);
            },
          ],
        ),
      ),
    ]),
  ) as unknown as ProjectStores;

interface World {
  readonly plane: LocalControlPlane;
  readonly backing: InMemoryStores;
  readonly http: ProjectStores;
  readonly transport: Transport;
  readonly bodies: ReturnType<typeof createHttpArtifactBodyStore>;
  readonly f: Fixtures;
  readonly orgId: OrgId;
  /** The signed-in member the session acts as. */
  readonly subject: UserId;
  /** Numbers every event appended so far, imitating the Streams consumer (A-22). */
  settle(): void;
}

let world: World;

beforeEach(async () => {
  // Deferred numbering, so the adapter is held to the real timing: `append`
  // answers with an event whose `sequence` is still null (A-22), and the
  // assertions about numbering run only after the materializer has caught up.
  const backing = createInMemoryStores({ deferSequencing: true });
  const f = createFixtures();
  const subject = nextUserId(f);
  const orgId = f.ids.next("org");
  const identity: IdentityStores = backing;
  await identity.memberships.put(makeMembership(subject, orgId));

  const plane = await startLocalControlPlane({
    stores: backing,
    principal: { kind: "user", userId: subject, activeOrg: orgId },
    clock: createFixedClock(Date.parse(NOW)),
  });
  const transport = createFetchTransport({
    endpoint: plane.url,
    // The plane ignores the header; a provider is still required, and this is
    // the shape a script with a machine token uses.
    tokens: staticTokenProvider("ignored-by-the-local-plane"),
  });
  world = {
    plane,
    backing,
    transport,
    http: recording(createHttpStores({ transport, actingOrg: orgId })),
    bodies: createHttpArtifactBodyStore({ transport }),
    f,
    orgId,
    subject,
    settle: () => void backing.materializeSequences(),
  };
});

afterEach(async () => {
  await world.plane.close();
});

afterAll(() => {
  const missed = everyPortMethod().filter((method) => !exercised.has(method));
  expect(
    missed,
    `these port methods are never driven over HTTP by this file: ${missed.join(", ")}`,
  ).toEqual([]);
});

/** A project in the acting org, so the API stores what the caller meant. */
const aProject = (f: Fixtures, overrides: Record<string, unknown> = {}): Project =>
  makeProject(f, { orgId: world.orgId, ...overrides });

/**
 * The domain order: a project, then its program, then a run, then the run's root
 * node. Writing out of order is refused by the API, which is the point.
 */
const seed = async () => {
  const { http, f } = world;
  const project = aProject(f);
  await http.projects.put(project);
  const program = makeProgramContract(f);
  await http.programContracts.put(program);
  const run = makeRun(f, { status: "pending" });
  await http.runs.put(run);
  const root = makeRootNode(f, { status: "validated" });
  await http.executionNodes.put(root);
  return { project, program, run, root };
};

describe("projects", () => {
  it("round trips a project in the acting organisation", async () => {
    const { project } = await seed();
    expect(await world.http.projects.get(project.projectId)).toEqual(project);
  });

  it("answers undefined for an absent project rather than throwing", async () => {
    expect(await world.http.projects.get(world.f.ids.next("proj"))).toBeUndefined();
  });

  /**
   * D-P2-13: the org comes from the validated token. A caller cannot place a
   * project in an org it does not act for, so the stored record carries the
   * acting org — not the one the caller put on the record.
   */
  it("stores a project in the token's organisation, whatever the record said", async () => {
    const elsewhere = makeProject(world.f, { orgId: world.f.ids.next("org") });
    await world.http.projects.put(elsewhere);
    expect((await world.http.projects.get(elsewhere.projectId))?.orgId).toBe(world.orgId);
  });

  it("lists the acting organisation's projects", async () => {
    const { project } = await seed();
    const listed = await world.http.projects.listByOrg(world.orgId);
    expect(listed.items.map((p) => p.projectId)).toEqual([project.projectId]);
  });

  it("answers an empty page for an organisation this session does not act for", async () => {
    await seed();
    const listed = await world.http.projects.listByOrg(world.f.ids.next("org"));
    expect(listed.items).toEqual([]);
  });
});

describe("programs and runs", () => {
  it("round trips a program contract and lists a project's programs", async () => {
    const { program, project } = await seed();
    expect(await world.http.programContracts.get(project.projectId, program.programId)).toEqual(
      program,
    );
    const listed = await world.http.programContracts.listByProject(project.projectId);
    expect(listed.items).toEqual([program]);
  });

  it("round trips a run, moves it through the table, and lists a program's runs", async () => {
    const { run } = await seed();
    expect(await world.http.runs.get(run, run.runId)).toEqual(run);

    const running: Run = { ...run, status: "running" };
    await world.http.runs.put(running);
    expect((await world.http.runs.get(run, run.runId))?.status).toBe("running");

    const listed = await world.http.runs.listByProgram(run);
    expect(listed.items).toEqual([running]);
  });

  it("answers undefined for a run that does not exist", async () => {
    const { project, program } = await seed();
    expect(
      await world.http.runs.get(
        { projectId: project.projectId, programId: program.programId },
        world.f.ids.next("run"),
      ),
    ).toBeUndefined();
  });
});

describe("execution nodes", () => {
  it("round trips the root node and lists a run's nodes", async () => {
    const { root } = await seed();
    expect(await world.http.executionNodes.get(root, root.executionNodeId)).toEqual(root);
    const listed = await world.http.executionNodes.listByRun(root);
    expect(listed.items).toEqual([root]);
  });

  it("lists one node's children, and an empty list for a leaf", async () => {
    const { root } = await seed();
    const child = makeNode(world.f, root.executionNodeId, { status: "validated" });
    await world.http.executionNodes.put(child);

    expect(await world.http.executionNodes.listChildren(root, root.executionNodeId)).toEqual([
      child,
    ]);
    expect(await world.http.executionNodes.listChildren(root, child.executionNodeId)).toEqual([]);
  });

  it("answers undefined for a node in another run, even by exact identifier", async () => {
    const { root } = await seed();
    expect(
      await world.http.executionNodes.get(
        { ...root, runId: world.f.ids.next("run") },
        root.executionNodeId,
      ),
    ).toBeUndefined();
  });
});

describe("job contracts and agents", () => {
  const withJobAndAgent = async () => {
    const seeded = await seed();
    const job: JobContract = makeJobContract(world.f);
    await world.http.jobContracts.put(job);
    const agent: Agent = makeAgent(world.f, seeded.root.executionNodeId);
    await world.http.agents.put(agent);
    return { ...seeded, job, agent };
  };

  it("round trips a job contract and lists a run's job contracts", async () => {
    const { job } = await withJobAndAgent();
    expect(await world.http.jobContracts.get(job, job.jobContractId)).toEqual(job);
    expect((await world.http.jobContracts.listByRun(job)).items).toEqual([job]);
  });

  it("answers undefined for an absent job contract", async () => {
    await seed();
    expect(
      await world.http.jobContracts.get(world.f.scope, world.f.ids.next("job")),
    ).toBeUndefined();
  });

  it("round trips an agent, moves it through the table, and lists a node's agents", async () => {
    const { agent, root } = await withJobAndAgent();
    expect(await world.http.agents.get(agent, agent.agentId)).toEqual(agent);

    const started: Agent = { ...agent, status: "started", startedAt: NOW };
    await world.http.agents.put(started);
    expect((await world.http.agents.get(agent, agent.agentId))?.status).toBe("started");

    expect(await world.http.agents.listByNode(agent, root.executionNodeId)).toEqual([started]);
  });

  it("answers undefined for an absent agent", async () => {
    await seed();
    expect(await world.http.agents.get(world.f.scope, world.f.ids.next("agent"))).toBeUndefined();
  });
});

describe("events", () => {
  it("appends, tolerating an unnumbered answer, and numbers later (A-22)", async () => {
    await seed();
    const event = makeEvent(world.f, { idempotencyKey: "k-1" });

    const result = await world.http.events.append(event);
    expect(result.stored).toBe(true);
    // Durable but not yet numbered: the whole point of A-22, carried over HTTP.
    expect(isSequenced(result.event)).toBe(false);
    expect(await world.http.events.nextSequence(world.f.scope)).toBe(0);

    world.settle();
    const listed = await world.http.events.listByRun(world.f.scope);
    expect(listed.items.map((e) => e.sequence)).toEqual([0]);
    expect(await world.http.events.nextSequence(world.f.scope)).toBe(1);
  });

  it("stores one event for a repeated idempotency key", async () => {
    await seed();
    const event = makeEvent(world.f, { idempotencyKey: "repeated" });
    const first = await world.http.events.append(event);
    const second = await world.http.events.append({ ...event, eventId: world.f.ids.next("evt") });

    expect(second.stored).toBe(false);
    expect(second.event.eventId).toBe(first.event.eventId);
    world.settle();
    expect((await world.http.events.listByRun(world.f.scope)).items).toHaveLength(1);
  });

  it("passes afterSequence through, so a reader can resume", async () => {
    await seed();
    for (let i = 0; i < 4; i += 1) {
      await world.http.events.append(makeEvent(world.f, { idempotencyKey: `burst-${i}` }));
    }
    world.settle();

    const after = await world.http.events.listByRun(world.f.scope, { afterSequence: 1 });
    expect(after.items.map((e) => e.sequence)).toEqual([2, 3]);
  });

  it("pages, passing the opaque cursor through unchanged", async () => {
    await seed();
    for (let i = 0; i < 5; i += 1) {
      await world.http.events.append(makeEvent(world.f, { idempotencyKey: `page-${i}` }));
    }
    world.settle();

    const seen: number[] = [];
    let cursor: string | undefined;
    do {
      const page = await world.http.events.listByRun(
        world.f.scope,
        cursor === undefined ? { limit: 2 } : { limit: 2, cursor },
      );
      seen.push(...page.items.filter(isSequenced).map((e) => e.sequence));
      cursor = page.cursor;
    } while (cursor !== undefined);
    expect(seen).toEqual([0, 1, 2, 3, 4]);
  });
});

describe("decisions, checkpoints, verifications, examinations and routing", () => {
  it("round trips a checkpoint and a decision, and lists both", async () => {
    const { root } = await seed();
    const checkpoint: Checkpoint = makeCheckpoint(world.f, root.executionNodeId);
    await world.http.checkpoints.put(checkpoint);
    const decision: Decision = makeDecision(world.f, root.executionNodeId, {
      checkpointBefore: checkpoint.checkpointId,
    });
    await world.http.decisions.put(decision);

    expect(await world.http.checkpoints.get(checkpoint, checkpoint.checkpointId)).toEqual(
      checkpoint,
    );
    expect(await world.http.decisions.get(decision, decision.decisionId)).toEqual(decision);
    expect((await world.http.checkpoints.listByRun(checkpoint)).items).toEqual([checkpoint]);
    expect((await world.http.decisions.listByRun(decision)).items).toEqual([decision]);
  });

  it("round trips a verification and lists a node's verifications", async () => {
    const { root } = await seed();
    const verification: Verification = makeVerification(world.f, root);
    await world.http.verifications.put(verification);

    expect(await world.http.verifications.get(verification, verification.verificationId)).toEqual(
      verification,
    );
    expect(await world.http.verifications.listByNode(verification, root.executionNodeId)).toEqual([
      verification,
    ]);
  });

  it("round trips an examination (P8)", async () => {
    const { root } = await seed();
    const verification = makeVerification(world.f, root);
    await world.http.verifications.put(verification);

    const examination = {
      schemaVersion: 1 as const,
      ...world.f.scope,
      examinationId: world.f.ids.next("exam"),
      executionNodeId: root.executionNodeId,
      verificationId: verification.verificationId,
      commitSha: verification.commitSha,
      patchId: "0".repeat(40),
      implementerAgentId: world.f.ids.next("agent"),
      examinerAgentId: world.f.ids.next("agent"),
      examinerRoute: { harness: "codex", provider: "openai", model: "gpt-6-sol" },
      requiredByRisk: "high" as const,
      blocking: true,
      fixAttempt: 0,
      questions: [],
      outcome: "passed" as const,
      findings: [],
      createdAt: NOW,
    };
    await world.http.examinations.put(examination);
    expect(await world.http.examinations.get(examination, examination.examinationId)).toEqual(
      examination,
    );
    expect(await world.http.examinations.listByNode(examination, root.executionNodeId)).toEqual([
      examination,
    ]);
  });

  it("round trips an org's configuration, and refuses a stale write (P8, D-P8-02)", async () => {
    expect(await world.http.orgConfigs.get(world.orgId)).toBeUndefined();
    const first = {
      schemaVersion: 1 as const,
      orgId: world.orgId,
      routingPolicy: DEFAULT_ROUTING_POLICY,
      examinationPolicy: DEFAULT_EXAMINATION_POLICY,
      installations: [],
      version: 1,
      updatedAt: NOW,
    };
    await world.http.orgConfigs.put(first);
    const stored = await world.http.orgConfigs.get(world.orgId);
    expect(stored?.version).toBe(1);
    expect(stored?.routingPolicy).toEqual(DEFAULT_ROUTING_POLICY);
    // Another writer read version 0 too: refused, and nothing changes.
    await expect(world.http.orgConfigs.put(first)).rejects.toBeInstanceOf(StaleWriteError);
    await world.http.orgConfigs.put({ ...first, version: 2 });
    expect((await world.http.orgConfigs.get(world.orgId))?.version).toBe(2);
  });

  it("round trips a routing decision and lists a node's routing decisions", async () => {
    const { root } = await seed();
    const routing: RoutingDecision = {
      schemaVersion: 1,
      ...world.f.scope,
      routingDecisionId: world.f.ids.next("route"),
      executionNodeId: root.executionNodeId,
      attempt: 1,
      eligibleOptions: [
        {
          target: { harness: "claude", provider: "anthropic", model: "claude-sonnet-5" },
          eligible: true,
        },
      ],
      chosen: { harness: "claude", provider: "anthropic", model: "claude-sonnet-5" },
      ruleId: "p3-fixed",
      wasOverride: false,
      usage: {},
      outcome: "pending",
      previousRouteId: null,
      createdAt: NOW,
    };
    await world.http.routingDecisions.put(routing);
    expect(await world.http.routingDecisions.listByNode(routing, root.executionNodeId)).toEqual([
      routing,
    ]);
  });
});

describe("artifacts and their bodies", () => {
  it("uploads a body through a signed URL, then records the reference (A-08)", async () => {
    const { root } = await seed();
    const artifactId = world.f.ids.next("art");
    const body = "step test: node --test\nok 1 - median\n";

    const stored = await world.bodies.put(world.f.scope, artifactId, body, "text/plain");

    expect(stored.key).toBe(
      `${world.f.scope.projectId}/${world.f.scope.programId}/${world.f.scope.runId}/${artifactId}`,
    );
    expect(stored.uri).toBe(`s3://nightshift-local/${stored.key}`);
    expect(stored.sizeBytes).toBe(Buffer.byteLength(body));
    // The bytes really landed, and the plane checked the type and the length the
    // way S3 does.
    expect(world.plane.bodies.text(stored.key)).toBe(body);

    const artifact: Artifact = {
      schemaVersion: 1,
      ...world.f.scope,
      artifactId,
      executionNodeId: root.executionNodeId,
      kind: "verification-log",
      uri: stored.uri,
      sizeBytes: stored.sizeBytes,
      contentType: "text/plain",
      sha256: stored.sha256,
      createdAt: NOW,
    };
    await world.http.artifacts.put(artifact);
    expect(await world.http.artifacts.get(artifact, artifactId)).toEqual(artifact);
    expect((await world.http.artifacts.listByRun(artifact)).items).toEqual([artifact]);
  });

  it("computes the digest the Artifact record will carry", async () => {
    await seed();
    const { createHash } = await import("node:crypto");
    const stored = await world.bodies.put(
      world.f.scope,
      world.f.ids.next("art"),
      "hello log",
      "text/plain",
    );
    expect(stored.sha256).toBe(createHash("sha256").update("hello log").digest("hex"));
  });

  it("says plainly that it cannot read a body without a reader", async () => {
    await seed();
    const artifactId = world.f.ids.next("art");
    await world.bodies.put(world.f.scope, artifactId, "x", "text/plain");
    // There is no download route by design; a caller that must read supplies one.
    await expect(world.bodies.get(world.f.scope, artifactId)).rejects.toThrow(
      /serves no download route/,
    );
  });

  it("reads a body back through a download URL the control plane signs (P11, D-P11-06)", async () => {
    const { root } = await seed();
    const artifactId = world.f.ids.next("art");
    const stored = await world.bodies.put(world.f.scope, artifactId, "signed read", "text/plain");
    const artifact: Artifact = {
      schemaVersion: 1,
      ...world.f.scope,
      artifactId,
      executionNodeId: root.executionNodeId,
      kind: "transcript",
      uri: stored.uri,
      sizeBytes: stored.sizeBytes,
      contentType: "text/plain",
      sha256: stored.sha256,
      createdAt: NOW,
    };
    await world.http.artifacts.put(artifact);

    // The client's copy of the route, driven against the real handler.
    const target = (await send(
      world.transport,
      { method: "POST", path: routes.artifactDownloadUrl(world.f.scope, artifactId) },
      [200],
    )) as { url: string; expiresAt: string };
    expect(target.url).toContain(world.plane.url);
    expect(Date.parse(target.expiresAt)).toBeGreaterThan(Date.parse(NOW));

    // The bytes come from the signed URL, with the type the upload pinned, and
    // never through a Nightshift route.
    const response = await fetch(target.url);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain");
    expect(await response.text()).toBe("signed read");

    // A signature is for one artifact whose record exists: an unrecorded one is
    // refused before anything is signed.
    await expect(
      send(
        world.transport,
        {
          method: "POST",
          path: routes.artifactDownloadUrl(world.f.scope, world.f.ids.next("art")),
        },
        [200],
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("reads a body back through the reader it was given", async () => {
    await seed();
    const artifactId = world.f.ids.next("art");
    const stored = await world.bodies.put(world.f.scope, artifactId, "readable", "text/plain");
    const readable = createHttpArtifactBodyStore({
      transport: world.transport,
      read: async () => world.plane.bodies.get(stored.key)?.body,
    });
    expect(new TextDecoder().decode(await readable.get(world.f.scope, artifactId))).toBe(
      "readable",
    );
  });
});

describe("refusals come back typed", () => {
  it("turns an illegal transition into IllegalTransitionError", async () => {
    const { root } = await seed();
    const agent = makeAgent(world.f, root.executionNodeId);
    await world.http.agents.put(agent);
    await world.http.agents.put({ ...agent, status: "started", startedAt: NOW });

    const failure = await rejectionOf(world.http.agents.put(agent));
    expect(failure).toBeInstanceOf(IllegalTransitionError);
  });

  it("turns a validation failure into ControlPlaneError 400, with the issues", async () => {
    const { project, program } = await seed();
    const failure = await rejectionOf(
      send(world.transport, {
        method: "PUT",
        path: routes.program(project.projectId, program.programId),
        body: { schemaVersion: 1 },
      }),
    );

    expect(failure).toBeInstanceOf(ControlPlaneError);
    const refusal = failure as ControlPlaneError;
    expect(refusal.status).toBe(400);
    expect(refusal.code).toBe("validation_failed");
    expect(refusal.issues?.length ?? 0).toBeGreaterThan(0);
  });

  it("refuses a record whose parents do not exist, rather than storing an orphan", async () => {
    // No project, no program: the API says so and the adapter passes it through.
    const failure = await rejectionOf(world.http.runs.put(makeRun(world.f)));
    expect(failure).toBeInstanceOf(ControlPlaneError);
    expect((failure as ControlPlaneError).status).toBe(404);
  });
});

describe("what the adapter is, structurally", () => {
  it("talks to nothing but the loopback control plane", () => {
    expect(world.plane.url.startsWith("http://127.0.0.1:")).toBe(true);
  });

  it("implements exactly the project-scoped ports, and no identity store", () => {
    expect(Object.keys(world.http).sort()).toEqual(Object.keys(PORT_METHODS).sort());
    expect(Object.keys(world.http)).not.toContain("users");
    expect(Object.keys(world.http)).not.toContain("memberships");
  });

  it("implements every method each port declares", () => {
    for (const [store, methods] of Object.entries(PORT_METHODS)) {
      const implemented = Object.keys(world.http[store as keyof ProjectStores]).sort();
      expect(implemented, store).toEqual([...methods].sort());
    }
  });
});

describe("the remote runner's records (P10)", () => {
  it("reads a run's dispatch and utilization and a project's warm cache, undefined when absent", async () => {
    const { http, f, backing } = world;
    await seed();
    expect(await http.dispatches.get(f.scope)).toBeUndefined();
    expect(await http.computeUtilizations.get(f.scope)).toBeUndefined();
    expect(await http.warmCaches.get(f.scope.projectId, "x86_64")).toBeUndefined();
    const dispatch = makeDispatch(f);
    await backing.dispatches.put(dispatch);
    await backing.computeUtilizations.put(makeComputeUtilization(f));
    await backing.warmCaches.put(makeWarmCache(f));
    expect(await http.dispatches.get(f.scope)).toEqual(dispatch);
    expect(await http.computeUtilizations.get(f.scope)).toEqual(makeComputeUtilization(f));
    expect(await http.warmCaches.get(f.scope.projectId, "x86_64")).toEqual(makeWarmCache(f));
  });

  it("refuses to write one whole, naming the route that does", async () => {
    const { http, f } = world;
    await expect(http.dispatches.put(makeDispatch(f))).rejects.toThrow(/dispatch/);
    // The cross-project listing is the reconciler's alone (A-07's one exception); no route serves it.
    await expect(http.dispatches.listByStatus(["requested"])).rejects.toThrow(/reconciler/);
    await expect(http.installationClaims.claim(1, f.scope.projectId as never, "")).rejects.toThrow(
      /github/,
    );
    await expect(http.installationClaims.release(1, f.scope.projectId as never)).rejects.toThrow(
      /github/,
    );
    await expect(http.computeUtilizations.put(makeComputeUtilization(f))).rejects.toThrow(
      /heartbeat/,
    );
    await expect(http.warmCaches.put(makeWarmCache(f))).rejects.toThrow(/reconciler/);
    await expect(http.warmCaches.delete(f.scope.projectId, "x86_64")).rejects.toThrow(/dispatcher/);
    await expect(http.computeUtilizations.listByProject(f.scope.projectId)).rejects.toThrow(
      /recommendation/,
    );
    // A contract is changed in place by the control plane alone (P16, D-08).
    await expect(
      http.programContracts.update(f.scope.projectId, f.scope.programId, (current) => current),
    ).rejects.toThrow(/prerequisites/);
  });
});

describe("a project's gate health (P15, D-P15-07)", () => {
  /** The http adapter, carrying someone else's token. Not recorded: only the session's calls count. */
  const storesAs = (principal: RequestPrincipal): ProjectStores =>
    createHttpStores({
      transport: createFetchTransport({
        endpoint: world.plane.url,
        tokens: staticTokenProvider(encodeTestPrincipal(principal)),
      }),
    });

  /** A token on a run of `f`'s program, as `role`. */
  const executionOf = (
    f: Fixtures,
    role: ExecutionRole,
    generation?: number,
  ): Extract<Principal, { kind: "execution" }> => ({
    kind: "execution",
    ...f.scope,
    nodeId: f.rootNodeId,
    agentId: f.ids.next("agent"),
    role,
    ...(generation === undefined ? {} : { generation }),
  });

  const statusOf = async (promise: Promise<unknown>): Promise<number> => {
    const failure = await rejectionOf(promise);
    expect(failure).toBeInstanceOf(ControlPlaneError);
    return (failure as ControlPlaneError).status;
  };

  /** What the session's own puts are recorded as: `auditedBy` is the caller (D-P15-07). */
  const byCaller = (record: GateHealth): GateHealth => ({
    ...record,
    auditedBy: { kind: "user", userId: world.subject, orgId: world.orgId },
  });

  it("lets a member write and read it, and a second put replaces the first", async () => {
    const { http, f, backing } = world;
    await http.projects.put(aProject(f));
    expect(await http.gateHealth.get(f.scope.projectId)).toBeUndefined();

    const healthy = byCaller(makeGateHealth(f));
    await http.gateHealth.put(healthy);
    expect(await http.gateHealth.get(f.scope.projectId)).toEqual(healthy);

    const repairing = byCaller(
      makeGateHealth(f, {
        verdict: "repairing",
        findings: [
          {
            id: "F-01",
            rule: 3,
            found: "two gates share dist/",
            decisionId: "D-01",
            paths: ["package.json"],
          },
        ],
      }),
    );
    await http.gateHealth.put(repairing);
    expect(await http.gateHealth.get(f.scope.projectId)).toEqual(repairing);
    expect(await backing.gateHealth.get(f.scope.projectId)).toEqual(repairing);
  });

  it("refuses an invalid record with 400, and one for another project or none", async () => {
    const { http, f } = world;
    await http.projects.put(aProject(f));
    const record = makeGateHealth(f);
    // Healthy with a finding, and a machinery path that leaves the checkout on Windows.
    for (const bad of [
      { ...record, findings: [{ id: "F-01", rule: 1, found: "x", decisionId: "D-01", paths: [] }] },
      { ...record, machinery: ["..\\outside\\gate.mjs"] },
    ]) {
      const failure = await rejectionOf(http.gateHealth.put(bad as never));
      expect((failure as ControlPlaneError).status).toBe(400);
      expect((failure as ControlPlaneError).code).toBe("validation_failed");
    }
    // The body names a project the path does not.
    const other = createFixtures();
    const response = await world.transport({
      method: "PUT",
      path: routes.gateHealth(f.scope.projectId),
      body: makeGateHealth(other),
    });
    expect(response.status).toBe(403);
    // No such project: nothing to record it against.
    expect(await statusOf(http.gateHealth.put(makeGateHealth(other)))).toBe(404);
    expect(await world.backing.gateHealth.get(f.scope.projectId)).toBeUndefined();
  });

  it("records the caller as auditedBy, whoever the body names", async () => {
    const { http, f, backing } = world;
    await http.projects.put(aProject(f));
    const someoneElse = makeGateHealth(f, {
      auditedBy: { kind: "user", userId: nextUserId(f), orgId: f.ids.next("org") },
    });
    const response = await world.transport({
      method: "PUT",
      path: routes.gateHealth(f.scope.projectId),
      body: someoneElse,
    });
    expect(response.status).toBe(201);
    expect((response.body as GateHealth).auditedBy).toEqual(byCaller(someoneElse).auditedBy);
    expect(await backing.gateHealth.get(f.scope.projectId)).toEqual(byCaller(someoneElse));
    expect(await http.gateHealth.get(f.scope.projectId)).toEqual(byCaller(someoneElse));
  });

  it("refuses a caller who is not a member of the project's organisation", async () => {
    const { http, f, backing } = world;
    await http.projects.put(aProject(f));
    await http.gateHealth.put(makeGateHealth(f));

    // A member of another organisation, and a signed-in user with no membership at all.
    const outsider = nextUserId(f);
    const otherOrg = f.ids.next("org");
    await backing.memberships.put(makeMembership(outsider, otherOrg));
    const stranger = nextUserId(f);
    for (const principal of [
      { kind: "user", userId: outsider, activeOrg: otherOrg },
      { kind: "user", userId: stranger },
    ] as const) {
      const theirs = storesAs(principal);
      expect(await statusOf(theirs.gateHealth.get(f.scope.projectId))).toBe(403);
      expect(
        await statusOf(theirs.gateHealth.put(makeGateHealth(f, { fingerprint: "1".repeat(64) }))),
      ).toBe(403);
    }
    expect(await backing.gateHealth.get(f.scope.projectId)).toEqual(byCaller(makeGateHealth(f)));
  });

  it("lets the engine write its own project's under its dispatch's generation, and no other", async () => {
    const { http, f, backing } = world;
    await seed();
    await backing.dispatches.put(makeDispatch(f, { generation: 2 }));

    const engineToken = executionOf(f, "engine", 2);
    const engine = storesAs(engineToken);
    // The body names another agent; the record names the engine that put it.
    const record = makeGateHealth(f, { auditedBy: engineToken });
    await engine.gateHealth.put({ ...record, auditedBy: executionOf(f, "engine", 2) });
    expect(await engine.gateHealth.get(f.scope.projectId)).toEqual(record);
    expect(await http.gateHealth.get(f.scope.projectId)).toEqual(record);

    // A superseded engine may still read, and may not write (D-P10-18).
    const superseded = storesAs(executionOf(f, "engine", 1));
    expect(await superseded.gateHealth.get(f.scope.projectId)).toEqual(record);
    const stale = await rejectionOf(superseded.gateHealth.put(makeGateHealth(f)));
    expect((stale as ControlPlaneError).status).toBe(403);
    expect((stale as ControlPlaneError).code).toBe("stale_generation");

    // An engine of another project's run reaches neither.
    const other = createFixtures();
    const foreign = storesAs(executionOf(other, "engine", 1));
    for (const attempt of [
      foreign.gateHealth.get(f.scope.projectId),
      foreign.gateHealth.put(makeGateHealth(f)),
    ]) {
      const failure = await rejectionOf(attempt);
      expect((failure as ControlPlaneError).status).toBe(403);
      expect((failure as ControlPlaneError).code).toBe("execution_out_of_scope");
    }
    expect(await backing.gateHealth.get(f.scope.projectId)).toEqual(record);
  });

  it("refuses every agent role but the engine, even on its own project", async () => {
    const { f, backing } = world;
    await seed();
    await backing.gateHealth.put(makeGateHealth(f));
    for (const role of ["worker", "orchestrator", "examiner", "arbiter"] as const) {
      const agent = storesAs(executionOf(f, role));
      for (const attempt of [
        agent.gateHealth.get(f.scope.projectId),
        agent.gateHealth.put(makeGateHealth(f, { fingerprint: "1".repeat(64) })),
      ]) {
        const failure = await rejectionOf(attempt);
        expect((failure as ControlPlaneError).status, role).toBe(403);
        expect((failure as ControlPlaneError).code, role).toBe("execution_forbidden_operation");
      }
    }
    expect(await backing.gateHealth.get(f.scope.projectId)).toEqual(makeGateHealth(f));
  });
});
