/**
 * A strand built as P18 builds it (D-P18-01 … D-P18-05), through the real
 * engine, runner, merge queue, verification and git, with a fake harness.
 *
 * The strand's orchestrator is scripted to write exactly the records its tools
 * write — its job plan as a decision, each job as a Job Contract and a
 * `validated` node, its own node `implemented` at its branch's head — so what
 * is under test is the engine's side of each: the plan reviewed before
 * anything is built, a dependent job held until its dependency has merged, the
 * jobs merged onto the strand's branch with no verification of their own, the
 * strand landing once, and a red landing handed back to the same session.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type ExecutionNode,
  type ExecutionNodeId,
  type JobContract,
  type JobContractId,
  JobContractSchema,
  type RouteChoice,
} from "@nightshift/contracts";
import { isSettled, markImplemented, nowIso } from "@nightshift/core";
import {
  completeJob,
  createEngine,
  createEventOutbox,
  git,
  planStateOf,
  recordWorkerDecision,
  STRAND_PLAN_CONTEXT,
} from "@nightshift/execution";
import type { AgentTask, HarnessStartInput } from "@nightshift/harness";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeHarness, type ScriptContext } from "./fake-harness.js";
import { cleanupWorlds, createWorld, eventsOf, type World } from "./world.js";

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

const mcp = () => ({ name: "nightshift", command: process.execPath, args: ["--version"], env: {} });

const until = async <T>(what: string, read: () => Promise<T | undefined>): Promise<T> => {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const found = await read();
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error(`${what} did not happen`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

/** A test the program's `node --test` gate runs, red until J3 fixes it. */
const RED_TEST = [
  'import { test } from "node:test";',
  'import assert from "node:assert/strict";',
  'test("j2 left this wrong", () => { assert.equal(1, 2); });',
  "",
].join("\n");

describe("a strand built as P18 builds it", () => {
  it("reviews its plan, holds a dependent job, merges its jobs, and lands once after its own session fixes a red landing", async () => {
    let world: World | undefined;
    const starts: HarnessStartInput[] = [];
    const delegated = new Map<string, JobContractId>();

    const outboxFor = (context: ScriptContext) =>
      createEventOutbox({
        events: (world as World).stores.events,
        scope: context.identity.scope,
        clock: (world as World).environment.clock,
        ids: (world as World).ids,
        writerId: context.identity.agentId,
        initialDelayMs: 1,
      });

    /** `delegate`, as the strand orchestrator's tool writes it. */
    const delegate = async (
      context: ScriptContext,
      name: string,
      objective: string,
      dependsOn: readonly string[] = [],
    ): Promise<void> => {
      const w = world as World;
      const at = nowIso(w.environment.clock);
      const job: JobContract = JobContractSchema.parse({
        schemaVersion: 1,
        ...w.scope,
        jobContractId: w.ids.next("job"),
        objective,
        acceptance: ["node --test passes"],
        dependencies: dependsOn.map((dependency) => delegated.get(dependency)),
        risk: "low",
        ambiguity: "low",
        createdAt: at,
      });
      await w.stores.jobContracts.put(job);
      const node: ExecutionNode = {
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
      };
      await w.stores.executionNodes.put(node);
      delegated.set(name, job.jobContractId);
    };

    const statusOf = async (name: string): Promise<string | undefined> => {
      const w = world as World;
      const nodes = (await w.stores.executionNodes.listByRun(w.scope)).items;
      return nodes.find((node) => node.jobContractId === delegated.get(name))?.status;
    };

    /** `subprogram.complete`: its node implemented at its branch's head. */
    const complete = async (context: ScriptContext): Promise<void> => {
      const w = world as World;
      const head = (await git(w.git, ["rev-parse", "HEAD"], { cwd: context.worktree })).trim();
      const node = await w.stores.executionNodes.get(w.scope, context.identity.executionNodeId);
      await w.stores.executionNodes.put(
        markImplemented(node as ExecutionNode, head as never, nowIso(w.environment.clock)),
      );
    };

    const orchestrate = async (context: ScriptContext) => {
      const w = world as World;
      const task = context.input.task as AgentTask | undefined;
      if (task?.kind === "strand_fix") {
        // The same session, told exactly what failed (D-P18-05).
        await delegate(context, "J3", "[fix] Remove j2's wrong test.");
        await until("J3 to merge", async () =>
          (await statusOf("J3")) === "merged" ? true : undefined,
        );
        await complete(context);
        return { kind: "completed" as const, sessionId: "strand-session" };
      }
      // The plan, as strand.plan records it, and its review waited for (D-P18-01).
      const outbox = outboxFor(context);
      await recordWorkerDecision(
        { stores: w.stores, clock: w.environment.clock, git: w.git, outbox },
        context.identity,
        w.ids,
        {
          context: `${STRAND_PLAN_CONTEXT} round 1 — 2 jobs, 1 starting at once`,
          alternatives: [{ summary: "the plan as authored" }],
          choice: "J1: the a module\nJ2: the b module, on J1",
          rationale: "J2 needs J1's module.",
          reversibility: "reversible",
        },
      );
      await outbox.flush();
      await until("the plan's review", async () => {
        const state = await planStateOf(w.environment, w.scope, context.identity.executionNodeId);
        return state.reviews.length > 0 ? true : undefined;
      });
      await delegate(context, "J1", "[a] Add the a module.");
      await delegate(context, "J2", "[b] Add the b module, which needs a.", ["J1"]);
      await until("both jobs to merge", async () =>
        (await statusOf("J1")) === "merged" && (await statusOf("J2")) === "merged"
          ? true
          : undefined,
      );
      await complete(context);
      return { kind: "completed" as const, sessionId: "strand-session" };
    };

    const work = async (context: ScriptContext) => {
      const objective = context.input.job.objective;
      const file = (name: string, text: string) => writeFile(join(context.worktree, name), text);
      if (objective.startsWith("[a]")) await file("src/a.js", "export const a = 1;\n");
      if (objective.startsWith("[b]")) {
        await file("src/b.js", 'import { a } from "./a.js";\nexport const b = a + 1;\n');
        await file("test/b.test.js", RED_TEST);
      }
      if (objective.startsWith("[fix]")) {
        await git((world as World).git, ["rm", "-q", "test/b.test.js"], { cwd: context.worktree });
      }
      const outbox = outboxFor(context);
      await completeJob(
        {
          stores: (world as World).stores,
          clock: (world as World).environment.clock,
          git: (world as World).git,
          outbox,
        },
        context.identity,
        objective,
      );
      await outbox.flush();
      return { kind: "completed" as const };
    };

    world = await createWorld({
      // A strand delegates its jobs one level below itself.
      program: { delegationLimits: { maxDepth: 2, maxConcurrency: 2 } },
      harness: createFakeHarness({
        script: (context) => {
          starts.push(context.input);
          return context.input.node.kind === "sub-program" ? orchestrate(context) : work(context);
        },
      }),
    });
    const w = world;
    const engine = createEngine({
      environment: w.environment,
      session: w.session,
      mcp,
      route: () => ROUTE,
      discoveryIntervalMs: 50,
    });
    const strandJob = JobContractSchema.parse({
      schemaVersion: 1,
      ...w.scope,
      jobContractId: w.ids.next("job"),
      objective: "The a and b modules.",
      acceptance: ["node --test passes"],
      dependencies: [],
      risk: "low",
      ambiguity: "low",
      kind: "orchestrate",
      createdAt: nowIso(w.environment.clock),
    });
    const strand = await engine.submit({
      job: strandJob,
      depth: 1,
      parentNodeId: w.session.rootNodeId,
      route: ROUTE,
      kind: "sub-program",
    });

    const final = await until("the strand to settle", async () => {
      const node = await w.stores.executionNodes.get(w.scope, strand.nodeId as ExecutionNodeId);
      return node !== undefined &&
        isSettled(node.status) &&
        node.status !== "verification_failed" &&
        engine.idle()
        ? node
        : undefined;
    });

    // It landed once its own session fixed it.
    expect(final.status).toBe("integrated");
    const events = await eventsOf(w);

    // D-P18-01: reviewed (here by nobody, so recorded as such) before anything was built.
    const state = await planStateOf(w.environment, w.scope, strand.nodeId as ExecutionNodeId);
    expect(state.plans).toHaveLength(1);
    expect(state.reviews).toHaveLength(1);

    // D-P18-02: J2 started only once J1 had merged.
    const nodes = (await w.stores.executionNodes.listByRun(w.scope)).items;
    const nodeOf = (name: string) =>
      nodes.find((node) => node.jobContractId === delegated.get(name));
    const startedAt = (name: string) =>
      events.findIndex(
        (event) =>
          event.type === "node.started" && event.executionNodeId === nodeOf(name)?.executionNodeId,
      );
    const mergedAt = (name: string) =>
      events.findIndex(
        (event) =>
          event.type === "node.merged" && event.executionNodeId === nodeOf(name)?.executionNodeId,
      );
    expect(mergedAt("J1")).toBeGreaterThan(-1);
    expect(startedAt("J2")).toBeGreaterThan(mergedAt("J1"));

    // D-P18-03: each job merged, and verified nothing of its own.
    for (const name of ["J1", "J2", "J3"]) {
      const node = nodeOf(name) as ExecutionNode;
      expect(node.status, name).toBe("merged");
      expect(await w.stores.verifications.listByNode(w.scope, node.executionNodeId), name).toEqual(
        [],
      );
    }

    // D-P18-04, D-P18-05: the strand's first landing was red; the same session
    // was resumed with the failing gate, and its second landing passed.
    const landings = await w.stores.verifications.listByNode(
      w.scope,
      strand.nodeId as ExecutionNodeId,
    );
    expect(landings.map((verification) => verification.outcome)).toEqual(["failed", "passed"]);
    const orchestrations = starts.filter((input) => input.node.kind === "sub-program");
    expect(orchestrations).toHaveLength(2);
    expect(orchestrations[1]?.resume).toEqual({ sessionId: "strand-session" });
    const fix = orchestrations[1]?.task;
    expect(fix?.kind).toBe("strand_fix");
    if (fix?.kind === "strand_fix") {
      expect(fix.failedChecks.map((check) => check.stepId)).toContain("test");
      expect(fix.failedChecks[0]?.output).toContain("j2 left this wrong");
    }

    // The program branch has the strand's work, and not the test J3 removed.
    const files = await git(
      w.git,
      ["ls-tree", "-r", "--name-only", w.session.program.repository.programBranch],
      {
        cwd: w.session.repoPath,
      },
    );
    expect(files).toContain("src/a.js");
    expect(files).toContain("src/b.js");
    expect(files).not.toContain("test/b.test.js");
    await engine.close("the test is done");
  }, 120_000);
});
