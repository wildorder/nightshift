/**
 * The S-05 report sections over the real engine (P20, J9): scripted histories
 * are driven through the engine, real git, the production API handler and the
 * fake harness, then `gatherReport` is read for its operations, delivery,
 * review and infrastructure sections beside the lifecycle observations on the
 * record. Every figure asserted is an exact count read from that record.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type Examination,
  ExaminationSchema,
  type ExecutionNode,
  type ExecutionNodeId,
  type JobContract,
  JobContractSchema,
  type LifecycleObservation,
  lifecycleObservationsOf,
  lifecycleOperationId,
  type Prerequisite,
  type ProgramContract,
  type RouteChoice,
  type RouteTarget,
} from "@nightshift/contracts";
import { gatherReport, isSettled, markImplemented, nowIso } from "@nightshift/core";
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
  git,
  type MergeQueue,
  type PrerequisiteBook,
  planStateOf,
  RULING_CONTEXT_ENV,
  type RulingContext,
  recordWorkerDecision,
  STRAND_PLAN_CONTEXT,
} from "@nightshift/execution";
import type { AgentTask, HarnessExit, HarnessStartInput } from "@nightshift/harness";
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
  const environment: ExecutionEnvironment = {
    ...made.environment,
    examination: services,
    sleep: async () => {},
    ...(book === undefined ? {} : { prerequisites: book }),
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

const settled = (status: string): boolean => isSettled(status as never);

type Rig = Awaited<ReturnType<typeof rig>>;
type Report = Awaited<ReturnType<typeof gatherReport>>;

/** The report as the CLI gathers it, once the outboxes are empty. */
const reportOf = async (r: Rig): Promise<Report> => {
  await r.world.outbox.flush();
  return gatherReport(r.world.stores, r.world.scope);
};

const observationsOf = async (r: Rig): Promise<LifecycleObservation[]> => {
  await r.world.outbox.flush();
  return lifecycleObservationsOf(await eventsOf(r.world));
};

/** An operation's observations as `transition` or `transition:reason`, in order. */
const sequenceOf = (observations: readonly LifecycleObservation[], operationId: string) =>
  observations
    .filter((observation) => observation.operationId === operationId)
    .map((observation) =>
      observation.reason === undefined
        ? observation.transition
        : `${observation.transition}:${observation.reason}`,
    );

const notesOf = (observations: readonly LifecycleObservation[], operationId: string) =>
  observations.filter(
    (observation) => observation.operationId === operationId && observation.transition === "note",
  );

const blockersOf = (blockers: readonly { kind: string; ref: string }[] | undefined): string[] =>
  (blockers ?? []).map((blocker) => `${blocker.kind}:${blocker.ref}`).sort();

/** The report's operations of one node and phase, in order of occurrence. */
const intervalsOf = (report: Report, nodeId: string, phase: string) =>
  report.operations.operations.filter(
    (operation) => operation.nodeId === nodeId && operation.phase === phase,
  );

/** The chain as `link>phase:node`, newest first, with nodes named by `names`. */
const chainOf = (report: Report, names: ReadonlyMap<string, string>): string[] =>
  report.operations.chain.steps.map(
    (step) => `${step.link}>${step.phase}:${names.get(step.nodeId) ?? step.nodeId}`,
  );

const nonZero = (counts: Record<string, number>): Record<string, number> =>
  Object.fromEntries(Object.entries(counts).filter(([, count]) => count > 0));

const brokenTest: Work = async ({ worktree }) => {
  await edit(
    worktree,
    "test/broken.test.js",
    () =>
      `import { test } from "node:test";\nimport assert from "node:assert/strict";\ntest("no", () => assert.equal(1, 2));\n`,
  );
};

const seedShared: Work = async ({ worktree }) => {
  await writeFile(join(worktree, "src", "shared.js"), SHARED, "utf8");
};

const mcpFor = () => ({
  name: "nightshift",
  command: process.execPath,
  args: ["--version"],
  env: {},
});

/**
 * A planned strand of one job whose landing is red and whose session cannot
 * repair it: the job merged onto the strand's branch, the strand failed.
 */
const failedStrand = async () => {
  let world: World | undefined;
  const delegated = new Map<string, JobContract["jobContractId"]>();
  const outboxFor = (context: ScriptContext) =>
    createEventOutbox({
      events: (world as World).stores.events,
      scope: context.identity.scope,
      clock: (world as World).environment.clock,
      ids: (world as World).ids,
      writerId: context.identity.agentId,
      initialDelayMs: 1,
    });
  const orchestrate = async (context: ScriptContext): Promise<HarnessExit> => {
    const w = world as World;
    const task = context.input.task as AgentTask | undefined;
    // The strand cannot repair its landing: the same session is resumed and gives up.
    if (task?.kind === "strand_fix") return { kind: "failed", exitCode: 1 };
    const outbox = outboxFor(context);
    await recordWorkerDecision(
      { stores: w.stores, clock: w.environment.clock, git: w.git, outbox },
      context.identity,
      w.ids,
      {
        context: `${STRAND_PLAN_CONTEXT} round 1 - 1 job`,
        alternatives: [{ summary: "the plan as authored" }],
        choice: "J1: the a module",
        rationale: "one job.",
        reversibility: "reversible",
      },
    );
    await outbox.flush();
    const planned = Date.now() + 60_000;
    for (;;) {
      const state = await planStateOf(w.environment, w.scope, context.identity.executionNodeId);
      if (state.reviews.length > 0) break;
      if (Date.now() > planned) throw new Error("the plan was not reviewed");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const at = nowIso(w.environment.clock);
    const job = JobContractSchema.parse({
      schemaVersion: 1,
      ...w.scope,
      jobContractId: w.ids.next("job"),
      objective: "[a] Add the a module.",
      acceptance: ["node --test passes"],
      dependencies: [],
      risk: "low",
      ambiguity: "low",
      createdAt: at,
    });
    await w.stores.jobContracts.put(job);
    await w.stores.executionNodes.put({
      schemaVersion: 1,
      ...w.scope,
      executionNodeId: w.ids.next("node"),
      kind: "job",
      parentNodeId: context.identity.executionNodeId,
      depth: 2,
      status: "validated",
      jobContractId: job.jobContractId,
      commitSha: null,
      createdAt: at,
      updatedAt: at,
    } as ExecutionNode);
    delegated.set("J1", job.jobContractId);
    const deadline = Date.now() + 60_000;
    for (;;) {
      const nodes = (await w.stores.executionNodes.listByRun(w.scope)).items;
      if (nodes.find((n) => n.jobContractId === job.jobContractId)?.status === "merged") break;
      if (Date.now() > deadline) throw new Error("J1 did not merge");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const head = (await git(w.git, ["rev-parse", "HEAD"], { cwd: context.worktree })).trim();
    const node = await w.stores.executionNodes.get(w.scope, context.identity.executionNodeId);
    await w.stores.executionNodes.put(
      markImplemented(node as ExecutionNode, head as never, nowIso(w.environment.clock)),
    );
    return { kind: "completed", sessionId: "strand-session" };
  };
  const worker = async (context: ScriptContext): Promise<HarnessExit> => {
    const w = world as World;
    await writeFile(join(context.worktree, "src/a.js"), "export const a = 1;\n");
    // The job merges onto the strand's branch unchecked; the landing's own check is red.
    await writeFile(
      join(context.worktree, "test/a.test.js"),
      'import { test } from "node:test";\nimport assert from "node:assert/strict";\ntest("a", () => { assert.equal(1, 2); });\n',
    );
    const outbox = outboxFor(context);
    await completeJob(
      { stores: w.stores, clock: w.environment.clock, git: w.git, outbox },
      context.identity,
      "a: done",
    );
    await outbox.flush();
    return { kind: "completed" };
  };
  world = await createWorld({
    program: { delegationLimits: { maxDepth: 2, maxConcurrency: 2 } },
    harness: createFakeHarness({
      script: (context) => {
        if (context.input.agent.role === "examiner") {
          return Promise.resolve({ kind: "completed" as const });
        }
        return context.input.node.kind === "sub-program" ? orchestrate(context) : worker(context);
      },
    }),
  });
  const w = world;
  const engine = createEngine({
    environment: { ...w.environment, publishStrand: async () => {} },
    session: w.session,
    mcp: () => ({ name: "nightshift", command: process.execPath, args: ["--version"], env: {} }),
    route: () => choice(BUILDER),
    discoveryIntervalMs: 50,
  });
  const strand = await engine.submit({
    job: JobContractSchema.parse({
      schemaVersion: 1,
      ...w.scope,
      jobContractId: w.ids.next("job"),
      objective: "The a module.",
      acceptance: ["node --test passes"],
      dependencies: [],
      risk: "low",
      ambiguity: "low",
      kind: "orchestrate",
      createdAt: nowIso(w.environment.clock),
    }),
    depth: 1,
    parentNodeId: w.session.rootNodeId,
    route: choice(BUILDER),
    kind: "sub-program",
  });
  const deadline = Date.now() + 60_000;
  for (;;) {
    const node = await w.stores.executionNodes.get(w.scope, strand.nodeId as ExecutionNodeId);
    if (node !== undefined && isSettled(node.status) && engine.idle()) break;
    if (Date.now() > deadline) throw new Error(`strand is still ${node?.status}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await w.outbox.flush();
  const nodes = (await w.stores.executionNodes.listByRun(w.scope)).items;
  return { world: w, nodes, report: await gatherReport(w.stores, w.scope) };
};

describe("the S-05 sections of the run report, over the real engine", () => {
  it("1: waits on a dependency and a full parent slot at once, and the chain runs through the dependency that landed last", async () => {
    const holdA = barrier();
    const holdB = barrier();
    const r = await rig({
      work: {
        alpha: addModule("alpha", holdA.opened),
        beta: addModule("beta", holdB.opened),
        gamma: addModule("gamma"),
      },
      maxConcurrency: 2,
    });
    const a = await r.submit("alpha module");
    const b = await r.submit("beta module");
    const c = await r.submit("gamma module", { dependencies: [a.jobId, b.jobId] });
    // beta lands first, alpha last, and only then can gamma start.
    holdB.open();
    expect(await r.until(b.nodeId, settled)).toBe("integrated");
    holdA.open();
    expect(await r.until(c.nodeId, settled)).toBe("integrated");
    await r.idle();
    const observed = await observationsOf(r);
    const report = await reportOf(r);
    const root = r.world.session.rootNodeId;

    // One note carries both kinds of blocker; the next, after beta landed and the slot was free.
    const wait = opId("wait", c.nodeId, 1);
    expect(sequenceOf(observed, wait)).toEqual([
      "start",
      "note:blockers changed",
      "note:blockers changed",
      "end:started",
    ]);
    const notes = notesOf(observed, wait);
    expect(blockersOf(notes[0]?.blockers)).toEqual(
      [`job:${a.jobId}`, `job:${b.jobId}`, `parent_slot:${root}`].sort(),
    );
    expect(blockersOf(notes[1]?.blockers)).toEqual([`job:${a.jobId}`]);

    const [interval] = intervalsOf(report, c.nodeId, "wait");
    expect(interval?.state).toBe("closed");
    expect(interval?.reason).toBe("started");
    expect(interval?.blockerSpans.map((span) => blockersOf(span.blockers))).toEqual([
      [`job:${a.jobId}`, `job:${b.jobId}`, `parent_slot:${root}`].sort(),
      [`job:${a.jobId}`],
    ]);
    expect(interval?.blockerSpans.every((span) => span.to !== undefined)).toBe(true);
    expect(Object.keys(report.operations.unions.waitByBlockerKind).sort()).toEqual([
      "job",
      "parent_slot",
    ]);
    // The slot was held for a part of the wait that the dependency covers entirely.
    const byKind = report.operations.unions.waitByBlockerKind;
    expect(byKind.job).toBeGreaterThan(byKind.parent_slot ?? Number.POSITIVE_INFINITY);

    expect(report.operations.concurrency.peak).toBe(2);
    expect(report.operations.concurrency.series.at(-1)?.running).toBe(0);
    expect(report.operations.ambiguousMs).toBe(0);
    expect(report.operations.endings).toMatchObject({ integrated: 3 });

    // alpha's integration ended after beta's, so the chain runs through alpha.
    const integrationEnd = (nodeId: string) =>
      intervalsOf(report, nodeId, "integration")[0]?.endedAt ?? "";
    expect(integrationEnd(a.nodeId) > integrationEnd(b.nodeId)).toBe(true);
    const names = new Map([
      [a.nodeId, "a"],
      [b.nodeId, "b"],
      [c.nodeId, "c"],
    ]);
    expect(chainOf(report, names)).toEqual([
      "end>integration:c",
      "work>work:c",
      "attempt>startup:c",
      "attempt>wait:c",
      "dependency>integration:a",
      "work>work:a",
      "attempt>startup:a",
      "attempt>wait:a",
    ]);
    expect(report.operations.chain.incomplete).toBe(false);
    expect(report.operations.chain.stoppedBecause).toBeUndefined();
    expect(report.operations.chain.ambiguous).toEqual([]);

    expect(report.delivery.workItems).toBe(3);
    expect(report.delivery.attempts).toBe(3);
    expect(report.delivery.firstAttempt).toMatchObject({ succeeded: 3, denominator: 3 });
    expect(nonZero(report.delivery.outcomes.counts)).toEqual({ landed: 3 });
  }, 120_000);

  it("2: a material finding, a repair attempt and a clean second examination", async () => {
    let attempt = 0;
    const r = await rig({
      work: {
        alpha: async (context) => {
          await addModule("alpha")(context);
          // Each attempt is a different change: each starts from the same head,
          // and the same change keeps its verdict (PIP-30).
          attempt += 1;
          await edit(
            context.worktree,
            "src/attempt.js",
            (text) => `${text}// attempt ${attempt}
`,
          );
        },
      },
      examiner: (call) => (call === 1 ? "findings" : "pass"),
    });
    const job = await r.submit("alpha module", { risk: "medium" });
    expect(await r.until(job.nodeId, settled)).toBe("failed");
    await r.idle();
    expect(await r.engine.retry(job.jobId)).toBe(true);
    expect(await r.until(job.nodeId, (status) => status === "integrated")).toBe("integrated");
    await r.idle();
    const report = await reportOf(r);
    const observed = await observationsOf(r);

    const [e1, e2] = [
      ...(await r.world.stores.examinations.listByNode(r.world.scope, job.nodeId)),
    ].sort((x, y) => x.createdAt.localeCompare(y.createdAt));
    expect(e1?.outcome).toBe("findings_raised");
    expect(e2?.outcome).toBe("passed");
    const routes = await r.world.stores.routingDecisions.listByNode(r.world.scope, job.nodeId);
    const attempts = routes
      .filter((route) => route.purpose === undefined)
      .sort((x, y) => x.attempt - y.attempt);
    expect(attempts.map((route) => route.attempt)).toEqual([1, 2]);
    expect(attempts[0]?.causes).toBeUndefined();
    expect(attempts[1]?.causes).toEqual([
      { kind: "examination_findings", examinationId: e1?.examinationId, findingIds: ["F-01"] },
    ]);

    // Review: one unique finding, fixed by the second examination.
    const { review } = report;
    expect(review.findings).toHaveLength(1);
    const [finding] = review.findings;
    expect(finding).toMatchObject({
      nodeId: job.nodeId,
      severity: "material",
      latest: "fixed",
      open: false,
      fixedBy: e2?.examinationId,
      linkage: "linked",
      repairAttempts: [attempts[1]?.routingDecisionId],
    });
    expect(finding?.occurrences).toHaveLength(1);
    expect(review.dispositions.unique).toBe(1);
    expect(nonZero(review.dispositions.byLatest)).toEqual({ fixed: 1 });
    expect(review.linkage).toEqual({
      findings: { linked: 1, unresolved: 0, unknown: 0 },
      helpersUnlinked: 0,
      repairsWithoutFindings: 0,
    });
    expect(review.coverage.examinations.total).toBe(2);
    expect(review.coverage.examinedNodes).toBe(1);
    expect(review.coverage.landedUnexamined).toBe(0);
    expect(review.coverage.skipped).toBe(0);

    // The examiner's two calls and the repair attempt are reported apart, each with its tally.
    expect(review.overhead.examiner.calls).toBe(2);
    expect(review.overhead.answerer.calls).toBe(0);
    expect(review.overhead.arbiter.calls).toBe(0);
    expect(review.repairs.attempts).toBe(1);
    expect(review.overhead.examiner.resources.coverage).toEqual({
      complete: 0,
      partial: 0,
      unknown: 2,
      legacy: 0,
      missing: 0,
    });
    expect(review.repairs.resources.coverage).toEqual({
      complete: 0,
      partial: 0,
      unknown: 1,
      legacy: 0,
      missing: 0,
    });

    // Delivery: the job did not land at its first attempt.
    expect(report.delivery.firstAttempt).toMatchObject({ succeeded: 0, denominator: 1, rate: 0 });
    expect(nonZero(report.delivery.outcomes.counts)).toEqual({ landed: 1 });
    expect(report.delivery.rework.attempts).toBe(1);
    expect(report.delivery.rework.byCause.map((row) => [row.kind, row.attempts])).toEqual([
      ["examination_findings", 1],
    ]);

    // The record: two examinations, two attempts, one integration.
    const examinations = report.operations.operations.filter(
      (operation) => operation.phase === "examination",
    );
    expect(examinations.map((operation) => [operation.state, operation.reason])).toEqual([
      ["closed", "verdict: findings_raised"],
      ["closed", "verdict: passed"],
    ]);
    expect(observed.filter((o) => o.phase === "work" && o.transition === "end")).toHaveLength(2);
    expect(sequenceOf(observed, opId("wait", job.nodeId, 2))).toEqual(["start", "end:started"]);
    expect(report.operations.endings).toMatchObject({ integrated: 1, examination_stopped: 0 });
  }, 120_000);

  it("3: a replay that conflicts with what landed before it is retried and lands", async () => {
    const hold = barrier();
    const r = await rig({
      work: {
        seed: seedShared,
        first: editLine(5, "first changed line 5"),
        // Both edit line 5 from the same head; this one is ready only after the other landed.
        second: async (context) => {
          await hold.opened;
          await editLine(5, "second changed line 5")(context);
        },
      },
    });
    const seed = await r.submit("seed module");
    expect(await r.until(seed.nodeId, settled)).toBe("integrated");
    await r.idle();
    const first = await r.submit("first module");
    const second = await r.submit("second module");
    expect(await r.until(first.nodeId, settled)).toBe("integrated");
    hold.open();
    expect(await r.until(second.nodeId, settled)).toBe("failed");
    await r.idle();
    expect(await r.engine.retry(second.jobId)).toBe(true);
    expect(await r.until(second.nodeId, (status) => status === "integrated")).toBe("integrated");
    await r.idle();
    const report = await reportOf(r);
    const observed = await observationsOf(r);

    const routes = (await r.world.stores.routingDecisions.listByNode(r.world.scope, second.nodeId))
      .filter((route) => route.purpose === undefined)
      .sort((x, y) => x.attempt - y.attempt);
    expect(routes.map((route) => route.attempt)).toEqual([1, 2]);
    expect(routes[1]?.causes).toEqual([{ kind: "integration_conflict", paths: ["src/shared.js"] }]);

    const integrations = intervalsOf(report, second.nodeId, "integration");
    expect(
      integrations.map((operation) => [operation.attempt, operation.state, operation.reason]),
    ).toEqual([
      [1, "closed", "integration_conflict"],
      [2, "closed", "integrated"],
    ]);
    expect(sequenceOf(observed, opId("integration", second.nodeId, 1))).toEqual([
      "start",
      "note:conflict",
      "end:integration_conflict",
    ]);
    expect(report.operations.endings).toMatchObject({
      integrated: 3,
      integration_conflict: 1,
      verification_failed: 0,
    });

    expect(report.delivery.workItems).toBe(3);
    expect(report.delivery.attempts).toBe(4);
    expect(report.delivery.firstAttempt).toMatchObject({ succeeded: 2, denominator: 3 });
    expect(nonZero(report.delivery.outcomes.counts)).toEqual({ landed: 3 });
    expect(report.delivery.rework.attempts).toBe(1);
    expect(report.delivery.rework.byCause.map((row) => [row.kind, row.attempts])).toEqual([
      ["integration_conflict", 1],
    ]);
    expect(report.review.coverage.landedUnexamined).toBe(3);
  }, 120_000);

  it("4: a job cancelled while queued ends its wait withdrawn and is counted cancelled", async () => {
    const finish = barrier();
    const r = await rig({
      work: { alpha: addModule("alpha", finish.opened), beta: addModule("beta") },
      maxConcurrency: 1,
    });
    const a = await r.submit("alpha module");
    const b = await r.submit("beta module");
    expect(await r.status(b.nodeId)).toBe("queued");
    expect(await r.engine.cancel(b.jobId)).toBe(true);
    finish.open();
    expect(await r.until(a.nodeId, settled)).toBe("integrated");
    await r.idle();
    const report = await reportOf(r);
    const observed = await observationsOf(r);

    expect(sequenceOf(observed, opId("wait", b.nodeId, 1))).toEqual([
      "start",
      "note:blockers changed",
      "end:withdrawn",
    ]);
    const [wait] = intervalsOf(report, b.nodeId, "wait");
    expect(wait).toMatchObject({ state: "closed", reason: "withdrawn" });
    expect(wait?.blockerSpans.map((span) => blockersOf(span.blockers))).toEqual([
      [`parent_slot:${r.world.session.rootNodeId}`],
    ]);
    expect(Object.keys(report.operations.unions.waitByBlockerKind)).toEqual(["parent_slot"]);
    expect(report.operations.operations.filter((o) => o.nodeId === b.nodeId)).toHaveLength(1);

    expect(nonZero(report.delivery.outcomes.counts)).toEqual({ landed: 1, cancelled: 1 });
    expect(report.delivery.workItems).toBe(2);
    expect(report.delivery.attempts).toBe(1);
    expect(report.delivery.firstAttempt).toMatchObject({ succeeded: 1, denominator: 2 });
    expect(report.operations.endings).toMatchObject({ integrated: 1 });
  }, 120_000);

  it("5: a failed check, a deferred check and a skipped examination", async () => {
    let prerequisite: "pending" | "satisfied" = "satisfied";
    const hp = (): Prerequisite =>
      prerequisite === "pending"
        ? {
            id: "HP-01",
            description: "The deploy credential is in place.",
            remediation: "Ask the owner.",
            verifyCommand: "true",
            status: "pending",
          }
        : {
            id: "HP-01",
            description: "The deploy credential is in place.",
            remediation: "Ask the owner.",
            verifyCommand: "true",
            status: "satisfied",
            lastCheck: { exitCode: 0, checkedAt: "2026-09-15T12:00:00.000Z" as never },
          };
    const r = await rig({
      work: { broken: brokenTest, deferred: addModule("deferred"), unseen: addModule("unseen") },
      program: {
        verification: [
          { id: "test", command: "node --test" },
          { id: "gate", command: 'node -e "process.exit(0)"', requires: ["HP-01"] },
        ],
        prerequisites: [hp()],
      },
      prerequisites: () => [hp()],
      examiner: () => "nothing",
    });
    // Later work lands on the provisional line once anything is deferred, so the deferral is last.
    const failing = await r.submit("broken module");
    expect(await r.until(failing.nodeId, settled)).toBe("verification_failed");
    const unseen = await r.submit("unseen module", { risk: "high" });
    expect(await r.until(unseen.nodeId, settled)).toBe("integrated");
    await r.idle();
    prerequisite = "pending";
    const deferred = await r.submit("deferred module");
    expect(await r.until(deferred.nodeId, (status) => status === "deferred")).toBe("deferred");
    await r.idle();
    const report = await reportOf(r);
    const observed = await observationsOf(r);

    expect(sequenceOf(observed, opId("integration", failing.nodeId, 1))).toEqual([
      "start",
      "note:verification: failed",
      "end:verification_failed",
    ]);
    expect(sequenceOf(observed, opId("integration", deferred.nodeId, 1))).toEqual([
      "start",
      "note:verification: deferred",
      "end:deferred",
    ]);
    expect(sequenceOf(observed, opId("integration", unseen.nodeId, 1))).toEqual([
      "start",
      "note:verification: passed",
      "note:examination: skipped",
      "end:integrated",
    ]);
    expect(report.operations.endings).toEqual({
      integrated: 1,
      merged: 0,
      integration_conflict: 0,
      verification_failed: 1,
      deferred: 1,
      examination_stopped: 0,
      failed: 0,
      other: 0,
      examinationSkipped: 1,
    });

    // The deferred node is not landed: it is unfinished, and outside the first-attempt denominator.
    expect(nonZero(report.delivery.outcomes.counts)).toEqual({
      landed: 1,
      verification_failed: 1,
      unfinished: 1,
    });
    expect(report.delivery.firstAttempt).toMatchObject({
      succeeded: 1,
      denominator: 2,
      unfinished: 1,
    });
    expect(report.review.coverage).toMatchObject({
      skipped: 1,
      landedUnexamined: 1,
      examinedNodes: 0,
    });
    expect(report.review.coverage.examinations.total).toBe(0);
    expect(report.review.findings).toEqual([]);
  }, 120_000);

  it("6: a job merged onto a strand whose landing fails is merged_strand_not_landed", async () => {
    const { nodes, report } = await failedStrand();
    const strand = nodes.find((node) => node.kind === "sub-program");
    const job = nodes.find((node) => node.kind === "job");
    expect(strand?.status).toBe("failed");
    expect(job?.status).toBe("merged");

    expect(report.delivery.strands).toBe(1);
    expect(report.delivery.workItems).toBe(1);
    expect(nonZero(report.delivery.outcomes.counts)).toEqual({ merged_strand_not_landed: 1 });
    // In the denominator, and not a success.
    expect(report.delivery.firstAttempt).toMatchObject({
      succeeded: 0,
      denominator: 1,
      unfinished: 0,
      rate: 0,
    });
    expect(report.review.coverage.landedUnexamined).toBe(0);
    expect(report.review.coverage.examinedByStrand).toBe(0);
    expect(report.review.coverage.skipped).toBe(0);
    expect(report.operations.endings).toMatchObject({
      merged: 1,
      verification_failed: 1,
      integrated: 0,
    });
  }, 180_000);

  it("7: an examination that stops a job, an overturned dispute and the readmit", async () => {
    const r = await rig({
      work: {
        seed: seedShared,
        first: editLine(5, "first changed line 5"),
        second: editLine(2, "second changed line 2"),
      },
      examiner: (call) => (call >= 2 ? "findings" : "pass"),
    });
    const seed = await r.submit("seed module");
    expect(await r.until(seed.nodeId, settled)).toBe("integrated");
    await r.idle();
    const first = await r.submit("first module");
    const second = await r.submit("second module", { risk: "high" });
    expect(await r.until(first.nodeId, settled)).toBe("integrated");
    expect(await r.until(second.nodeId, settled)).toBe("examination_failed");
    await r.idle();
    expect(await r.engine.dispute(second.jobId, "the finding does not apply")).toEqual({
      kind: "overturned",
      nodeId: second.nodeId,
    });
    expect(await r.until(second.nodeId, settled)).toBe("integrated");
    await r.idle();
    const report = await reportOf(r);
    const observed = await observationsOf(r);

    // No new work attempt: one routing decision, one worker, no second work operation.
    const routes = (
      await r.world.stores.routingDecisions.listByNode(r.world.scope, second.nodeId)
    ).filter((route) => route.purpose === undefined);
    expect(routes.map((route) => route.attempt)).toEqual([1]);
    expect(r.workers.filter((name) => name === "second")).toHaveLength(1);
    expect(sequenceOf(observed, opId("work", second.nodeId, 2))).toEqual([]);

    // Two queue and integration occurrences; the second began as readmitted and integrated.
    const queue = intervalsOf(report, second.nodeId, "queue");
    expect(queue.map((operation) => [operation.occurrence, operation.state])).toEqual([
      [1, "closed"],
      [2, "closed"],
    ]);
    expect(sequenceOf(observed, opId("queue", second.nodeId, 1))).toEqual([
      "start",
      "end:integrating",
      "start:readmitted",
      "end:integrating",
    ]);
    const integration = intervalsOf(report, second.nodeId, "integration");
    expect(integration.map((operation) => [operation.occurrence, operation.reason])).toEqual([
      [1, "examination_stopped"],
      [2, "integrated"],
    ]);
    const readmitted = observed.filter(
      (o) =>
        o.operationId === opId("integration", second.nodeId, 1) &&
        o.transition === "start" &&
        o.reason === "readmitted",
    );
    expect(readmitted).toHaveLength(1);

    // Counted landed, with one work attempt.
    expect(nonZero(report.delivery.outcomes.counts)).toEqual({ landed: 3 });
    expect(report.delivery.attempts).toBe(3);
    expect(report.delivery.firstAttempt).toMatchObject({ succeeded: 3, denominator: 3 });
    expect(report.delivery.rework.attempts).toBe(0);
    expect(report.operations.endings).toMatchObject({ integrated: 3, examination_stopped: 1 });

    // The finding was overturned by the arbiter, who is overhead, not a repair.
    expect(report.review.findings).toHaveLength(1);
    expect(report.review.findings[0]).toMatchObject({ latest: "overturned", linkage: "linked" });
    expect(report.review.overhead.arbiter.calls).toBe(1);
    expect(report.review.overhead.examiner.calls).toBe(2);
    expect(report.review.repairs.attempts).toBe(0);
  }, 180_000);

  it("8: a restarted engine recovers a queued wait and leaves an unobserved end open", async () => {
    const release = barrier();
    const r = await rig({
      work: {
        orphan: () => new Promise<never>(() => {}),
        leaver: async () => {
          await release.opened;
        },
        beta: addModule("beta"),
      },
      maxConcurrency: 2,
    });
    const orphan = await r.submit("orphan module");
    const leaver = await r.submit("leaver module");
    const queued = await r.submit("beta module");
    expect(await r.status(queued.nodeId)).toBe("queued");

    // The process stops; the leaver's agent is lost, the orphan's end is never seen.
    await r.engine.close("restart", { preserveWork: true });
    await Promise.all(
      r.engine
        .jobs()
        .filter((job) => job.nodeId === leaver.nodeId)
        .map((job) => job.stop("interrupted")),
    );
    const next = createEngine({
      environment: r.environment,
      session: r.world.session,
      mcp: mcpFor,
      route: () => choice(BUILDER),
    });
    await next.recover();
    expect(await r.until(queued.nodeId, settled)).toBe("integrated");
    await vi.waitFor(() => expect(next.idle()).toBe(true), { timeout: 30_000 });
    const report = await reportOf(r);
    const observed = await observationsOf(r);

    // The queued node's wait: two starts, the second recovered, one end: one closed interval.
    const sequence = sequenceOf(observed, opId("wait", queued.nodeId, 1));
    expect(sequence.filter((entry) => entry.startsWith("start"))).toEqual([
      "start",
      "start:recovered",
    ]);
    expect(sequence.filter((entry) => entry.startsWith("end"))).toEqual(["end:started"]);
    const waits = intervalsOf(report, queued.nodeId, "wait");
    expect(waits).toHaveLength(1);
    expect(waits[0]?.state).toBe("closed");
    expect(waits[0]?.durationMs).toBeGreaterThan(0);

    // The orphan's work has a start and no observed end: open, never closed by the report's time.
    const [work] = intervalsOf(report, orphan.nodeId, "work");
    expect(work?.state).toBe("open");
    expect(work?.endedAt).toBeUndefined();
    expect(work?.durationMs).toBeUndefined();
    const startedAt = Date.parse(work?.startedAt ?? "");
    expect(report.operations.ambiguousMs).toBe(Date.parse(report.asOf) - startedAt);
    expect(report.operations.ambiguousMs).toBeGreaterThan(0);
    expect(report.operations.nodes.find((n) => n.nodeId === orphan.nodeId)?.openCount).toBe(1);
    // Inside no union: only the other nodes' work is summed.
    const closedWork = report.operations.operations
      .filter((operation) => operation.phase === "work" && operation.state === "closed")
      .map((operation) => operation.durationMs ?? 0);
    expect(report.operations.unions.work).toBe(closedWork.reduce((sum, ms) => sum + ms, 0));

    // The leaver's interrupted work is closed; the chain walks the node that landed.
    expect(intervalsOf(report, leaver.nodeId, "work")[0]).toMatchObject({
      state: "closed",
      reason: "interrupted",
    });
    expect(report.operations.chain.steps[0]?.nodeId).toBe(queued.nodeId);
    expect(report.operations.chain.incomplete).toBe(true);
    expect(report.operations.chain.stoppedBecause).toBe("capacity wait: unattributed");

    expect(nonZero(report.delivery.outcomes.counts)).toEqual({
      landed: 1,
      interrupted: 1,
      unfinished: 1,
    });
    expect(report.delivery.firstAttempt).toMatchObject({
      succeeded: 1,
      denominator: 2,
      unfinished: 1,
    });
    await next.close("test is done", { preserveWork: true });
  }, 120_000);
});
