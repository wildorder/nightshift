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
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type ExecutionNodeId,
  type JobContract,
  JobContractSchema,
  type RouteChoice,
} from "@nightshift/contracts";
import { isSettled, nowIso } from "@nightshift/core";
import {
  completeJob,
  createEngine,
  createEventOutbox,
  createMergeQueue,
  type Engine,
  git,
  type MergeQueue,
  revParse,
  shutdown,
  startJob,
} from "@nightshift/execution";
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
  ): Promise<{ jobId: JobContract["jobContractId"]; nodeId: ExecutionNodeId }>;
  status(nodeId: ExecutionNodeId): Promise<string>;
  until(nodeId: ExecutionNodeId, predicate: (status: string) => boolean): Promise<string>;
}

const rig = async (
  work: Readonly<Record<string, Work>>,
  options: { maxConcurrency?: number; gated?: boolean } = {},
): Promise<Rig> => {
  let world: World | undefined;
  const made = await createWorld({
    harness: harnessFor(() => world as World, work),
    program: { delegationLimits: { maxDepth: 2, maxConcurrency: options.maxConcurrency ?? 3 } },
  });
  world = made;

  const real = createMergeQueue(made.environment);
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
  const engine = createEngine({
    environment: made.environment,
    session: made.session,
    mcp,
    mergeQueue: queue,
  });

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
    submit: async (objective) => {
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
