/**
 * The measurement recorder inside the runner (P20 S-01).
 *
 * One recorder per attempt, one segment per launch: a session resumed with a
 * reminder is a second segment of the same agent, and a segment's exit is
 * counted once however the resume goes.
 */
import { existsSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type ExecutionNodeId,
  JobContractSchema,
  type MeasurementSummary,
  type ModelPrice,
  type RouteChoice,
} from "@nightshift/contracts";
import { isSettled, markImplemented, nowIso } from "@nightshift/core";
import { completeJob, createEngine, createEventOutbox, git } from "@nightshift/execution";
import type { Harness, HarnessExit, HarnessStartInput } from "@nightshift/harness";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeHarness, type ScriptContext } from "./fake-harness.js";
import { cleanupWorlds, createWorld } from "./world.js";

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

type Script = (context: ScriptContext) => Promise<HarnessExit>;
type Wrap = (harness: Harness) => Harness;

let counter = 0;
/** The world of the rig being built: scripts run before `rig` returns. */
let rigWorld: Awaited<ReturnType<typeof createWorld>> | undefined;
const observation = (kind: "request" | "snapshot", fields: Record<string, unknown>) => {
  counter += 1;
  return {
    schemaVersion: 1 as const,
    observationId: `obs-${counter}`,
    source: "harness" as const,
    provenance: { adapter: "fake" },
    inclusion: "self" as const,
    kind: kind === "request" ? ("request" as const) : ("cumulative_snapshot" as const),
    ...fields,
  } as never;
};

const rig = async (
  script: Script,
  options: {
    wrap?: Wrap;
    kind?: "job" | "sub-program";
    prices?: Readonly<Record<string, ModelPrice>>;
  } = {},
) => {
  const starts: HarnessStartInput[] = [];
  const fake = createFakeHarness({
    script: (context) => {
      starts.push(context.input);
      return script(context);
    },
  });
  const world = await createWorld({
    harness: options.wrap === undefined ? fake : options.wrap(fake),
  });
  rigWorld = world;
  const policy = world.session.run?.policy;
  const session =
    options.prices === undefined || policy === undefined || world.session.run === undefined
      ? world.session
      : {
          ...world.session,
          run: {
            ...world.session.run,
            policy: {
              ...policy,
              routingPolicy: { ...policy.routingPolicy, prices: options.prices },
            },
          },
        };
  const engine = createEngine({ environment: world.environment, session, mcp });
  const job = JobContractSchema.parse({
    schemaVersion: 1,
    ...world.scope,
    jobContractId: world.ids.next("job"),
    objective: "median helper",
    acceptance: ["node --test passes"],
    dependencies: [],
    risk: "low",
    ambiguity: "low",
    createdAt: nowIso(world.environment.clock),
  });
  const submitted = await engine.submit({
    job,
    depth: 1,
    parentNodeId: world.session.rootNodeId,
    route: ROUTE,
    ...(options.kind === undefined ? {} : { kind: options.kind }),
  });
  const nodeId = submitted.nodeId as ExecutionNodeId;
  const settled = async (): Promise<string> => {
    const deadline = Date.now() + 60_000;
    for (;;) {
      const status =
        (await world.stores.executionNodes.get(world.scope, nodeId))?.status ?? "missing";
      if (isSettled(status as never) && engine.idle()) return status;
      if (Date.now() > deadline) throw new Error(`still ${status}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  const summaries = async (): Promise<readonly MeasurementSummary[]> =>
    world.stores.measurements.listByNode(world.scope, nodeId);
  const decisions = () => world.stores.routingDecisions.listByNode(world.scope, nodeId);
  return { world, engine, starts, jobId: job.jobContractId, nodeId, settled, summaries, decisions };
};

/** A harness whose resumed starts fail the way the test says. */
const failingResume =
  (how: "throws" | "no-handle"): Wrap =>
  (harness) => ({
    ...harness,
    start: async (input) => {
      if (input.resume === undefined) return harness.start(input);
      if (how === "throws") throw new Error("cannot resume");
      return undefined as never;
    },
  });

const USAGE = { inputTokens: 900, outputTokens: 200 };

describe("a session that ends without reporting, and whose resume fails", () => {
  for (const how of ["throws", "no-handle"] as const) {
    it(`counts the last segment once when the resume ${how === "throws" ? "throws" : "yields no handle"}`, async () => {
      const r = await rig(async () => ({ kind: "completed", sessionId: "s1", usage: USAGE }), {
        wrap: failingResume(how),
      });
      expect(await r.settled()).toBe("failed");
      const [decision] = await r.decisions();
      expect(decision?.usage).toMatchObject(USAGE);
      const [summary] = await r.summaries();
      expect(summary?.totals).toMatchObject(USAGE);
      // The failed resume opened a segment but produced nothing.
      expect(summary?.segments.filter((s) => s.counters.inputTokens !== undefined)).toHaveLength(1);
      expect(summary?.segments[0]?.resumedSession).toBe(false);
      await r.engine.close("test over");
    });
  }
});

describe("a resumed session", () => {
  it("sums launch-scoped segments, each its own launch", async () => {
    const r = await rig(async (context) => {
      if (context.input.resume === undefined) {
        return { kind: "completed", sessionId: "s1", usage: USAGE };
      }
      await finishWith(context);
      return { kind: "completed", sessionId: "s1", usage: { inputTokens: 100, outputTokens: 50 } };
    });
    expect(await r.settled()).toBe("integrated");
    const [decision] = await r.decisions();
    expect(decision?.usage).toMatchObject({ inputTokens: 1000, outputTokens: 250 });
    const [summary] = await r.summaries();
    expect(summary?.segments).toHaveLength(2);
    expect(new Set(summary?.segments.map((s) => s.launchId)).size).toBe(2);
    expect(summary?.segments.map((s) => s.resumedSession)).toEqual([false, true]);
    expect(summary?.segments[1]?.sessionId).toBe("s1");
    expect(r.starts[1]?.launch).toMatchObject({ segment: 1 });
    expect(r.starts[0]?.launch).toMatchObject({ segment: 0 });
    await r.engine.close("test over");
  });

  it("does not add a session's cumulative snapshots across the resume", async () => {
    const r = await rig(async (context) => {
      const resumed = context.input.resume !== undefined;
      context.input.measurements?.observe(
        observation("snapshot", {
          counters: { inputTokens: resumed ? 150 : 100 },
          counterScope: "session",
          sessionId: "s1",
        }),
      );
      if (!resumed) return { kind: "completed", sessionId: "s1", usageScope: "session" };
      await finishWith(context);
      return { kind: "completed", sessionId: "s1", usageScope: "session" };
    });
    expect(await r.settled()).toBe("integrated");
    const [summary] = await r.summaries();
    expect(summary?.totals.inputTokens).toBe(150);
    const [decision] = await r.decisions();
    expect(decision?.usage.inputTokens).toBe(150);
    await r.engine.close("test over");
  });

  it("reconciles a session's reported dollars across the resume, into the routing decision", async () => {
    const r = await rig(async (context) => {
      const resumed = context.input.resume !== undefined;
      context.input.measurements?.observe(
        observation("snapshot", {
          counters: { inputTokens: resumed ? 150 : 100, reportedUsd: resumed ? 1.5 : 1 },
          counterScope: "session",
          sessionId: "s1",
        }),
      );
      if (!resumed) return { kind: "completed", sessionId: "s1", usageScope: "session" };
      await finishWith(context);
      return { kind: "completed", sessionId: "s1", usageScope: "session" };
    });
    expect(await r.settled()).toBe("integrated");
    const [summary] = await r.summaries();
    expect(summary?.valuation).toMatchObject({ usd: 1.5, reportedUsd: 1.5 });
    expect(summary?.gaps).toEqual([]);
    const [decision] = await r.decisions();
    expect(decision?.usage.actualCostUsd).toBe(1.5);
    await r.engine.close("test over");
  });
});

/**
 * A strand whose first landing is red, so the engine resumes its orchestrator's
 * session in a new agent (the strand-fix round). The first orchestrator reports
 * `first` input tokens for the session, the second `150`.
 */
const strandFix = async (first: number | undefined) => {
  const world = await createWorld({
    harness: createFakeHarness({
      script: async (context) => {
        const fixing = context.input.resume !== undefined;
        const cumulative = fixing ? 150 : first;
        if (cumulative !== undefined) {
          context.input.measurements?.observe(
            observation("snapshot", {
              counters: { inputTokens: cumulative },
              counterScope: "session",
              sessionId: "strand-session",
            }),
          );
        }
        const at = (name: string) => join(context.worktree, name);
        const commit = (message: string) =>
          git(world.git, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", message], {
            cwd: context.worktree,
          });
        await mkdir(at("test"), { recursive: true });
        if (fixing) {
          await git(world.git, ["rm", "-q", "test/red.test.js"], { cwd: context.worktree });
        } else {
          await writeFile(
            at("test/red.test.js"),
            'import { test } from "node:test";\nimport assert from "node:assert/strict";\ntest("red", () => { assert.equal(1, 2); });\n',
          );
          await git(world.git, ["add", "test/red.test.js"], { cwd: context.worktree });
        }
        await commit(fixing ? "fix" : "red");
        const head = (
          await git(world.git, ["rev-parse", "HEAD"], { cwd: context.worktree })
        ).trim();
        const node = await world.stores.executionNodes.get(
          world.scope,
          context.identity.executionNodeId,
        );
        await world.stores.executionNodes.put(
          markImplemented(node as never, head as never, nowIso(world.environment.clock)),
        );
        return { kind: "completed", sessionId: "strand-session", usageScope: "session" };
      },
    }),
  });
  rigWorld = world;
  const engine = createEngine({
    environment: world.environment,
    session: world.session,
    mcp,
    route: () => ROUTE,
    discoveryIntervalMs: 50,
  });
  const submitted = await engine.submit({
    job: JobContractSchema.parse({
      schemaVersion: 1,
      ...world.scope,
      jobContractId: world.ids.next("job"),
      objective: "A strand.",
      acceptance: ["node --test passes"],
      dependencies: [],
      risk: "low",
      ambiguity: "low",
      kind: "orchestrate",
      createdAt: nowIso(world.environment.clock),
    }),
    depth: 1,
    parentNodeId: world.session.rootNodeId,
    route: ROUTE,
    kind: "sub-program",
  });
  const nodeId = submitted.nodeId as ExecutionNodeId;
  const deadline = Date.now() + 60_000;
  for (;;) {
    const node = await world.stores.executionNodes.get(world.scope, nodeId);
    if (node !== undefined && isSettled(node.status) && engine.idle()) break;
    if (Date.now() > deadline) throw new Error(`still ${node?.status}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const summaries = await world.stores.measurements.listByNode(world.scope, nodeId);
  const agents = [...(await world.stores.agents.listByNode(world.scope, nodeId))].sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  );
  const byAgent = agents.map((agent) => summaries.find((s) => s.agentId === agent.agentId));
  return { engine, agents, byAgent };
};

describe("a new agent that resumes an earlier agent's session", () => {
  it("measures the session from where the earlier agent left it", async () => {
    const r = await strandFix(100);
    expect(r.agents).toHaveLength(2);
    const [one, two] = r.byAgent;
    expect(one?.totals.inputTokens).toBe(100);
    const segment = two?.segments[0];
    expect(segment?.resumedSession).toBe(true);
    expect(segment?.sessionId).toBe("strand-session");
    expect(segment?.baseline).toMatchObject({ inputTokens: 100 });
    expect(segment?.counters).toMatchObject({ inputTokens: 50 });
    expect((one?.totals.inputTokens ?? 0) + (two?.totals.inputTokens ?? 0)).toBe(150);
    await r.engine.close("test over");
  });

  it("records an unknown baseline, and claims no session total, when the earlier agent left none", async () => {
    const r = await strandFix(undefined);
    expect(r.agents).toHaveLength(2);
    const two = r.byAgent[1];
    const segment = two?.segments[0];
    expect(segment?.resumedSession).toBe(true);
    expect(segment?.sessionId).toBe("strand-session");
    expect(segment?.baseline).toBeUndefined();
    expect(JSON.stringify(two?.gaps)).toContain("baseline_unknown");
    expect(two?.totals.inputTokens).toBeUndefined();
    await r.engine.close("test over");
  });
});

describe("one segment", () => {
  it("reconciles repeated launch snapshots to the latest", async () => {
    const r = await rig(async (context) => {
      for (const n of [10, 40, 70]) {
        context.input.measurements?.observe(
          observation("snapshot", { counters: { outputTokens: n }, counterScope: "launch" }),
        );
      }
      return { kind: "failed", exitCode: 1 };
    });
    expect(await r.settled()).toBe("failed");
    const [summary] = await r.summaries();
    expect(summary?.totals.outputTokens).toBe(70);
    await r.engine.close("test over");
  });

  it("keeps request observations when the engine cancels a worker that reports no usage", async () => {
    let seen: () => void = () => {};
    const observed = new Promise<void>((resolve) => {
      seen = resolve;
    });
    const r = await rig(async (context) => {
      for (const n of [100, 200, 300]) {
        context.input.measurements?.observe(
          observation("request", { counters: { inputTokens: n } }),
        );
      }
      seen();
      await context.cancelled;
      return { kind: "cancelled" };
    });
    await observed;
    expect(await r.engine.cancel(r.jobId)).toBe(true);
    expect(await r.settled()).toBe("cancelled");
    const [summary] = await r.summaries();
    expect(summary?.totals.inputTokens).toBe(600);
    const [decision] = await r.decisions();
    expect(decision?.usage.inputTokens).toBe(600);
    expect(decision?.outcome).toBe("cancelled");
    await r.engine.close("test over");
  });
});

describe("a mixed-model launch", () => {
  const PRICE: ModelPrice = { inputPerMTok: 3, outputPerMTok: 15 };
  const launch = async (prices: Readonly<Record<string, ModelPrice>>) => {
    const r = await rig(
      async (context) => {
        for (const model of ["claude-sonnet-5", "gpt-6-sol"]) {
          context.input.measurements?.observe(
            observation("request", {
              model,
              counters: { inputTokens: 1000, outputTokens: 100 },
            }),
          );
        }
        return { kind: "failed", exitCode: 1 };
      },
      { prices },
    );
    expect(await r.settled()).toBe("failed");
    const [summary] = await r.summaries();
    await r.engine.close("test over");
    return summary;
  };

  it("values a request naming a model other than the route's when the table prices it", async () => {
    const summary = await launch({ "claude-sonnet-5": PRICE, "gpt-6-sol": PRICE });
    const models = summary?.valuation.components?.map((c) => c.model) ?? [];
    expect(new Set(models)).toEqual(new Set(["claude-sonnet-5", "gpt-6-sol"]));
    expect(summary?.valuation.completeness?.unvaluedRequests).toBe(0);
  });

  it("counts the request unvalued, never a zero estimate, when only the route's model is priced", async () => {
    const summary = await launch({ "claude-sonnet-5": PRICE });
    expect(summary?.valuation.completeness?.unvaluedRequests).toBe(1);
    const models = summary?.valuation.components?.map((c) => c.model) ?? [];
    expect(new Set(models)).toEqual(new Set(["claude-sonnet-5"]));
    expect(summary?.valuation.components?.every((c) => c.usd > 0)).toBe(true);
  });
});

describe("a completed worker", () => {
  it("links its decision, carries the exit's evidence, and keeps the reported cost", async () => {
    const r = await rig(async (context) => {
      await finishWith(context);
      return {
        kind: "completed",
        usage: { ...USAGE, actualCostUsd: 0.42, costSource: "reported" },
        observedModel: "claude-sonnet-5-20261001",
        coverage: "complete",
      };
    });
    expect(await r.settled()).toBe("integrated");
    const [summary] = await r.summaries();
    const [decision] = await r.decisions();
    expect(summary?.routingDecisionId).toBe(decision?.routingDecisionId);
    expect(summary?.route.model).toBe("claude-sonnet-5");
    expect(summary?.segments[0]?.coverage).toBe("complete");
    expect(JSON.stringify(summary)).toContain("claude-sonnet-5-20261001");
    expect(decision?.usage.actualCostUsd).toBeCloseTo(0.42);
    await r.engine.close("test over");
  });

  it("leaves no journal, everything published, every segment closed", async () => {
    const r = await rig(async (context) => {
      context.input.measurements?.observe(observation("request", { counters: { inputTokens: 5 } }));
      await finishWith(context);
      return { kind: "completed", usage: USAGE };
    });
    expect(await r.settled()).toBe("integrated");
    const [summary] = await r.summaries();
    expect(summary?.ledger.publishedCount).toBe(summary?.ledger.observationCount);
    expect(summary?.ledger.observationCount).toBeGreaterThan(0);
    expect(summary?.segments.every((s) => !s.open)).toBe(true);
    const dir = r.world.environment.paths.measurementsDir(r.world.scope.runId);
    const left = existsSync(dir) ? (await readdir(dir)).filter((f) => f.endsWith(".ndjson")) : [];
    expect(left).toEqual([]);
    await r.engine.close("test over");
  });
});

describe("a sub-orchestrator", () => {
  it("gets a summary too", async () => {
    const r = await rig(async () => ({ kind: "failed", exitCode: 1, usage: USAGE }), {
      kind: "sub-program",
    });
    expect(await r.settled()).toBe("failed");
    const [summary] = await r.summaries();
    const [decision] = await r.decisions();
    expect(summary?.routingDecisionId).toBe(decision?.routingDecisionId);
    expect(summary?.totals).toMatchObject(USAGE);
    expect(decision?.usage).toMatchObject(USAGE);
    await r.engine.close("test over");
  });
});

/** The worker hands its work in, as a real one does through `job.complete`. */
const finishWith = async (context: ScriptContext): Promise<void> => {
  const world = rigWorld as Awaited<ReturnType<typeof createWorld>>;
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
    "done",
  );
  await outbox.flush();
};
