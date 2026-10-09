/**
 * Work that ends without being handed in.
 *
 * Every agent runs headless: its process exits when its turn ends, and nothing
 * wakes it. A worker that ends its turn to wait for a background command has
 * not reported, and must not simply be failed (its session is resumed with a
 * reminder); and when an attempt does end unreported, what it wrote is carried
 * into the retry rather than thrown away with its worktree.
 */
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type ExecutionNodeId, JobContractSchema, type RouteChoice } from "@nightshift/contracts";
import { isSettled, nowIso } from "@nightshift/core";
import {
  completeJob,
  createEngine,
  createEventOutbox,
  git,
  MAX_UNREPORTED_RESUMES,
  nodeGitRunner,
  revParse,
  unfinishedRef,
} from "@nightshift/execution";
import type { HarnessStartInput } from "@nightshift/harness";
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

const finish = async (world: World, context: ScriptContext, summary: string): Promise<void> => {
  const outbox = createEventOutbox({
    events: world.stores.events,
    scope: context.identity.scope,
    clock: world.environment.clock,
    ids: world.ids,
    writerId: context.identity.agentId,
    initialDelayMs: 1,
  });
  await completeJob(
    { stores: world.stores, clock: world.environment.clock, git: world.git, outbox },
    context.identity,
    summary,
  );
  await outbox.flush();
};

const rig = async (script: (world: World, context: ScriptContext) => ReturnType<ScriptOf>) => {
  let world: World | undefined;
  const starts: HarnessStartInput[] = [];
  const made = await createWorld({
    harness: createFakeHarness({
      script: (context) => {
        starts.push(context.input);
        return script(world as World, context);
      },
    }),
  });
  world = made;
  const engine = createEngine({ environment: made.environment, session: made.session, mcp });
  const job = JobContractSchema.parse({
    schemaVersion: 1,
    ...made.scope,
    jobContractId: made.ids.next("job"),
    objective: "median helper",
    acceptance: ["node --test passes"],
    dependencies: [],
    risk: "low",
    ambiguity: "low",
    createdAt: nowIso(made.environment.clock),
  });
  const submitted = await engine.submit({
    job,
    depth: 1,
    parentNodeId: made.session.rootNodeId,
    route: ROUTE,
  });
  const settled = async (): Promise<string> => {
    const deadline = Date.now() + 60_000;
    for (;;) {
      const status =
        (await made.stores.executionNodes.get(made.scope, submitted.nodeId))?.status ?? "missing";
      if (isSettled(status as never) && engine.idle()) return status;
      if (Date.now() > deadline) throw new Error(`still ${status}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  return {
    world: made,
    engine,
    starts,
    jobId: job.jobContractId,
    nodeId: submitted.nodeId as ExecutionNodeId,
    settled,
  };
};
type ScriptOf = Parameters<typeof createFakeHarness>[0]["script"];

/** The program head's own change to the line the dead attempt also changed. */
const MOVED = "export const sum = (xs) => xs.reduce((a, b) => a + b, 0); // moved head\n";

const MEDIAN = "export const median = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1];\n";

describe("a session that ends its turn without reporting", () => {
  it("is resumed with a reminder, in the worktree it left, and its work lands", async () => {
    const r = await rig(async (world, context) => {
      if (context.input.resume === undefined) {
        // Half the job, then the turn ends to "wait for" a background command.
        await writeFile(join(context.worktree, "src", "median.js"), MEDIAN, "utf8");
        return { kind: "completed", sessionId: "session-1" };
      }
      // Resumed: the half-done work is still there, and it finishes.
      expect(existsSync(join(context.worktree, "src", "median.js"))).toBe(true);
      await finish(world, context, "median: done");
      return { kind: "completed", sessionId: "session-1" };
    });
    expect(await r.settled()).toBe("integrated");

    expect(r.starts).toHaveLength(2);
    expect(r.starts[1]?.resume).toEqual({ sessionId: "session-1" });
    expect(r.starts[1]?.task).toEqual({
      kind: "continue",
      reminder: 1,
      of: MAX_UNREPORTED_RESUMES,
    });
    // One attempt, one agent: a reminder is not a retry.
    expect(r.starts[1]?.agent.agentId).toBe(r.starts[0]?.agent.agentId);
    const routes = await r.world.stores.routingDecisions.listByNode(r.world.scope, r.nodeId);
    expect(routes).toHaveLength(1);
    const progress = (await eventsOf(r.world)).filter((event) => event.type === "node.progress");
    expect(progress.map((event) => String(event.payload.message))).toContain(
      `ended its turn without reporting; resumed with a reminder (1 of ${MAX_UNREPORTED_RESUMES})`,
    );
    await r.engine.close("test over");
  });

  it("is failed as unreported once the reminders run out", async () => {
    const r = await rig(async () => ({ kind: "completed", sessionId: "session-1" }));
    expect(await r.settled()).toBe("failed");
    expect(r.starts).toHaveLength(1 + MAX_UNREPORTED_RESUMES);
    const node = await r.world.stores.executionNodes.get(r.world.scope, r.nodeId);
    expect(node?.outcomeReason).toBe("the worker exited 0 without reporting completion");
    await r.engine.close("test over");
  });

  it("is not resumed when the harness kept no session", async () => {
    const r = await rig(async () => ({ kind: "completed" }));
    expect(await r.settled()).toBe("failed");
    expect(r.starts).toHaveLength(1);
    await r.engine.close("test over");
  });
});

describe("a retry of an attempt that never handed its work in", () => {
  it("starts from that attempt's unfinished work, and keeps it on a ref", async () => {
    const r = await rig(async (world, context) => {
      const path = join(context.worktree, "src", "median.js");
      if (context.input.carriedOver === undefined) {
        await writeFile(path, MEDIAN, "utf8");
        return { kind: "failed", exitCode: 1 }; // Died mid-job.
      }
      // The retry finds the dead attempt's file in place, and finishes.
      expect(await readFile(path, "utf8")).toBe(MEDIAN);
      await finish(world, context, "median: done");
      return { kind: "completed" };
    });
    expect(await r.settled()).toBe("failed");
    expect(await r.engine.retry(r.jobId)).toBe(true);
    expect(await r.settled()).toBe("integrated");

    const carried = r.starts[1]?.carriedOver;
    expect(carried).toMatchObject({
      fromAttempt: 1,
      ref: unfinishedRef(r.nodeId, 1),
      paths: ["src/median.js"],
      applied: true,
      conflicts: [],
    });
    expect(await readFile(carried?.patchPath ?? "", "utf8")).toContain("export const median");
    expect(await revParse(nodeGitRunner, r.world.repo, unfinishedRef(r.nodeId, 1))).toMatch(
      /^[0-9a-f]{40}$/,
    );
    await r.engine.close("test over");
  });

  it("leaves the patch and names the conflicts when the program head has moved under it", async () => {
    const r = await rig(async (world, context) => {
      const math = join(context.worktree, "src", "math.js");
      if (context.input.carriedOver === undefined) {
        await writeFile(
          math,
          "export const sum = (xs) => xs.reduce((t, x) => t + x, 0); // attempt one\n",
          "utf8",
        );
        return { kind: "failed", exitCode: 1 };
      }
      // Not applied: the worktree is the moved head, untouched.
      expect(await readFile(math, "utf8")).toBe(MOVED);
      await writeFile(join(context.worktree, "src", "median.js"), MEDIAN, "utf8");
      await finish(world, context, "median: done");
      return { kind: "completed" };
    });
    expect(await r.settled()).toBe("failed");
    // Somebody else's work lands on the same lines meanwhile.
    await writeFile(join(r.world.repo, "src", "math.js"), MOVED, "utf8");
    await git(nodeGitRunner, ["commit", "-am", "moved"], { cwd: r.world.repo });

    expect(await r.engine.retry(r.jobId)).toBe(true);
    expect(await r.settled()).toBe("integrated");
    const carried = r.starts[1]?.carriedOver;
    expect(carried).toMatchObject({ applied: false, conflicts: ["src/math.js"] });
    expect(await readFile(carried?.patchPath ?? "", "utf8")).toContain("attempt one");
    await r.engine.close("test over");
  });

  it("starts clean when the last attempt handed its work in", async () => {
    let attempt = 0;
    const r = await rig(async (world, context) => {
      attempt += 1;
      if (attempt === 1) {
        // Handed in, and fails its checks.
        await writeFile(
          join(context.worktree, "test", "broken.test.js"),
          'import { test } from "node:test";\nimport assert from "node:assert/strict";\ntest("no", () => assert.equal(1, 2));\n',
          "utf8",
        );
        await finish(world, context, "broken: done");
        return { kind: "completed" };
      }
      expect(existsSync(join(context.worktree, "test", "broken.test.js"))).toBe(false);
      await writeFile(join(context.worktree, "src", "median.js"), MEDIAN, "utf8");
      await finish(world, context, "median: done");
      return { kind: "completed" };
    });
    expect(await r.settled()).toBe("verification_failed");
    expect(await r.engine.retry(r.jobId)).toBe(true);
    expect(await r.settled()).toBe("integrated");
    expect(r.starts[1]?.carriedOver).toBeUndefined();
    await r.engine.close("test over");
  });
});
