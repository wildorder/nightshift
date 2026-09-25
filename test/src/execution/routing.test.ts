/**
 * Routing in the execution layer (P8, T2): a route that cannot start falls back
 * on the same node without a failure anyone waiting sees (D-P8-06); a retry asks
 * the router with the attempt it replaces (D-P8-07); a spent budget starts
 * nothing new (D-P8-08). Over the fake harness, real git and the production API
 * handler, with a router the test controls so the engine is what is under test.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type ExecutionNodeId,
  type JobContract,
  JobContractSchema,
  type ProgramContract,
  type RouteChoice,
  type RouteTarget,
} from "@nightshift/contracts";
import { isSettled, nowIso } from "@nightshift/core";
import {
  completeJob,
  createEngine,
  createEventOutbox,
  type Engine,
  failJob,
  type RouteContext,
} from "@nightshift/execution";
import type { HarnessExit } from "@nightshift/harness";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeHarness, type ScriptContext } from "./fake-harness.js";
import { cleanupWorlds, createWorld, eventsOf, type World } from "./world.js";

afterEach(cleanupWorlds);

const target = (model: string): RouteTarget => ({ harness: "fake", provider: "anthropic", model });

const choice = (model: string, rungIndex: number): RouteChoice => ({
  target: target(model),
  eligibleOptions: [{ target: target(model), eligible: true }],
  ruleId: "R-test",
  wasOverride: false,
  ladder: "fake",
  rung: {
    tier: rungIndex === 0 ? "cheap" : rungIndex === 1 ? "standard" : "frontier",
    index: rungIndex,
  },
});

/** A three-rung ladder the test's router climbs, skipping whatever it is told is unavailable. */
const LADDER = ["cheap-a", "cheap-b", "strong"] as const;

const router =
  (calls: RouteContext[]) =>
  (_job: JobContract, context: RouteContext): RouteChoice => {
    calls.push(context);
    const from =
      context.previous === undefined
        ? 0
        : context.previous.climb
          ? Math.min((context.previous.rungIndex ?? 0) + 1, LADDER.length - 1)
          : (context.previous.rungIndex ?? 0);
    for (let index = from; index < LADDER.length; index += 1) {
      const model = LADDER[index] as string;
      if (!context.unavailable.some((route) => route.model === model)) return choice(model, index);
    }
    throw new Error("nothing is left on the ladder");
  };

type Behaviour = (
  context: ScriptContext,
  finish: (summary: string) => Promise<void>,
) => Promise<HarnessExit>;

const rig = async (behaviour: Behaviour, program: Partial<ProgramContract> = {}) => {
  let world: World | undefined;
  const made = await createWorld({
    harness: createFakeHarness({
      script: async (context) => {
        const w = world as World;
        const outbox = createEventOutbox({
          events: w.stores.events,
          scope: context.identity.scope,
          clock: w.environment.clock,
          ids: w.ids,
          writerId: context.identity.agentId,
          initialDelayMs: 1,
        });
        const environment = { stores: w.stores, clock: w.environment.clock, git: w.git, outbox };
        const finish = async (summary: string): Promise<void> => {
          await completeJob(environment, context.identity, summary);
          await outbox.flush();
        };
        const exit = await behaviour(context, finish);
        if (exit.kind === "failed" && exit.unavailable === undefined) {
          await failJob(environment, context.identity, "the model could not do it");
          await outbox.flush();
        }
        return exit;
      },
    }),
    program,
  });
  world = made;
  const calls: RouteContext[] = [];
  const route = router(calls);
  const engine = createEngine({
    environment: made.environment,
    session: made.session,
    mcp: () => ({ name: "nightshift", command: process.execPath, args: ["--version"], env: {} }),
    route,
  });
  const submit = async (objective: string) => {
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
      route: route(job, { unavailable: [] }),
    });
    return { jobId: job.jobContractId, nodeId: submitted.nodeId };
  };
  return { world: made, engine, calls, submit };
};

const until = async (
  world: World,
  nodeId: ExecutionNodeId,
  predicate: (status: string) => boolean,
) => {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const status =
      (await world.stores.executionNodes.get(world.scope, nodeId))?.status ?? "missing";
    if (predicate(status)) return status;
    if (Date.now() > deadline) throw new Error(`node ${nodeId} is still ${status}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

/** Every attempt at `nodeId` has its ending recorded: the route's result follows the node's. */
const routesSettled = async (world: World, nodeId: ExecutionNodeId) => {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const decisions = [
      ...(await world.stores.routingDecisions.listByNode(world.scope, nodeId)),
    ].sort((a, b) => a.attempt - b.attempt);
    if (decisions.length > 0 && decisions.every((decision) => decision.outcome !== "pending")) {
      return decisions;
    }
    if (Date.now() > deadline) throw new Error(`node ${nodeId}'s routes are still pending`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

const settledOrDone = (engine: Engine) => async () => {
  await engine.settled();
};

const writeModule = async (worktree: string, name: string): Promise<void> => {
  await writeFile(join(worktree, "src", `${name}.js`), `export const ${name} = 1;\n`, "utf8");
};

const unavailableExit = (model: string): HarnessExit => ({
  kind: "failed",
  exitCode: 1,
  unavailable: `the provider answered 429 before any work began: ${model} is rate-limited`,
});

describe("a route that cannot start falls back on the same node (D-P8-06, SC-P8-05)", () => {
  it("starts the next route, keeps the node running, and records the refusal as unavailable", async () => {
    const { world, submit } = await rig(async (context, finish) => {
      if (context.input.model.model === "cheap-a") return unavailableExit("cheap-a");
      await writeModule(context.worktree, "fallback");
      await finish("fallback: done");
      return { kind: "completed" };
    });
    const { nodeId } = await submit("fallback");
    expect(await until(world, nodeId, (status) => isSettled(status as never))).toBe("integrated");

    const decisions = await routesSettled(world, nodeId);
    expect(decisions.map((decision) => [decision.chosen.model, decision.outcome])).toEqual([
      ["cheap-a", "unavailable"],
      ["cheap-b", "verified"],
    ]);
    expect(decisions[1]?.previousRouteId).toBe(decisions[0]?.routingDecisionId);

    const agents = await world.stores.agents.listByNode(world.scope, nodeId);
    const refused = agents.find((agent) => agent.model === "cheap-a");
    expect(refused?.status).toBe("failed");
    expect(refused?.outcomeReason).toMatch(/^route_unavailable: /);

    // Nobody waiting on the node saw it fail.
    const types = (await eventsOf(world))
      .filter((event) => event.executionNodeId === nodeId)
      .map((event) => event.type);
    expect(types).not.toContain("node.failed");
  });

  it("fails the node, saying so, when no route on the ladder can start", async () => {
    const { world, submit } = await rig(async (context) =>
      unavailableExit(context.input.model.model),
    );
    const { nodeId } = await submit("nowhere");
    expect(await until(world, nodeId, (status) => isSettled(status as never))).toBe("failed");
    const node = await world.stores.executionNodes.get(world.scope, nodeId);
    expect(node?.outcomeReason).toMatch(
      /^route_unavailable: .*no other route on this run's ladders could start/,
    );
    const decisions = await world.stores.routingDecisions.listByNode(world.scope, nodeId);
    expect(decisions.map((decision) => decision.outcome).sort()).toEqual([
      "unavailable",
      "unavailable",
      "unavailable",
    ]);
  });
});

describe("a retry asks the router with the attempt it replaces (D-P8-07, SC-P8-06)", () => {
  it("climbs one rung after the model failed the job", async () => {
    const { world, engine, calls, submit } = await rig(async (context, finish) => {
      if (context.input.model.model !== "strong" && context.input.model.model !== "cheap-b") {
        return { kind: "failed", exitCode: 1 };
      }
      await writeModule(context.worktree, "climb");
      await finish("climb: done");
      return { kind: "completed" };
    });
    const { jobId, nodeId } = await submit("climb");
    expect(await until(world, nodeId, (status) => isSettled(status as never))).toBe("failed");

    expect(await engine.retry(jobId)).toBe(true);
    expect(await until(world, nodeId, (status) => status === "integrated")).toBe("integrated");

    const retryCall = calls.at(-1);
    expect(retryCall?.previous).toMatchObject({
      target: { model: "cheap-a" },
      rungIndex: 0,
      climb: true,
    });
    const decisions = await routesSettled(world, nodeId);
    expect(
      decisions.map((decision) => [decision.attempt, decision.chosen.model, decision.outcome]),
    ).toEqual([
      [1, "cheap-a", "failed"],
      [2, "cheap-b", "verified"],
    ]);
    expect(decisions[1]?.previousRouteId).toBe(decisions[0]?.routingDecisionId);
    await settledOrDone(engine)();
  });
});

describe("a spent budget starts nothing new (D-P8-08, SC-P8-07)", () => {
  it("holds the next job once the run's tokens are spent, and says so on the record", async () => {
    const { world, engine, submit } = await rig(
      async (context, finish) => {
        const name = context.input.job.objective;
        await writeModule(context.worktree, name);
        await finish(`${name}: done`);
        return { kind: "completed", usage: { inputTokens: 900, outputTokens: 200 } };
      },
      { costPolicy: { maxTokens: 1_000 } },
    );
    const first = await submit("first");
    expect(await until(world, first.nodeId, (status) => isSettled(status as never))).toBe(
      "integrated",
    );
    await routesSettled(world, first.nodeId);
    const deadline = Date.now() + 30_000;
    while (!engine.idle() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const second = await submit("second");
    expect(await world.stores.executionNodes.get(world.scope, second.nodeId)).toMatchObject({
      status: "queued",
    });
    expect(engine.waiting(second.jobId)).toMatchObject({
      kind: "budget_spent",
      budget: "maxTokens",
      limit: 1_000,
      spent: 1_100,
    });
    const spent = (await eventsOf(world)).filter((event) => event.type === "run.budget_spent");
    expect(spent).toHaveLength(1);
    await engine.close("the test is over");
  });
});
