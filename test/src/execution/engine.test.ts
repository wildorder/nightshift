/**
 * The engine and the merge queue (P6 T2, T3), over the fake harness and **real
 * git**: real worktrees, real snapshot commits, real replays, a real
 * verification runner, and the production API handler over loopback.
 *
 * Ordering is forced with barriers, never with timing: a worker's script waits
 * on a promise the test resolves, and the merge queue is held behind a gate, so
 * "B finished before A" and "both were ready when the queue looked" are facts
 * rather than races.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type ExecutionNodeId,
  type JobContract,
  JobContractSchema,
  type Prerequisite,
  type ProgramContract,
  type RouteChoice,
  type Strand,
} from "@nightshift/contracts";
import { isSettled, nowIso } from "@nightshift/core";
import {
  completeJob,
  createEngine,
  createEventOutbox,
  createMergeQueue,
  type Engine,
  type ExecutionEnvironment,
  git,
  type MergeQueue,
  type PrerequisiteBook,
  provisionalHead,
  resumeDeferred,
  revParse,
  StrandBlockedError,
  StrandDelegationError,
  shutdown,
  startJob,
} from "@nightshift/execution";
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeHarness, type ScriptContext } from "./fake-harness.js";
import { cleanupWorlds, createWorld, eventsOf, PROGRAM_BRANCH, type World } from "./world.js";

afterEach(cleanupWorlds);

const ROUTE: RouteChoice = {
  target: { harness: "fake", provider: "anthropic", model: "claude-sonnet-5" },
  eligibleOptions: [
    {
      target: { harness: "fake", provider: "anthropic", model: "claude-sonnet-5" },
      eligible: true,
    },
  ],
  ruleId: "p5-configured",
  wasOverride: false,
};

/** A promise a test resolves by hand: the only clock these tests use. */
const barrier = () => {
  let open = (): void => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
};

type Work = (context: ScriptContext) => Promise<void>;

/** What each job does, keyed by the first word of its objective. */
const harnessFor = (world: () => World, work: Readonly<Record<string, Work>>) =>
  createFakeHarness({
    script: async (context) => {
      const name = context.input.job.objective.split(" ")[0] ?? "";
      const stopped = await Promise.race([
        (work[name] ?? (async () => {}))(context).then(() => false),
        context.cancelled.then(() => true),
      ]);
      if (stopped) return { kind: "cancelled" };
      const w = world();
      const outbox = createEventOutbox({
        events: w.stores.events,
        scope: context.identity.scope,
        clock: w.environment.clock,
        ids: w.ids,
        writerId: context.identity.agentId,
        initialDelayMs: 1,
      });
      const environment = { stores: w.stores, clock: w.environment.clock, git: w.git, outbox };
      await completeJob(environment, context.identity, `${name}: done`);
      await outbox.flush();
      return { kind: "completed" };
    },
  });

const edit = async (worktree: string, path: string, change: (text: string) => string) => {
  const file = join(worktree, path);
  const existing = await readFile(file, "utf8").catch(() => "");
  await writeFile(file, change(existing), "utf8");
};

/** A new module and its own test: touches nothing another job touches. */
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

const mcp = () => ({ name: "nightshift", command: process.execPath, args: ["--version"], env: {} });

interface Rig {
  readonly world: World;
  readonly engine: Engine;
  readonly queue: MergeQueue;
  /**
   * Lets the merge queue see what has finished, once `candidates` of them are
   * waiting at the gate. A node being `implemented` is not enough: its candidate
   * reaches the queue only after its worker's exit has been recorded, and "both
   * were ready when the queue looked" has to be a fact on a slow machine too.
   */
  releaseQueue(candidates: number): Promise<void>;
  submit(
    objective: string,
    strandId?: string,
  ): Promise<{ jobId: JobContract["jobContractId"]; nodeId: ExecutionNodeId }>;
  status(nodeId: ExecutionNodeId): Promise<string>;
  until(nodeId: ExecutionNodeId, predicate: (status: string) => boolean): Promise<string>;
}

/** What verification commands declared mid-run, across the current rig. */
let discoveredHurdles: { id: string; description: string; remediation: string }[] = [];

const rig = async (
  work: Readonly<Record<string, Work>>,
  options: {
    maxConcurrency?: number;
    gated?: boolean;
    strands?: readonly Strand[];
    program?: Partial<ProgramContract>;
    /** The prerequisites as the control plane would answer them, read on every verification. */
    prerequisites?: () => readonly Prerequisite[];
  } = {},
): Promise<Rig> => {
  let world: World | undefined;
  const made = await createWorld({
    harness: harnessFor(() => world as World, work),
    program: {
      delegationLimits: { maxDepth: 2, maxConcurrency: options.maxConcurrency ?? 3 },
      ...options.program,
    },
  });
  world = made;
  const book: PrerequisiteBook = {
    prerequisites: async () => options.prerequisites?.() ?? [],
    recordDiscovered: async (_scope, id, hurdle) => {
      discoveredHurdles.push({ id, ...hurdle });
      return {
        id,
        description: hurdle.description,
        remediation: hurdle.remediation,
        verifyCommand: hurdle.verifyCommand,
        status: "pending",
        discoveredInRunId: hurdle.runId,
      };
    },
  };
  const environment: ExecutionEnvironment =
    options.prerequisites === undefined
      ? made.environment
      : { ...made.environment, prerequisites: book };

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
  // A planned run is the same run with strands on its contract: the engine reads
  // the plan from its session, and ratification is the API's and the CLI's to prove.
  const session =
    options.strands === undefined
      ? made.session
      : {
          ...made.session,
          program: {
            ...made.session.program,
            status: "planning" as const,
            strands: [...options.strands],
          },
        };
  const engine = createEngine({ environment, session, mcp, mergeQueue: queue });

  const status = async (nodeId: ExecutionNodeId): Promise<string> =>
    (await made.stores.executionNodes.get(made.scope, nodeId))?.status ?? "missing";

  return {
    world: made,
    engine,
    queue,
    releaseQueue: async (candidates) => {
      await vi.waitFor(() => expect(atGate).toBeGreaterThanOrEqual(candidates), {
        timeout: 30_000,
      });
      gate.open();
    },
    submit: async (objective, strandId) => {
      const job = JobContractSchema.parse({
        schemaVersion: 1,
        ...made.scope,
        jobContractId: made.ids.next("job"),
        objective,
        scope: { includes: ["src/**", "test/**"] },
        acceptance: ["node --test passes"],
        dependencies: [],
        risk: "low",
        ambiguity: "low",
        ...(strandId === undefined ? {} : { strandId }),
        createdAt: nowIso(made.environment.clock),
      });
      const submitted = await engine.submit({
        job,
        scope: made.session.program.scope,
        depth: 1,
        parentNodeId: made.session.rootNodeId,
        route: ROUTE,
      });
      return { jobId: job.jobContractId, nodeId: submitted.nodeId };
    },
    status,
    until: async (nodeId, predicate) => {
      const deadline = Date.now() + 30_000;
      let last = await status(nodeId);
      while (!predicate(last)) {
        if (Date.now() > deadline) throw new Error(`node ${nodeId} is still ${last}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
        last = await status(nodeId);
      }
      return last;
    },
  };
};

const settled = (status: string): boolean => isSettled(status as never);
const log = (world: World): Promise<string> =>
  git(world.git, ["log", "--format=%s", `${world.baseCommit}..${PROGRAM_BRANCH}`], {
    cwd: world.repo,
  });

describe("the engine schedules (D-P6-01, D-P6-02)", () => {
  it("runs two jobs at once, each in its own worktree, and integrates both", async () => {
    const both = barrier();
    let running = 0;
    const together: Work = async (context) => {
      running += 1;
      if (running === 2) both.open();
      // Neither finishes until both are running: overlap is a fact, not a guess.
      await both.opened;
      await addModule(context.input.job.objective.split(" ")[0] ?? "x")(context);
    };
    const r = await rig({ alpha: together, beta: together });
    const a = await r.submit("alpha module");
    const b = await r.submit("beta module");

    expect(await r.until(a.nodeId, settled)).toBe("integrated");
    expect(await r.until(b.nodeId, settled)).toBe("integrated");

    // SC-P6-07: each snapshot holds its own job's files and not the other's.
    const events = await eventsOf(r.world);
    const implemented = events.filter((event) => event.type === "node.implemented");
    expect(implemented).toHaveLength(2);
    for (const event of implemented) {
      const paths = (event.payload as { changedPaths: string[] }).changedPaths;
      const own = event.executionNodeId === a.nodeId ? "alpha" : "beta";
      expect(paths.sort()).toEqual([`src/${own}.js`, `test/${own}.test.js`]);
    }
  });

  it("queues a job past the limit, says why, and starts it when a slot frees", async () => {
    const finish = barrier();
    const r = await rig(
      { first: addModule("first", finish.opened), second: addModule("second") },
      { maxConcurrency: 1 },
    );
    const first = await r.submit("first module");
    const second = await r.submit("second module");

    expect(await r.status(first.nodeId)).toBe("running");
    expect(await r.status(second.nodeId)).toBe("queued");
    expect(r.engine.waiting(second.jobId)).toEqual({
      kind: "parent_full",
      running: 1,
      maxConcurrency: 1,
    });
    // A queued node has no agent, no token and no worktree yet.
    expect(await r.world.stores.agents.listByNode(r.world.scope, second.nodeId)).toEqual([]);
    expect(r.engine.snapshot().queued).toEqual([second.nodeId]);

    finish.open();
    expect(await r.until(second.nodeId, settled)).toBe("integrated");
    expect(await r.status(first.nodeId)).toBe("integrated");
    // A job leaves the registry when its whole lifecycle has, a write or two
    // after its node settles.
    await vi.waitFor(() => expect(r.engine.idle()).toBe(true), { timeout: 5_000 });
  });

  it("leaves nothing behind when the API refuses a start: not yet is not a failure", async () => {
    const hold = barrier();
    const r = await rig({ first: addModule("first", hold.opened) }, { maxConcurrency: 1 });
    const first = await r.submit("first module");
    const second = await r.submit("second module");
    const queued = await r.world.stores.executionNodes.get(r.world.scope, second.nodeId);

    // Straight at the runner, past the engine's own check: the API is what holds.
    await expect(
      startJob(r.world.environment, {
        session: r.world.session,
        job: (await r.world.stores.jobContracts.get(r.world.scope, second.jobId)) as JobContract,
        node: queued as never,
        route: ROUTE,
        mcp,
      }),
    ).rejects.toMatchObject({ code: "concurrency_limit_exceeded" });
    expect(await r.status(second.nodeId)).toBe("queued");
    expect(await r.world.stores.agents.listByNode(r.world.scope, second.nodeId)).toEqual([]);

    hold.open();
    await r.until(first.nodeId, settled);
    await r.until(second.nodeId, settled);
  });

  it("withdraws a queued job on cancel, and stops a running one", async () => {
    const never = barrier();
    const r = await rig({ first: addModule("first", never.opened) }, { maxConcurrency: 1 });
    const first = await r.submit("first module");
    const second = await r.submit("second module");

    expect(await r.engine.cancel(second.jobId)).toBe(true);
    expect(await r.status(second.nodeId)).toBe("cancelled");
    expect(await r.engine.cancel(first.jobId)).toBe(true);
    expect(await r.until(first.nodeId, settled)).toBe("cancelled");
    await vi.waitFor(() => expect(r.engine.idle()).toBe(true), { timeout: 5_000 });
  });

  it("starts nothing once the wall clock is spent, and says so", async () => {
    const world = await createWorld({
      harness: harnessFor(() => world, { late: addModule("late") }),
      // The world's clock steps a second a reading; a one-second budget is gone
      // before the first delegation is recorded.
      program: { costPolicy: { maxWallClockSeconds: 1 } },
    });
    const engine = createEngine({ environment: world.environment, session: world.session, mcp });
    const job = JobContractSchema.parse({
      schemaVersion: 1,
      ...world.scope,
      jobContractId: world.ids.next("job"),
      objective: "late module",
      scope: { includes: ["src/**"] },
      acceptance: ["x"],
      dependencies: [],
      risk: "low",
      ambiguity: "low",
      createdAt: nowIso(world.environment.clock),
    });
    const submitted = await engine.submit({
      job,
      scope: world.session.program.scope,
      depth: 1,
      parentNodeId: world.session.rootNodeId,
      route: ROUTE,
    });
    expect(submitted.status).toBe("queued");
    expect(engine.waiting(job.jobContractId)).toEqual({
      kind: "wall_clock_spent",
      maxWallClockSeconds: 1,
    });
    expect(engine.snapshot().wallClockRemainingSeconds).toBe(0);
    await engine.close("test over");
  });
});

describe("the merge queue (D-P6-05, D-P6-06)", () => {
  it("integrates in delegation order among what is ready, rebasing the stale one", async () => {
    const aMayFinish = barrier();
    const r = await rig(
      { alpha: addModule("alpha", aMayFinish.opened), beta: addModule("beta") },
      { gated: true },
    );
    const a = await r.submit("alpha module");
    const b = await r.submit("beta module");

    // B finishes first, then A. Both are ready before the queue looks at either.
    await r.until(b.nodeId, (status) => status === "implemented");
    aMayFinish.open();
    await r.until(a.nodeId, (status) => status === "implemented");
    await r.releaseQueue(2);

    expect(await r.until(a.nodeId, settled)).toBe("integrated");
    expect(await r.until(b.nodeId, settled)).toBe("integrated");

    // SC-P6-08: A was delegated first, so A landed first, though it finished last.
    expect((await log(r.world)).trim().split("\n")).toEqual(["beta: done", "alpha: done"]);

    // SC-P6-09: B's base was stale by then. Detected, recorded, verified, landed.
    const rebased = (await eventsOf(r.world)).filter((event) => event.type === "node.rebased");
    expect(rebased.map((event) => event.executionNodeId)).toEqual([b.nodeId]);
    expect(rebased[0]?.payload).toMatchObject({ staleBase: r.world.baseCommit });
    const tip = await git(r.world.git, ["log", "-1", "--format=%B", PROGRAM_BRANCH], {
      cwd: r.world.repo,
    });
    expect(tip).toContain("Nightshift-Rebased-From:");
    expect(tip).toContain(`Nightshift-Node: ${b.nodeId}`);
  });

  it("never resolves a conflict: one lands, one fails with the paths, and a retry recovers it", async () => {
    const rewrite =
      (body: string): Work =>
      async ({ worktree }) =>
        edit(worktree, "src/math.js", () => `export const sum = (xs) => ${body};\n`);
    const r = await rig(
      {
        loop: rewrite("xs.reduce((t, x) => t + x, 0)"),
        strict: rewrite("xs.reduce((total, value) => total + Number(value), 0)"),
      },
      { gated: true },
    );
    const a = await r.submit("loop rewrite of sum");
    const b = await r.submit("strict rewrite of sum");
    await r.until(a.nodeId, (status) => status === "implemented");
    await r.until(b.nodeId, (status) => status === "implemented");
    await r.releaseQueue(2);

    expect(await r.until(a.nodeId, settled)).toBe("integrated");
    expect(await r.until(b.nodeId, settled)).toBe("failed");
    await r.queue.idle();

    // SC-P6-10: explicit recovery state, and nothing of B's on the branch.
    const node = await r.world.stores.executionNodes.get(r.world.scope, b.nodeId);
    expect(node?.outcomeReason).toContain("integration_conflict");
    expect(node?.outcomeReason).toContain("src/math.js");
    const conflict = (await eventsOf(r.world)).find(
      (event) => event.type === "integration.conflict",
    );
    expect(conflict?.payload).toMatchObject({ conflicts: ["src/math.js"] });
    expect(await readFile(join(r.world.repo, "src", "math.js"), "utf8")).toContain("(t, x)");

    // The retry runs the job again from the current head, as a second attempt.
    expect(await r.engine.retry(b.jobId)).toBe(true);
    expect(await r.until(b.nodeId, settled)).toBe("integrated");
    expect(await readFile(join(r.world.repo, "src", "math.js"), "utf8")).toContain("Number(value)");

    const routes = await r.world.stores.routingDecisions.listByNode(r.world.scope, b.nodeId);
    const attempts = [...routes].sort((x, y) => x.attempt - y.attempt);
    expect(attempts.map((route) => route.attempt)).toEqual([1, 2]);
    expect(attempts[1]?.previousRouteId).toBe(attempts[0]?.routingDecisionId);
    expect(await r.world.stores.agents.listByNode(r.world.scope, b.nodeId)).toHaveLength(2);
    // Nothing that is not retryable is retried.
    expect(await r.engine.retry(a.jobId)).toBe(false);
  });

  it("catches two jobs that are each green alone and broken together", async () => {
    const rename: Work = async ({ worktree }) => {
      await edit(worktree, "src/math.js", (text) =>
        text.replace("export const sum", "export const total"),
      );
      await edit(worktree, "src/index.js", () => 'export { total } from "./math.js";\n');
      await edit(worktree, "test/math.test.js", (text) => text.replaceAll("sum", "total"));
    };
    const caller: Work = async ({ worktree }) => {
      await edit(
        worktree,
        "src/mean.js",
        () =>
          'import { sum } from "./math.js";\nexport const mean = (xs) => sum(xs) / xs.length;\n',
      );
      await edit(
        worktree,
        "test/mean.test.js",
        () =>
          'import { test } from "node:test";\nimport assert from "node:assert/strict";\n' +
          'import { mean } from "../src/mean.js";\ntest("mean", () => assert.equal(mean([2, 4]), 3));\n',
      );
    };
    const r = await rig({ rename, caller }, { gated: true });
    const a = await r.submit("rename sum to total");
    const b = await r.submit("caller of sum");
    await r.until(a.nodeId, (status) => status === "implemented");
    await r.until(b.nodeId, (status) => status === "implemented");
    await r.releaseQueue(2);

    // SC-P6-11: no textual conflict at all, so the replay is clean; verification,
    // on the head it would land on, is what finds it.
    expect(await r.until(a.nodeId, settled)).toBe("integrated");
    expect(await r.until(b.nodeId, settled)).toBe("verification_failed");
    const verifications = await r.world.stores.verifications.listByNode(r.world.scope, b.nodeId);
    expect(verifications.map((verification) => verification.outcome)).toEqual(["failed"]);
    expect((await log(r.world)).trim()).toBe("rename: done");
  });

  it("lands only commits that were verified as themselves (A-05, SC-P6-15)", async () => {
    const r = await rig({
      one: addModule("one"),
      two: addModule("two"),
      three: addModule("three"),
    });
    const nodes = [
      await r.submit("one module"),
      await r.submit("two module"),
      await r.submit("three module"),
    ];
    for (const node of nodes) expect(await r.until(node.nodeId, settled)).toBe("integrated");

    const commits = (
      await git(r.world.git, ["rev-list", `${r.world.baseCommit}..${PROGRAM_BRANCH}`], {
        cwd: r.world.repo,
      })
    )
      .trim()
      .split("\n");
    expect(commits).toHaveLength(3);
    const passed = new Set<string>();
    for (const node of nodes) {
      for (const verification of await r.world.stores.verifications.listByNode(
        r.world.scope,
        node.nodeId,
      )) {
        if (verification.outcome === "passed") passed.add(verification.commitSha);
      }
    }
    for (const commit of commits) expect(passed.has(commit), commit).toBe(true);
    expect(await revParse(r.world.git, r.world.repo, PROGRAM_BRANCH)).toBe(commits[0]);
  });
});

describe("shutdown covers the whole tree (D-P6-08, SC-P6-16)", () => {
  it("interrupts every worker, withdraws what was queued, and leaves durable statuses", async () => {
    const never = barrier();
    const r = await rig(
      { one: addModule("one", never.opened), two: addModule("two", never.opened) },
      { maxConcurrency: 2 },
    );
    const one = await r.submit("one module");
    const two = await r.submit("two module");
    const three = await r.submit("three module");
    expect(await r.status(three.nodeId)).toBe("queued");

    const withdrawn = await r.engine.close("the session ended");
    const result = await shutdown(r.world.environment, {
      session: r.world.session,
      jobs: r.engine.jobs(),
      reason: "the session ended",
      flushDeadlineMs: 2_000,
    });

    expect(withdrawn).toEqual([three.nodeId]);
    expect([...result.interruptedJobs].sort()).toEqual([one.nodeId, two.nodeId].sort());
    expect(await r.status(one.nodeId)).toBe("interrupted");
    expect(await r.status(two.nodeId)).toBe("interrupted");
    expect(await r.status(three.nodeId)).toBe("cancelled");
    for (const node of [one, two]) {
      const agents = await r.world.stores.agents.listByNode(r.world.scope, node.nodeId);
      expect(agents.map((agent) => agent.status)).toEqual(["interrupted"]);
    }
    expect((await r.world.stores.runs.get(r.world.scope, r.world.scope.runId))?.status).toBe(
      "interrupted",
    );
    await expect(r.submit("four module")).rejects.toThrow(/takes no more work/);
  });
});

// --- P7: strands ---------------------------------------------------------------------------

const strandOf = (id: string, dependsOn: readonly string[] = []): Strand => ({
  id,
  name: `Strand ${id}`,
  // Disjoint by construction: each strand's module is its own.
  scope: { summary: id, includes: ["src/**", "test/**"], excludes: [] },
  acceptance: ["node --test passes"],
  successCriteria: [],
  dependsOn: [...dependsOn],
  prerequisites: [],
});

/** The module a strand adds, named after it: `S-01` writes `src/s01.js`. */
const moduleOf = (strandId: string): string => strandId.replace("-", "").toLowerCase();

/** A job that cannot land: it changes a path outside its scope, which fails it (A-29). */
const outOfScope: Work = async ({ worktree }) => {
  await edit(worktree, "README.md", (text) => `${text}\nnot mine to change\n`);
};

/** Index of the first event of `type` on `nodeId`, which must exist. */
const indexOfEvent = (
  events: readonly { type: string; executionNodeId: string | null }[],
  type: string,
  nodeId: string,
): number => {
  const index = events.findIndex(
    (event) => event.type === type && event.executionNodeId === nodeId,
  );
  expect(index, `${type} on ${nodeId}`).toBeGreaterThanOrEqual(0);
  return index;
};

/** Opens every gate, in an order drawn by the property: a held strand's gate opening early changes nothing. */
const openInOrder = (
  ids: readonly string[],
  order: readonly number[],
  gates: ReadonlyMap<string, { open(): void }>,
): void => {
  const remaining = [...ids];
  for (const pick of order) {
    if (remaining.length === 0) break;
    const [next] = remaining.splice(pick % remaining.length, 1);
    gates.get(next as string)?.open();
  }
  for (const id of remaining) gates.get(id)?.open();
};

/** From the record, never from timing: each strand started after every dependency had landed. */
const expectStartedAfterDependencies = (
  events: readonly { type: string; executionNodeId: string | null }[],
  strands: readonly Strand[],
  nodes: ReadonlyMap<string, ExecutionNodeId>,
): void => {
  for (const strand of strands) {
    const started = indexOfEvent(events, "node.started", nodes.get(strand.id) as string);
    for (const dependency of strand.dependsOn) {
      expect(started).toBeGreaterThan(
        indexOfEvent(events, "node.integrated", nodes.get(dependency) as string),
      );
    }
  }
};

describe("strands are gated and parked (P7, D-P7-04, §4.4)", () => {
  it("holds a strand until what it depends on has succeeded, and runs the rest meanwhile", async () => {
    const first = barrier();
    const r = await rig(
      { s01: addModule("s01", first.opened), s02: addModule("s02"), s03: addModule("s03") },
      { strands: [strandOf("S-01"), strandOf("S-02", ["S-01"]), strandOf("S-03")] },
    );
    const s01 = await r.submit("s01", "S-01");
    const s02 = await r.submit("s02", "S-02");
    const s03 = await r.submit("s03", "S-03");

    // S-03 owes S-01 nothing and lands while S-01 is still working.
    await r.until(s03.nodeId, (status) => status === "integrated");
    expect(await r.status(s02.nodeId)).toBe("queued");
    expect(r.engine.waiting(s02.jobId)).toEqual({ kind: "strands", waitingFor: ["S-01"] });

    first.open();
    await r.until(s02.nodeId, (status) => status === "integrated");

    // From the record, never from timing: S-02 started after S-01 had landed.
    await r.world.outbox.flush();
    const events = await eventsOf(r.world);
    expect(indexOfEvent(events, "node.started", s02.nodeId)).toBeGreaterThan(
      indexOfEvent(events, "node.integrated", s01.nodeId),
    );
  }, 60_000);

  it("parks a failed strand with exactly its cone, names the blocker, and finishes the rest", async () => {
    // S-01 is held until every strand is submitted: otherwise it can fail, and
    // park its cone, before S-04 is delegated, and the engine rightly refuses S-04.
    const all = barrier();
    const r = await rig(
      {
        s01: async (context) => {
          await all.opened;
          await outOfScope(context);
        },
        s02: addModule("s02"),
        s03: addModule("s03"),
        s04: addModule("s04"),
      },
      {
        strands: [
          strandOf("S-01"),
          strandOf("S-02", ["S-01"]),
          strandOf("S-03"),
          strandOf("S-04", ["S-02"]),
        ],
      },
    );
    const s01 = await r.submit("s01", "S-01");
    const s02 = await r.submit("s02", "S-02");
    const s03 = await r.submit("s03", "S-03");
    const s04 = await r.submit("s04", "S-04");
    all.open();

    expect(await r.until(s01.nodeId, settled)).toBe("failed");
    expect(await r.until(s02.nodeId, settled)).toBe("cancelled");
    expect(await r.until(s04.nodeId, settled)).toBe("cancelled");
    expect(await r.until(s03.nodeId, settled)).toBe("integrated");

    const blocked = await r.world.stores.executionNodes.get(r.world.scope, s04.nodeId);
    expect(blocked?.outcomeReason).toBe("blocked by S-01, which did not succeed");

    await r.world.outbox.flush();
    const strandEvents = (await eventsOf(r.world))
      .filter((event) => event.type.startsWith("strand."))
      .map((event) => [event.type, event.payload]);
    expect(strandEvents).toEqual([
      ["strand.parked", { strandId: "S-01", outcome: "failed" }],
      ["strand.blocked", { strandId: "S-02", blockedBy: ["S-01"] }],
      ["strand.blocked", { strandId: "S-04", blockedBy: ["S-01"] }],
    ]);

    // Nothing in the cone can be slipped back in while its blocker stands.
    await expect(r.submit("s02", "S-02")).rejects.toBeInstanceOf(StrandBlockedError);
    expect(await log(r.world)).not.toContain("s02");
  }, 60_000);

  it("refuses a strand the plan does not have, one not at the top, and a second live attempt", async () => {
    const held = barrier();
    const r = await rig({ s01: addModule("s01", held.opened) }, { strands: [strandOf("S-01")] });
    await expect(r.submit("s09", "S-09")).rejects.toBeInstanceOf(StrandDelegationError);
    const s01 = await r.submit("s01", "S-01");
    await expect(r.submit("s01", "S-01")).rejects.toBeInstanceOf(StrandDelegationError);
    held.open();
    await r.until(s01.nodeId, (status) => status === "integrated");
    await expect(r.submit("s01", "S-01")).rejects.toThrow(/already done/);
  }, 60_000);

  it("never starts a strand before its dependencies, over random plans and finishing orders (SC-P7-07)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.array(fc.nat(), { maxLength: 2 }), { minLength: 2, maxLength: 4 }),
        fc.array(fc.nat(), { minLength: 4, maxLength: 4 }),
        async (picks, order) => {
          const ids = picks.map((_, index) => `S-${String(index + 1).padStart(2, "0")}`);
          const strands = picks.map((deps, index) =>
            strandOf(
              ids[index] as string,
              index === 0 ? [] : [...new Set(deps.map((dep) => ids[dep % index] as string))],
            ),
          );
          const gates = new Map(ids.map((id) => [id, barrier()]));
          const r = await rig(
            Object.fromEntries(
              ids.map((id) => [moduleOf(id), addModule(moduleOf(id), gates.get(id)?.opened)]),
            ),
            { strands, maxConcurrency: 4 },
          );
          const nodes = new Map<string, ExecutionNodeId>();
          for (const id of ids) nodes.set(id, (await r.submit(moduleOf(id), id)).nodeId);

          openInOrder(ids, order, gates);
          for (const id of ids) {
            await r.until(nodes.get(id) as ExecutionNodeId, (status) => status === "integrated");
          }

          await r.world.outbox.flush();
          const events = await eventsOf(r.world);
          expectStartedAfterDependencies(events, strands, nodes);
        },
      ),
      { numRuns: 6 },
    );
  }, 240_000);
});

// --- P7: a check that cannot run is deferred (D-P7-10, SC-P7-08a) --------------------------

const HP01 = (status: "pending" | "satisfied"): Prerequisite => ({
  id: "HP-01",
  description: "The deploy credential is in place.",
  remediation: "Ask the owner.",
  verifyCommand: "true",
  status,
  ...(status === "satisfied"
    ? { lastCheck: { exitCode: 0, checkedAt: "2026-09-21T00:00:00.000Z" } }
    : {}),
});

/** `gate` needs HP-01, and fails once it can run if a module named `bad` is present. */
const GATED: Partial<ProgramContract> = {
  verification: [
    { id: "test", command: "node --test" },
    {
      id: "gate",
      command: `node -e "process.exit(require('fs').existsSync('src/bad.js') ? 1 : 0)"`,
      requires: ["HP-01"],
    },
  ],
  prerequisites: [HP01("pending")],
};

const headOf = (world: World): Promise<string> => revParse(world.git, world.repo, PROGRAM_BRANCH);

describe("a hurdle nobody planned (D-P7-10): exit 75 and a NIGHTSHIFT_DEFER line", () => {
  const declaring = (script: string): Partial<ProgramContract> => ({
    verification: [
      { id: "test", command: "node --test" },
      { id: "deploy", command: `node -e "${script}"` },
    ],
  });
  const withBook = (program: Partial<ProgramContract>) =>
    rig({ one: addModule("one") }, { program, maxConcurrency: 1, prerequisites: () => [] });

  it("defers the step and records the prerequisite it declared", async () => {
    discoveredHurdles = [];
    const r = await withBook(
      declaring(
        "console.log('NIGHTSHIFT_DEFER HP-03 The deploy key is missing');console.log('NIGHTSHIFT_REMEDIATION run aws sso login');process.exit(75)",
      ),
    );
    const one = await r.submit("one");
    expect(await r.until(one.nodeId, (status) => status === "deferred")).toBe("deferred");
    expect(discoveredHurdles).toEqual([
      expect.objectContaining({
        id: "HP-03",
        description: "The deploy key is missing",
        remediation: "run aws sso login",
      }),
    ]);
    const [verification] = await r.world.stores.verifications.listByNode(r.world.scope, one.nodeId);
    expect(verification?.commands.at(-1)?.deferred).toEqual({ prerequisiteId: "HP-03" });
    // The node is `deferred` a moment before the merge queue moves the ref.
    await vi.waitFor(
      async () =>
        expect(await provisionalHead(r.world.git, r.world.repo, r.world.scope.runId)).toBeDefined(),
      { timeout: 10_000 },
    );
  }, 60_000);

  it("fails a step that exits 75 without the line, or prints the line without exiting 75", async () => {
    for (const script of [
      "process.exit(75)",
      "console.log('NIGHTSHIFT_DEFER HP-03 missing');process.exit(1)",
    ]) {
      discoveredHurdles = [];
      const r = await withBook(declaring(script));
      const one = await r.submit("one");
      expect(await r.until(one.nodeId, settled), script).toBe("verification_failed");
      expect(discoveredHurdles).toEqual([]);
    }
  }, 60_000);
});

describe("a check that cannot run is deferred (P7, D-P7-10, SC-P7-08a)", () => {
  const deferredRig = async (work: Readonly<Record<string, Work>>) => {
    let met = false;
    const r = await rig(work, {
      program: GATED,
      maxConcurrency: 1,
      prerequisites: () => [HP01(met ? "satisfied" : "pending")],
    });
    return { r, meet: () => (met = true) };
  };

  it("defers the step, runs the rest, lands on the provisional line and not the program branch", async () => {
    const { r } = await deferredRig({ one: addModule("one"), two: addModule("two") });
    const before = await headOf(r.world);

    const one = await r.submit("one");
    expect(await r.until(one.nodeId, (status) => status === "deferred")).toBe("deferred");
    const first = await r.world.stores.executionNodes.get(r.world.scope, one.nodeId);
    // A deferral is not an outcome, so the node carries no reason: why it waits
    // is in the Verification below and on the `node.deferred` event.
    expect(first?.outcomeReason).toBeUndefined();

    // The step that could run did, and passed; the one that could not has no exit code.
    const [verification] = await r.world.stores.verifications.listByNode(r.world.scope, one.nodeId);
    expect(verification?.outcome).toBe("deferred");
    expect(verification?.commands.map((c) => [c.stepId, c.exitCode, c.deferred])).toEqual([
      ["test", 0, undefined],
      ["gate", undefined, { prerequisiteId: "HP-01" }],
    ]);

    // The program branch has none of it; the provisional line has the commit.
    expect(await headOf(r.world)).toBe(before);
    expect(await provisionalHead(r.world.git, r.world.repo, r.world.scope.runId)).toBe(
      first?.commitSha,
    );

    // Later work is cut from the provisional head, and lands on it in turn.
    const two = await r.submit("two");
    await r.until(two.nodeId, (status) => status === "deferred");
    const second = await r.world.stores.executionNodes.get(r.world.scope, two.nodeId);
    const parent = await git(r.world.git, ["rev-parse", `${second?.commitSha}^`], {
      cwd: r.world.repo,
    });
    expect(parent.trim()).toBe(first?.commitSha);
    expect(await headOf(r.world)).toBe(before);

    await r.world.outbox.flush();
    const deferrals = (await eventsOf(r.world)).filter((event) => event.type === "node.deferred");
    expect(deferrals.map((event) => event.executionNodeId)).toEqual([one.nodeId, two.nodeId]);
    expect(deferrals[0]?.payload).toMatchObject({
      waitingOn: ["HP-01"],
      provisionalRef: `refs/nightshift/provisional/${r.world.scope.runId}`,
    });
  }, 60_000);

  it("never defers a step that ran and failed", async () => {
    const { r } = await deferredRig({
      broken: async ({ worktree }) => {
        await edit(
          worktree,
          "test/broken.test.js",
          () =>
            `import { test } from "node:test";\nimport assert from "node:assert/strict";\ntest("no", () => assert.equal(1, 2));\n`,
        );
      },
    });
    const broken = await r.submit("broken");
    expect(await r.until(broken.nodeId, settled)).toBe("verification_failed");
    expect(await provisionalHead(r.world.git, r.world.repo, r.world.scope.runId)).toBeUndefined();
  }, 60_000);

  it("resume runs the deferred checks in order and lands the very commits that were deferred", async () => {
    const { r, meet } = await deferredRig({ one: addModule("one"), two: addModule("two") });
    const one = await r.submit("one");
    await r.until(one.nodeId, (status) => status === "deferred");
    const two = await r.submit("two");
    await r.until(two.nodeId, (status) => status === "deferred");
    const deferredCommit = (await r.world.stores.executionNodes.get(r.world.scope, two.nodeId))
      ?.commitSha;

    meet();
    const result = await resumeDeferred(r.world.environment, r.world.session);
    expect(result, JSON.stringify(result)).toEqual({
      landed: [one.nodeId, two.nodeId],
      discarded: [],
    });
    expect(await r.status(one.nodeId)).toBe("integrated");
    expect(await r.status(two.nodeId)).toBe("integrated");
    // A verified commit is never moved: what landed is what was deferred.
    expect(await headOf(r.world)).toBe(deferredCommit);
    expect(await provisionalHead(r.world.git, r.world.repo, r.world.scope.runId)).toBeUndefined();

    // Each reached `verified` through a passed Verification in which every step ran (A-05).
    const evidence = (await r.world.stores.verifications.listByNode(r.world.scope, two.nodeId)).at(
      -1,
    );
    expect(evidence?.outcome).toBe("passed");
    expect(evidence?.commands.map((c) => c.exitCode)).toEqual([0, 0]);
  }, 60_000);

  it("resume stops at a deferred check that fails, and discards what was built on it", async () => {
    const { r, meet } = await deferredRig({
      good: addModule("good"),
      bad: addModule("bad"),
      later: addModule("later"),
    });
    const before = await headOf(r.world);
    const good = await r.submit("good");
    await r.until(good.nodeId, (status) => status === "deferred");
    const bad = await r.submit("bad");
    await r.until(bad.nodeId, (status) => status === "deferred");
    const later = await r.submit("later");
    await r.until(later.nodeId, (status) => status === "deferred");

    meet();
    const result = await resumeDeferred(r.world.environment, r.world.session);
    expect(result.landed).toEqual([good.nodeId]);
    expect(result.stoppedAt).toEqual({
      nodeId: bad.nodeId,
      kind: "failed",
      reason: "verification failed: gate exited 1",
    });
    expect(result.discarded).toEqual([later.nodeId]);

    // What passed is on the branch; the failure is a failure; what stood on it is gone, and says why.
    expect(await r.status(good.nodeId)).toBe("integrated");
    expect(await r.status(bad.nodeId)).toBe("verification_failed");
    const dropped = await r.world.stores.executionNodes.get(r.world.scope, later.nodeId);
    expect(dropped?.status).toBe("cancelled");
    expect(dropped?.outcomeReason).toContain(`discarded: built on ${bad.nodeId}`);
    expect(await headOf(r.world)).not.toBe(before);
    expect(await log(r.world)).not.toContain("bad");
    expect(await provisionalHead(r.world.git, r.world.repo, r.world.scope.runId)).toBeUndefined();
  }, 60_000);

  it("touches nothing when the checkout cannot be landed on, and ignores Nightshift's own report", async () => {
    const { r, meet } = await deferredRig({ one: addModule("one"), two: addModule("two") });
    const one = await r.submit("one");
    await r.until(one.nodeId, (status) => status === "deferred");
    const two = await r.submit("two");
    await r.until(two.nodeId, (status) => status === "deferred");
    meet();

    // Somebody's work in progress: a refusal, and no verdict on anybody's work.
    await writeFile(join(r.world.repo, "scratch.txt"), "mine", "utf8");
    const blocked = await resumeDeferred(r.world.environment, r.world.session);
    expect(blocked.blocked).toContain("program_checkout_dirty");
    expect(blocked).toMatchObject({ landed: [], discarded: [] });
    expect(await r.status(one.nodeId)).toBe("deferred");
    expect(await r.status(two.nodeId)).toBe("deferred");
    expect(await provisionalHead(r.world.git, r.world.repo, r.world.scope.runId)).toBeDefined();

    // The report `nightshift run` leaves behind is not dirt, or no run could ever be resumed.
    await rm(join(r.world.repo, "scratch.txt"));
    await mkdir(join(r.world.repo, "docs", "programs", "p1"), { recursive: true });
    await writeFile(
      join(r.world.repo, "docs", "programs", "p1", "report.md"),
      "# Report\n",
      "utf8",
    );
    const landed = await resumeDeferred(r.world.environment, r.world.session);
    expect(landed).toEqual({ landed: [one.nodeId, two.nodeId], discarded: [] });
  }, 60_000);
});
