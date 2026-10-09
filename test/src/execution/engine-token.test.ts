/**
 * A worker launched by a machine's engine, under the engine's own token (P10,
 * D-P10-20, D-P10-29).
 *
 * Every other execution suite drives the engine with the operator's session,
 * which may do anything in its org. A machine's engine holds a token its table
 * narrows, so an operation a launch needs and the table forbids passed every
 * suite and failed on the first remote run that started a worker (keki,
 * 2026-10-08: "an execution token may not run.list", from the program's
 * rulings read across its runs). This suite launches, verifies and integrates
 * a job through the real handler with that token, beside an earlier run of the
 * same program, so the next such gap fails here.
 */
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { JobContract, RouteChoice } from "@nightshift/contracts";
import { JobContractSchema } from "@nightshift/contracts";
import { nowIso } from "@nightshift/core";
import {
  completeJob,
  createEngine,
  createEventOutbox,
  createMergeQueue,
  jobBranch,
  runJob,
  type StartedJob,
  tryGit,
} from "@nightshift/execution";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeHarness } from "./fake-harness.js";
import { cleanupWorlds, createWorld, type World } from "./world.js";

afterEach(cleanupWorlds);

const ROUTE: RouteChoice = {
  target: { harness: "fake", provider: "anthropic", model: "claude-sonnet-5" },
  eligibleOptions: [
    {
      target: { harness: "fake", provider: "anthropic", model: "claude-sonnet-5" },
      eligible: true,
    },
  ],
  ruleId: "p3-fixed",
  wasOverride: false,
};

const jobFor = (world: World): JobContract =>
  JobContractSchema.parse({
    schemaVersion: 1,
    ...world.scope,
    jobContractId: world.ids.next("job"),
    objective: "Add a median helper to src/math.js and a test for it.",
    scope: { includes: ["src/**", "test/**"] },
    acceptance: ["median([1,2,3]) is 2", "node --test passes"],
    dependencies: [],
    risk: "low",
    ambiguity: "low",
    createdAt: nowIso(world.environment.clock),
  });

const delegate = (world: World, job: JobContract): Promise<StartedJob> =>
  runJob(world.environment, {
    session: world.session,
    job,
    scope: world.session.program.scope,
    depth: 1,
    parentNodeId: world.session.rootNodeId,
    route: ROUTE,
    mcp: () => ({ name: "nightshift", command: process.execPath, args: ["--version"], env: {} }),
  });

describe("a worker launched under the engine's token (D-P10-20, D-P10-29)", () => {
  it("starts, verifies and integrates, reading the program's earlier runs on the way", async () => {
    const world: World = await createWorld({
      engine: true,
      harness: createFakeHarness({
        script: async ({ worktree, identity }) => {
          const math = await readFile(join(worktree, "src", "math.js"), "utf8");
          await writeFile(
            join(worktree, "src", "math.js"),
            `${math}export const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];\n`,
            "utf8",
          );
          // The worker's own side is not under test here; it reports as the
          // lifecycle suite's does. What is under test is everything the engine
          // does around it, under the engine's token.
          const worker = {
            stores: world.stores,
            clock: world.environment.clock,
            git: world.git,
            outbox: createEventOutbox({
              events: world.stores.events,
              scope: identity.scope,
              clock: world.environment.clock,
              ids: world.ids,
              writerId: identity.agentId,
              initialDelayMs: 1,
            }),
          };
          const result = await completeJob(worker, identity, "Added a median helper.");
          expect(result.kind).toBe("implemented");
          await worker.outbox.flush();
          return { kind: "completed" };
        },
        transcript: '{"type":"system"}\n{"type":"result"}\n',
      }),
    });

    const started = await delegate(world, jobFor(world));
    await started.completion;
    await world.outbox.flush();

    const node = await world.environment.stores.executionNodes.get(world.scope, started.nodeId);
    expect(node?.status, node?.outcomeReason).toBe("integrated");
  });

  it("reads every run of its program, and writes nothing outside its own run", async () => {
    const world = await createWorld({
      engine: true,
      harness: createFakeHarness({ script: async () => ({ kind: "completed" }) }),
    });
    const { stores } = world.environment;
    const runs = await stores.runs.listByProgram({
      projectId: world.scope.projectId,
      programId: world.scope.programId,
    });
    const earlier = runs.items.find((run) => run.runId !== world.scope.runId);
    expect(earlier, "the world records an earlier run of the program").toBeDefined();
    const earlierScope = { ...world.scope, runId: earlier?.runId ?? world.scope.runId };
    expect((await stores.decisions.listByRun(earlierScope)).items).toEqual([]);
    await expect(
      stores.runs.put({ ...(earlier as NonNullable<typeof earlier>), status: "cancelled" }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("retries a job whose first launch failed before the worker started (keki, 2026-10-08)", async () => {
    let starts = 0;
    const world: World = await createWorld({
      engine: true,
      harness: createFakeHarness({
        onStart: () => {
          starts += 1;
          if (starts === 1) throw new Error("the harness could not start the worker");
        },
        script: async ({ identity }) => {
          const worker = {
            stores: world.stores,
            clock: world.environment.clock,
            git: world.git,
            outbox: createEventOutbox({
              events: world.stores.events,
              scope: identity.scope,
              clock: world.environment.clock,
              ids: world.ids,
              writerId: identity.agentId,
              initialDelayMs: 1,
            }),
          };
          await completeJob(worker, identity, "Nothing to change.");
          await worker.outbox.flush();
          return { kind: "completed" };
        },
      }),
    });
    const reclaimed: string[] = [];
    const environment = {
      ...world.environment,
      // As a machine supplies it: the engine takes a granted worktree back first.
      reclaim: async (path: string) => {
        reclaimed.push(path);
      },
    };
    const engine = createEngine({
      environment,
      session: world.session,
      mcp: () => ({ name: "nightshift", command: process.execPath, args: ["--version"], env: {} }),
      mergeQueue: createMergeQueue(environment),
    });
    const job = jobFor(world);
    const { nodeId } = await engine.submit({
      job,
      scope: world.session.program.scope,
      depth: 1,
      parentNodeId: world.session.rootNodeId,
      route: ROUTE,
    });
    const statusOf = async () =>
      (await world.environment.stores.executionNodes.get(world.scope, nodeId))?.status;
    for (let i = 0; i < 200 && (await statusOf()) !== "failed"; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(await statusOf()).toBe("failed");
    // The failed launch took its worktree back and removed it and its branch.
    const worktree = world.environment.paths.worktree(world.scope.runId, nodeId);
    expect(reclaimed).toContain(worktree);
    expect(existsSync(worktree)).toBe(false);
    expect(
      (
        await tryGit(world.git, ["branch", "--list", jobBranch(world.scope.runId, nodeId)], {
          cwd: world.repo,
        })
      ).stdout.trim(),
    ).toBe("");

    expect(await engine.retry(job.jobContractId)).toBe(true);
    let status = await statusOf();
    for (let i = 0; i < 400 && status !== "integrated" && status !== "failed"; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      status = await statusOf();
    }
    const node = await world.environment.stores.executionNodes.get(world.scope, nodeId);
    expect(node?.status, node?.outcomeReason).not.toBe("failed");
    await engine.close("the test is over");
  });
});
