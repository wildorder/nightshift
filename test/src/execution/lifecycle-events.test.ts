/**
 * Lifecycle observations at the engine-owned operations (P20, S-05 J2), over the
 * real engine, real git, the production API handler and the fake harness.
 *
 * Every assertion is about an operation's exact start / note / end sequence,
 * read back from the `lifecycle.observed` events the way a report reads them.
 */
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type Event,
  type Examination,
  ExaminationSchema,
  type ExecutionNodeId,
  type JobContract,
  JobContractSchema,
  type LifecycleObservation,
  lifecycleObservationsOf,
  lifecycleOperationId,
  MeasurementLedgerChunkSchema,
  type Prerequisite,
  type ProgramContract,
  type RouteChoice,
  type RouteTarget,
} from "@nightshift/contracts";
import { createSteppingClock, isSettled, nowIso } from "@nightshift/core";
import {
  completeJob,
  createEngine,
  createEventOutbox,
  createMergeQueue,
  type Engine,
  EXAMINATION_CONTEXT_ENV,
  type ExaminationContext,
  type ExaminationServices,
  type ExecutionEnvironment,
  failJob,
  type MergeQueue,
  observeLifecycle,
  type PrerequisiteBook,
  RULING_CONTEXT_ENV,
  type RulingContext,
} from "@nightshift/execution";
import type { HarnessExit, HarnessStartInput } from "@nightshift/harness";
import {
  createFetchTransport,
  createHttpStores,
  staticTokenProvider,
} from "@nightshift/persistence/http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeHarness, type ScriptContext } from "./fake-harness.js";
import { cleanupWorlds, createWorld, eventsOf, type World } from "./world.js";

afterEach(cleanupWorlds);

const target = (provider: string, model: string): RouteTarget => ({
  harness: "fake",
  provider,
  model,
});
const choice = (routeTarget: RouteTarget): RouteChoice => ({
  target: routeTarget,
  eligibleOptions: [{ target: routeTarget, eligible: true }],
  ruleId: "R-test",
  wasOverride: false,
});
const BUILDER = target("anthropic", "claude-sonnet-5");
const EXAMINER = target("openai", "gpt-6-astra");
const ARBITER = target("anthropic", "claude-opus-5-5");

const barrier = () => {
  let open = (): void => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
};

type Work = (context: ScriptContext) => Promise<unknown>;

const edit = async (worktree: string, path: string, change: (text: string) => string) => {
  const file = join(worktree, path);
  const existing = await readFile(file, "utf8").catch(() => "");
  await writeFile(file, change(existing), "utf8");
};

const addModule =
  (name: string, gate?: Promise<void>): Work =>
  async ({ worktree }) => {
    await gate;
    await edit(worktree, `src/${name}.js`, () => `export const ${name} = () => "${name}";\n`);
    await edit(
      worktree,
      `test/${name}.test.js`,
      () =>
        `import { test } from "node:test";\nimport assert from "node:assert/strict";\n` +
        `import { ${name} } from "../src/${name}.js";\ntest("${name}", () => assert.equal(${name}(), "${name}"));\n`,
    );
  };

/** Replaces one line of `src/shared.js`: edits near each other change each other's context. */
const editLine =
  (line: number, text: string): Work =>
  async ({ worktree }) => {
    await edit(worktree, "src/shared.js", (body) =>
      body
        .split("\n")
        .map((existing, index) => (index === line - 1 ? text : existing))
        .join("\n"),
    );
  };

const SHARED = `${Array.from({ length: 9 }, (_, index) => `line ${index + 1}`).join("\n")}\n`;

/** What the examiner says each time it is asked about a node: its n-th examination. */
type ExaminerSays = "pass" | "findings" | "nothing";

interface RigOptions {
  readonly work: Readonly<Record<string, Work>>;
  readonly maxConcurrency?: number;
  readonly program?: Partial<ProgramContract>;
  readonly prerequisites?: () => readonly Prerequisite[];
  /** Hold the merge queue's door until this many candidates have arrived. */
  readonly gated?: boolean;
  readonly examiner?: (call: number) => ExaminerSays;
  /** The control plane refuses every event the engine writes. */
  readonly refuseEvents?: boolean;
}

const rig = async (options: RigOptions) => {
  let world: World | undefined;
  const calls = new Map<string, number>();
  const workers: string[] = [];
  const made = await createWorld({
    harness: createFakeHarness({
      script: async (context): Promise<HarnessExit> => {
        const { input } = context;
        const w = world as World;
        if (input.agent.role === "examiner") {
          const call = (calls.get(input.node.executionNodeId) ?? 0) + 1;
          calls.set(input.node.executionNodeId, call);
          return examine(w, input, options.examiner?.(call) ?? "pass");
        }
        if (input.agent.role === "arbiter") return arbitrate(w, input);
        const name = input.job.objective.split(" ")[0] ?? "";
        workers.push(name);
        const ended = await Promise.race([
          (options.work[name] ?? (async () => {}))(context).then((outcome) =>
            outcome === "fail" ? "fail" : "done",
          ),
          context.cancelled.then(() => "cancelled" as const),
        ]);
        if (ended === "cancelled") return { kind: "cancelled" };
        const outbox = createEventOutbox({
          events: w.stores.events,
          scope: context.identity.scope,
          clock: w.environment.clock,
          ids: w.ids,
          writerId: context.identity.agentId,
          initialDelayMs: 1,
        });
        const environment = { stores: w.stores, clock: w.environment.clock, git: w.git, outbox };
        if (ended === "fail") await failJob(environment, context.identity, `${name}: gave up`);
        else await completeJob(environment, context.identity, `${name}: done`);
        await outbox.flush();
        return { kind: "completed" };
      },
    }),
    program: {
      delegationLimits: { maxDepth: 2, maxConcurrency: options.maxConcurrency ?? 3 },
      ...options.program,
    },
  });
  world = made;

  const services: ExaminationServices = {
    examinerRoute: () => choice(EXAMINER),
    strongestExaminerRoute: () => choice(EXAMINER),
    arbiterRoute: () => choice(ARBITER),
    mcp: (identity) => ({
      name: "nightshift",
      command: process.execPath,
      args: [],
      env: {
        ...identity.extraEnv,
        NIGHTSHIFT_ROLE: identity.role,
        NIGHTSHIFT_EXECUTION_TOKEN: identity.executionToken,
      },
    }),
  };
  const book: PrerequisiteBook | undefined =
    options.prerequisites === undefined
      ? undefined
      : {
          prerequisites: async () => options.prerequisites?.() ?? [],
          recordDiscovered: async () => {
            throw new Error("nothing is discovered here");
          },
        };
  // An outbox whose control plane refuses everything: observation must not matter.
  const refusing = createEventOutbox({
    events: {
      ...made.stores.events,
      append: async () => {
        throw new Error("the control plane refuses events");
      },
    },
    scope: made.scope,
    clock: made.environment.clock,
    ids: made.ids,
    writerId: "refused",
    attempts: 1,
    initialDelayMs: 1,
    sleep: async () => {},
  });
  const environment: ExecutionEnvironment = {
    ...made.environment,
    examination: services,
    sleep: async () => {},
    ...(book === undefined ? {} : { prerequisites: book }),
    ...(options.refuseEvents === true ? { outbox: refusing } : {}),
  };
  const real = createMergeQueue(environment);
  const gate = barrier();
  if (options.gated !== true) gate.open();
  let atGate = 0;
  const queue: MergeQueue = {
    ...real,
    integrate: async (candidate) => {
      atGate += 1;
      await gate.opened;
      return real.integrate(candidate);
    },
  };
  const engine: Engine = createEngine({
    environment,
    session: made.session,
    mcp: () => ({ name: "nightshift", command: process.execPath, args: ["--version"], env: {} }),
    mergeQueue: queue,
    route: () => choice(BUILDER),
  });

  const submit = async (objective: string, extra?: Partial<JobContract>) => {
    const job = JobContractSchema.parse({
      schemaVersion: 1,
      ...made.scope,
      jobContractId: made.ids.next("job"),
      objective,
      acceptance: ["node --test passes"],
      dependencies: [],
      risk: "low",
      ambiguity: "low",
      ...extra,
      createdAt: nowIso(made.environment.clock),
    });
    const submitted = await engine.submit({
      job,
      depth: 1,
      parentNodeId: made.session.rootNodeId,
      route: choice(BUILDER),
    });
    return { jobId: job.jobContractId, nodeId: submitted.nodeId };
  };
  const status = async (nodeId: ExecutionNodeId): Promise<string> =>
    (await made.stores.executionNodes.get(made.scope, nodeId))?.status ?? "missing";
  const until = async (
    nodeId: ExecutionNodeId,
    predicate: (status: string) => boolean,
  ): Promise<string> => {
    const deadline = Date.now() + 60_000;
    let last = await status(nodeId);
    while (!predicate(last)) {
      if (Date.now() > deadline) throw new Error(`node ${nodeId} is still ${last}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
      last = await status(nodeId);
    }
    return last;
  };
  const idle = (): Promise<void> =>
    vi.waitFor(() => expect(engine.idle()).toBe(true), { timeout: 30_000 });

  return {
    world: made,
    environment,
    engine,
    workers,
    submit,
    status,
    until,
    idle,
    releaseQueue: async (candidates: number) => {
      await vi.waitFor(() => expect(atGate).toBeGreaterThanOrEqual(candidates), {
        timeout: 30_000,
      });
      gate.open();
    },
    /** Every lifecycle observation of the run, once the outboxes are empty. */
    observations: async (): Promise<LifecycleObservation[]> => {
      await made.outbox.flush();
      return lifecycleObservationsOf(await eventsOf(made));
    },
  };
};

const helperStores = (world: World, input: HarnessStartInput) =>
  createHttpStores({
    transport: createFetchTransport({
      endpoint: world.plane.url,
      tokens: staticTokenProvider(input.mcp?.env.NIGHTSHIFT_EXECUTION_TOKEN ?? ""),
    }),
  });

const examine = async (
  world: World,
  input: HarnessStartInput,
  says: ExaminerSays,
): Promise<HarnessExit> => {
  if (says === "nothing") return { kind: "completed" };
  const context = JSON.parse(input.mcp?.env[EXAMINATION_CONTEXT_ENV] ?? "{}") as ExaminationContext;
  const findings =
    says === "pass"
      ? []
      : [
          {
            id: "F-01",
            severity: "material" as const,
            summary: "a material finding",
            evidence: [{ kind: "contract" as const, clause: "It works." }],
            resolution: "unresolved" as const,
          },
        ];
  await helperStores(world, input).examinations.put(
    ExaminationSchema.parse({
      schemaVersion: 1,
      projectId: input.node.projectId,
      programId: input.node.programId,
      runId: input.node.runId,
      examinationId: context.examinationId,
      executionNodeId: input.node.executionNodeId,
      verificationId: context.verificationId,
      commitSha: context.commitSha,
      patchId: context.patchId,
      implementerAgentId: context.implementerAgentId,
      examinerAgentId: input.agent.agentId,
      examinerRoute: context.examinerRoute,
      requiredByRisk: context.requiredByRisk,
      blocking: context.blocking,
      fixAttempt: context.fixAttempt,
      questions: context.questions,
      outcome: findings.length === 0 ? "passed" : "findings_raised",
      findings,
      createdAt: nowIso(world.environment.clock),
    }) as Examination,
  );
  return { kind: "completed", sessionId: "examiner-session" };
};

const arbitrate = async (world: World, input: HarnessStartInput): Promise<HarnessExit> => {
  const context = JSON.parse(input.mcp?.env[RULING_CONTEXT_ENV] ?? "{}") as RulingContext;
  await helperStores(world, input).decisions.put({
    schemaVersion: 1,
    projectId: input.node.projectId,
    programId: input.node.programId,
    runId: input.node.runId,
    decisionId: world.ids.next("dec"),
    executionNodeId: input.node.executionNodeId,
    agentId: input.agent.agentId,
    context: `ruling on ${context.findingId}`,
    alternatives: [{ summary: "uphold" }],
    choice: "overturn",
    rationale: "on the evidence",
    reversibility: "reversible",
    checkpointBefore: context.checkpointBefore,
    affectedNodes: [input.node.executionNodeId],
    authority: "agent",
    supersedesDecisionId: null,
    createdAt: nowIso(world.environment.clock),
  } as never);
  return { kind: "completed" };
};

// --- Reading the record ------------------------------------------------------------------

const opId = (phase: string, nodeId: string, key: string | number) =>
  lifecycleOperationId(phase, nodeId, String(key));

/** An operation's observations as `transition` or `transition:reason`, in order. */
const sequenceOf = (observations: readonly LifecycleObservation[], operationId: string) =>
  observations
    .filter((observation) => observation.operationId === operationId)
    .map((observation) =>
      observation.reason === undefined
        ? observation.transition
        : `${observation.transition}:${observation.reason}`,
    );

const blockersOf = (observation: LifecycleObservation | undefined): string[] =>
  (observation?.blockers ?? []).map((blocker) => `${blocker.kind}:${blocker.ref}`).sort();

const notesOf = (observations: readonly LifecycleObservation[], operationId: string) =>
  observations.filter(
    (observation) => observation.operationId === operationId && observation.transition === "note",
  );

const settled = (status: string): boolean => isSettled(status as never);

describe("a wait is observed with every blocker at once", () => {
  it("notes a dependency and a full parent slot together, then ends started", async () => {
    const finish = barrier();
    const r = await rig({
      work: { alpha: addModule("alpha", finish.opened), beta: addModule("beta") },
      maxConcurrency: 1,
    });
    const a = await r.submit("alpha module");
    const b = await r.submit("beta module", { dependencies: [a.jobId] });
    expect(r.engine.waiting(b.jobId)).toEqual({ kind: "jobs", waitingFor: [a.jobId] });

    finish.open();
    expect(await r.until(b.nodeId, settled)).toBe("integrated");
    await r.idle();
    const observed = await r.observations();

    expect(sequenceOf(observed, opId("wait", a.nodeId, 1))).toEqual(["start", "end:started"]);
    const sequence = sequenceOf(observed, opId("wait", b.nodeId, 1));
    expect(sequence[0]).toBe("start");
    expect(sequence.at(-1)).toBe("end:started");
    const notes = notesOf(observed, opId("wait", b.nodeId, 1));
    expect(notes.length).toBeGreaterThanOrEqual(1);
    // One note carries both at once.
    expect(blockersOf(notes[0])).toEqual(
      [`job:${a.jobId}`, `parent_slot:${r.world.session.rootNodeId}`].sort(),
    );
    // Told only when the set changes: the same set on a later pass says nothing.
    for (const [index, note] of notes.entries()) {
      if (index > 0) expect(blockersOf(note)).not.toEqual(blockersOf(notes[index - 1]));
    }
  }, 90_000);

  it("ends a cancelled queued job's wait as withdrawn", async () => {
    const finish = barrier();
    const r = await rig({
      work: { alpha: addModule("alpha", finish.opened), beta: addModule("beta") },
      maxConcurrency: 1,
    });
    await r.submit("alpha module");
    const b = await r.submit("beta module");
    expect(await r.status(b.nodeId)).toBe("queued");

    expect(await r.engine.cancel(b.jobId)).toBe(true);
    finish.open();
    await r.idle();
    const observed = await r.observations();
    expect(sequenceOf(observed, opId("wait", b.nodeId, 1))).toEqual([
      "start",
      "note:blockers changed",
      "end:withdrawn",
    ]);
    expect(blockersOf(notesOf(observed, opId("wait", b.nodeId, 1))[0])).toEqual([
      `parent_slot:${r.world.session.rootNodeId}`,
    ]);
    expect(sequenceOf(observed, opId("startup", b.nodeId, 1))).toEqual([]);
  }, 90_000);
});

describe("a restarted engine continues the wait it did not finish", () => {
  it("starts the same wait again as recovered, and only then", async () => {
    const finish = barrier();
    const r = await rig({
      work: { alpha: addModule("alpha", finish.opened), beta: addModule("beta") },
      maxConcurrency: 1,
    });
    await r.submit("alpha module");
    const b = await r.submit("beta module");
    expect(await r.status(b.nodeId)).toBe("queued");

    // The process stops; the record keeps the queued node, and a new engine adopts it.
    await r.engine.close("restart", { preserveWork: true });
    const next = createEngine({
      environment: r.environment,
      session: r.world.session,
      mcp: () => ({ name: "nightshift", command: process.execPath, args: ["--version"], env: {} }),
      route: () => choice(BUILDER),
    });
    await next.recover();
    await next.settled();
    const observed = await r.observations();
    const sequence = sequenceOf(observed, opId("wait", b.nodeId, 1));
    expect(sequence[0]).toBe("start");
    expect(sequence.filter((entry) => entry.startsWith("start"))).toEqual([
      "start",
      "start:recovered",
    ]);
    finish.open();
  }, 90_000);
});

describe("startup, setup and work are observed for each attempt", () => {
  it("records a retry's causes, its wait, and each attempt's startup, setup and work", async () => {
    let attempts = 0;
    const r = await rig({
      work: {
        flaky: async (context) => {
          attempts += 1;
          if (attempts === 1) return "fail";
          return addModule("flaky")(context);
        },
      },
    });
    const job = await r.submit("flaky module");
    expect(await r.until(job.nodeId, settled)).toBe("failed");
    await r.idle();

    expect(await r.engine.retry(job.jobId)).toBe(true);
    expect(await r.until(job.nodeId, (status) => status === "integrated")).toBe("integrated");
    await r.idle();
    const observed = await r.observations();

    const decisions = [
      ...(await r.world.stores.routingDecisions.listByNode(r.world.scope, job.nodeId)),
    ].sort((a, b) => a.attempt - b.attempt);
    expect(decisions.map((decision) => decision.attempt)).toEqual([1, 2]);
    expect(decisions[0]?.causes).toBeUndefined();
    expect(decisions[1]?.causes).toEqual([
      { kind: "worker_failed", detail: expect.stringContaining("gave up") },
    ]);
    const queued = (await eventsOf(r.world)).filter(
      (event: Event) =>
        event.type === "node.queued" &&
        event.executionNodeId === job.nodeId &&
        (event.payload as { retryOf?: string }).retryOf !== undefined,
    );
    expect(queued).toHaveLength(1);
    expect((queued[0] as Event).payload.causes).toEqual(decisions[1]?.causes);

    expect(sequenceOf(observed, opId("wait", job.nodeId, 1))).toEqual(["start", "end:started"]);
    expect(sequenceOf(observed, opId("wait", job.nodeId, 2))).toEqual(["start", "end:started"]);
    for (const attempt of [1, 2]) {
      expect(sequenceOf(observed, opId("startup", job.nodeId, attempt))).toEqual([
        "start",
        "end:process started",
      ]);
      expect(sequenceOf(observed, opId("setup", job.nodeId, attempt))).toEqual([
        "start",
        "end:none",
      ]);
      expect(sequenceOf(observed, opId("work", job.nodeId, attempt))).toEqual([
        "start",
        "end:completed",
      ]);
      const setup = observed.find(
        (observation) => observation.operationId === opId("setup", job.nodeId, attempt),
      );
      expect(setup?.parentOperationId).toBe(opId("startup", job.nodeId, attempt));
    }
    const startup = observed.find((o) => o.operationId === opId("startup", job.nodeId, 2));
    expect(startup?.refs).toEqual([
      { kind: "routing_decision", ref: decisions[1]?.routingDecisionId },
    ]);
    // Exact: nothing else was observed for this node's attempts.
    expect(new Set(observed.map((o) => o.operationId))).toEqual(
      new Set(
        [1, 2]
          .flatMap((attempt) =>
            ["wait", "startup", "setup", "work", "queue", "integration"].map((phase) =>
              opId(phase, job.nodeId, attempt),
            ),
          )
          .filter((id) => !id.startsWith("queue:") || id.endsWith(":2"))
          .filter((id) => !id.startsWith("integration:") || id.endsWith(":2")),
      ),
    );
  }, 120_000);

  it("holds the work op's end in the agent's published ledger chunk, with the same observation id", async () => {
    const r = await rig({
      work: { alpha: addModule("alpha") },
      program: { setup: [{ id: "install", command: 'node -e "process.exit(0)"' }] },
    });
    const a = await r.submit("alpha module");
    expect(await r.until(a.nodeId, settled)).toBe("integrated");
    await r.idle();
    const observed = await r.observations();

    expect(sequenceOf(observed, opId("setup", a.nodeId, 1))).toEqual(["start", "end:passed"]);
    const end = observed.find(
      (o) => o.operationId === opId("work", a.nodeId, 1) && o.transition === "end",
    );
    expect(end).toMatchObject({ reason: "completed", attempt: 1, source: "engine" });
    expect(end?.launch).toBeDefined();

    const artifacts = (await r.world.stores.artifacts.listByRun(r.world.scope)).items;
    const ledger = [];
    for (const artifact of artifacts.filter(
      (entry) => entry.kind === "measurement-ledger" && entry.executionNodeId === a.nodeId,
    )) {
      const body = await r.world.bodies.get(r.world.scope, artifact.artifactId);
      const chunk = MeasurementLedgerChunkSchema.safeParse(
        JSON.parse(new TextDecoder().decode(body)),
      );
      if (chunk.success) ledger.push(...chunk.data.observations);
    }
    const held = ledger.filter(
      (observation) =>
        observation.kind === "lifecycle" && observation.operationId.startsWith("work:"),
    );
    expect(held.map((observation) => observation.observationId)).toContain(end?.observationId);
    const startup = ledger.find(
      (observation) =>
        observation.kind === "lifecycle" && observation.operationId.startsWith("startup:"),
    );
    expect(startup).toBeDefined();
  }, 90_000);

  it("tells a failed setup", async () => {
    const r = await rig({
      work: { alpha: addModule("alpha") },
      program: { setup: [{ id: "install", command: 'node -e "process.exit(3)"' }] },
    });
    const a = await r.submit("alpha module");
    await r.until(a.nodeId, settled);
    await r.idle();
    expect(sequenceOf(await r.observations(), opId("setup", a.nodeId, 1))).toEqual([
      "start",
      "end:failed",
    ]);
  }, 90_000);
});

describe("the merge queue and the integration are observed", () => {
  it("names the predecessor of the job that waits, and ends both integrations integrated", async () => {
    const r = await rig({
      work: { alpha: addModule("alpha"), beta: addModule("beta") },
      gated: true,
    });
    const a = await r.submit("alpha module");
    const b = await r.submit("beta module");
    await r.releaseQueue(2);
    expect(await r.until(a.nodeId, settled)).toBe("integrated");
    expect(await r.until(b.nodeId, settled)).toBe("integrated");
    await r.idle();
    const observed = await r.observations();

    const queueOps = [a, b].map((job) => opId("queue", job.nodeId, 1));
    const sequences = queueOps.map((op) => sequenceOf(observed, op));
    // One went first; the other was told who was ahead of it, and by whom.
    const waited = [a, b].find(
      (job) => sequenceOf(observed, opId("queue", job.nodeId, 1)).length === 3,
    );
    const first = waited === a ? b : a;
    expect(waited, JSON.stringify(sequences)).toBeDefined();
    expect(sequenceOf(observed, opId("queue", first.nodeId, 1))).toEqual([
      "start",
      "end:integrating",
    ]);
    expect(sequenceOf(observed, opId("queue", (waited ?? a).nodeId, 1))).toEqual([
      "start",
      `note:waiting behind ${first.nodeId}`,
      "end:integrating",
    ]);
    const note = notesOf(observed, opId("queue", (waited ?? a).nodeId, 1))[0];
    expect(note?.blockers).toEqual([{ kind: "queue_predecessor", ref: first.nodeId }]);

    for (const job of [a, b]) {
      const sequence = sequenceOf(observed, opId("integration", job.nodeId, 1));
      expect(sequence[0]).toBe("start");
      expect(sequence).toContain("note:verification: passed");
      expect(sequence.at(-1)).toBe("end:integrated");
      const verifications = await r.world.stores.verifications.listByNode(
        r.world.scope,
        job.nodeId,
      );
      const verification = notesOf(observed, opId("integration", job.nodeId, 1)).find(
        (o) => o.reason === "verification: passed",
      );
      expect(verification?.refs).toEqual([
        { kind: "verification", ref: verifications.at(-1)?.verificationId },
      ]);
    }
    // The job that went second was replayed onto the first.
    const second = (waited ?? a).nodeId;
    expect(sequenceOf(observed, opId("integration", second, 1))).toContain("note:reconciled");
  }, 120_000);

  it("ends an integration verification_failed when the queue's check fails", async () => {
    const r = await rig({
      work: {
        broken: async ({ worktree }) => {
          await edit(
            worktree,
            "test/broken.test.js",
            () =>
              `import { test } from "node:test";\nimport assert from "node:assert/strict";\ntest("no", () => assert.equal(1, 2));\n`,
          );
        },
      },
    });
    const job = await r.submit("broken module");
    expect(await r.until(job.nodeId, settled)).toBe("verification_failed");
    await r.idle();
    const observed = await r.observations();
    expect(sequenceOf(observed, opId("integration", job.nodeId, 1))).toEqual([
      "start",
      "note:verification: failed",
      "end:verification_failed",
    ]);
    expect(sequenceOf(observed, opId("queue", job.nodeId, 1))).toEqual([
      "start",
      "end:integrating",
    ]);
  }, 90_000);

  it("ends an integration deferred when its check waits on a prerequisite", async () => {
    const pending: Prerequisite = {
      id: "HP-01",
      description: "The deploy credential is in place.",
      remediation: "Ask the owner.",
      verifyCommand: "true",
      status: "pending",
    };
    const r = await rig({
      work: { one: addModule("one") },
      program: {
        verification: [
          { id: "test", command: "node --test" },
          { id: "gate", command: 'node -e "process.exit(0)"', requires: ["HP-01"] },
        ],
        prerequisites: [pending],
      },
      prerequisites: () => [pending],
      maxConcurrency: 1,
    });
    const job = await r.submit("one module");
    expect(await r.until(job.nodeId, (status) => status === "deferred")).toBe("deferred");
    await r.idle();
    const observed = await r.observations();
    expect(sequenceOf(observed, opId("integration", job.nodeId, 1))).toEqual([
      "start",
      "note:verification: deferred",
      "end:deferred",
    ]);
  }, 90_000);

  it("notes that the examination was skipped when no examiner could review the work", async () => {
    const r = await rig({
      work: { alpha: addModule("alpha") },
      examiner: () => "nothing",
    });
    const job = await r.submit("alpha module", { risk: "high" });
    expect(await r.until(job.nodeId, settled)).toBe("integrated");
    await r.idle();
    const observed = await r.observations();
    expect(sequenceOf(observed, opId("integration", job.nodeId, 1))).toEqual([
      "start",
      "note:verification: passed",
      "note:examination: skipped",
      "end:integrated",
    ]);
  }, 90_000);

  it("lands an overturned examination again as readmitted, with no new work attempt", async () => {
    // `second` edits line 2, `first` line 5: they replay cleanly, but `second`'s
    // diff then carries `first`'s line as context, so it is a different change and
    // is examined again in the queue, where the examiner stops it.
    const seed: Work = async ({ worktree }) => {
      await writeFile(join(worktree, "src", "shared.js"), SHARED, "utf8");
    };
    const r = await rig({
      work: {
        seed,
        first: editLine(5, "first changed line 5"),
        second: editLine(2, "second changed line 2"),
      },
      gated: false,
      examiner: (call) => (call >= 2 ? "findings" : "pass"),
    });
    const s = await r.submit("seed module");
    expect(await r.until(s.nodeId, settled)).toBe("integrated");
    await r.idle();

    // Both are cut from the same head and reach the queue together.
    const gate = barrier();
    const first = await r.submit("first module");
    const second = await r.submit("second module", { risk: "high" });
    gate.open();
    expect(await r.until(first.nodeId, settled)).toBe("integrated");
    expect(await r.until(second.nodeId, settled)).toBe("examination_failed");
    await r.idle();

    const result = await r.engine.dispute(second.jobId, "the finding does not apply");
    expect(result).toEqual({ kind: "overturned", nodeId: second.nodeId });
    expect(await r.until(second.nodeId, settled)).toBe("integrated");
    await r.idle();
    const observed = await r.observations();

    const queue = sequenceOf(observed, opId("queue", second.nodeId, 1));
    expect(queue).toEqual(["start", "end:integrating", "start:readmitted", "end:integrating"]);
    const integration = sequenceOf(observed, opId("integration", second.nodeId, 1));
    const again = integration.indexOf("start:readmitted");
    expect(again).toBeGreaterThan(0);
    expect(integration.slice(0, again).at(-1)).toBe("end:examination_stopped");
    expect(integration.slice(0, again)[0]).toBe("start");
    expect(integration.at(-1)).toBe("end:integrated");
    expect(integration.slice(again)).not.toContain("end:examination_stopped");

    // The same work landed: one work attempt and one worker.
    const decisions = (
      await r.world.stores.routingDecisions.listByNode(r.world.scope, second.nodeId)
    ).filter((decision) => decision.purpose === undefined);
    expect(decisions.map((decision) => decision.attempt)).toEqual([1]);
    expect(r.workers.filter((name) => name === "second")).toHaveLength(1);
    expect(sequenceOf(observed, opId("work", second.nodeId, 2))).toEqual([]);
    const stopped = notesOf(observed, opId("integration", second.nodeId, 1)).find(
      (o) => o.reason === "examination: stopped",
    );
    expect(stopped?.refs?.[0]?.kind).toBe("examination");
  }, 180_000);
});

describe("observation never changes an outcome", () => {
  it("lands the job although the control plane refuses every event the engine writes", async () => {
    const r = await rig({ work: { alpha: addModule("alpha") }, refuseEvents: true });
    const job = await r.submit("alpha module");
    expect(await r.until(job.nodeId, settled)).toBe("integrated");
    expect(existsSync(r.world.repo)).toBe(true);
  }, 90_000);

  it("drops an observation whose outbox and recorder both throw", () => {
    const clock = createSteppingClock(Date.parse("2026-10-21T00:00:00.000Z"), 1_000);
    const throwing = () => {
      throw new Error("refused");
    };
    const environment = {
      clock,
      ids: { next: () => "x" as never },
      outbox: {
        emit: throwing,
        flush: async () => {},
        spill: async () => 0,
        replay: async () => 0,
        pending: 0,
        delivered: 0,
      },
    } as never;
    const recorder = { lifecycle: throwing } as never;
    const scope = {
      projectId: "proj_00000000000000000000000000",
      programId: "prog_00000000000000000000000000",
      runId: "run_00000000000000000000000000",
    } as never;
    expect(() =>
      observeLifecycle(environment, {
        scope,
        nodeId: "node_00000000000000000000000000" as never,
        operationId: "work:node_x:1",
        phase: "work",
        transition: "start",
        recorder,
      }),
    ).not.toThrow();
    expect(
      observeLifecycle(environment, {
        scope,
        nodeId: "not a node id" as never,
        operationId: "work:node_x:1",
        phase: "work",
        transition: "start",
      }),
    ).toBeUndefined();
  });

  it("gives two notes at one instant different ids", () => {
    const emitted: { payload: { observationId: string } }[] = [];
    const environment = {
      clock: { now: () => Date.parse("2026-10-21T00:00:00.000Z") },
      ids: { next: () => "x" as never },
      outbox: { emit: (input: never) => emitted.push(input) },
    } as never;
    const input = {
      scope: {
        projectId: "proj_00000000000000000000000000",
        programId: "prog_00000000000000000000000000",
        runId: "run_00000000000000000000000000",
      } as never,
      nodeId: "node_00000000000000000000000000" as never,
      operationId: "wait:node_x:1",
      phase: "wait",
      transition: "note" as const,
    };
    observeLifecycle(environment, input);
    observeLifecycle(environment, input);
    expect(emitted).toHaveLength(2);
    expect(emitted[0]?.payload.observationId).not.toBe(emitted[1]?.payload.observationId);
  });
});
