/**
 * Repair jobs through the root's `delegate` (P15, D-P15-04, D-P15-10, SC-P15-08).
 *
 * The tool's own handler, over in-memory stores and an engine that records what
 * it was handed: what is under test is what `delegate` decides and persists
 * before the engine sees a job, which is all a repair adds.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { JobContract } from "@nightshift/contracts";
import {
  createFixtures,
  makeCheckpoint,
  makeProgramContract,
  makeRootNode,
  makeRun,
} from "@nightshift/core";
import { createInMemoryStores } from "@nightshift/persistence/memory";
import { describe, expect, it } from "vitest";
import { registerOrchestratorTools } from "./orchestrator.js";
import type { AttachedRun, OrchestratorSession } from "./session.js";
import { registerSubOrchestratorTools } from "./sub-orchestrator.js";

type Handler = (input: Record<string, unknown>) => Promise<{
  readonly structuredContent?: Record<string, unknown>;
}>;

const toolsOf = (register: (server: McpServer) => void): ReadonlyMap<string, Handler> => {
  const tools = new Map<string, Handler>();
  register({
    registerTool: (name: string, _config: unknown, handler: Handler) => {
      tools.set(name, handler);
    },
  } as unknown as McpServer);
  return tools;
};

const DECISION = {
  context: "The test gate is red on the base: test/math.test.js imports a file nobody committed.",
  alternatives: [
    { summary: "Skip the test", rejectedBecause: "weakens the gate" },
    { summary: "Commit the missing fixture" },
  ],
  choice: "Commit the missing fixture the test reads.",
  rationale: "The gate stays as strong and passes on a fresh checkout.",
  reversibility: "reversible",
};

const REPAIR_REQUEST = {
  objective: "Make the test gate pass on the base.",
  acceptance: ["npm test passes on a fresh checkout"],
  risk: "low",
};

/** A planned run (`planSections` set), attached, with a checkpoint to decide from. */
const plannedRun = async (options: { planned?: boolean } = {}) => {
  const f = createFixtures();
  const stores = createInMemoryStores();
  const program = makeProgramContract(f, {
    modelPolicy: {
      allowedProviders: ["anthropic"],
      allowedModels: ["claude-sonnet-5"],
      forbiddenModels: [],
    },
  });
  const run = makeRun(f);
  await stores.runs.put(run);
  await stores.executionNodes.put(makeRootNode(f));
  await stores.checkpoints.put(makeCheckpoint(f, f.rootNodeId));
  const submitted: JobContract[] = [];
  const emitted: { type: string; payload: unknown }[] = [];
  const attached = {
    session: {
      scope: f.scope,
      program,
      run,
      rootNodeId: f.rootNodeId,
      orchestratorAgentId: f.ids.next("agent"),
      repoPath: "/nowhere",
    },
    ...(options.planned === false ? {} : { planSections: { strands: {} } }),
    engine: {
      submit: async (submission: { job: JobContract }) => {
        submitted.push(submission.job);
        return { nodeId: "node_submitted", status: "running", started: undefined };
      },
    },
    outbox: {
      emit: (event: { type: string; payload: unknown }) => {
        emitted.push(event);
      },
    },
  } as unknown as AttachedRun;
  const state = {
    current: attached,
    runtime: { stores, ids: f.ids, clock: { now: () => Date.parse("2026-10-07T03:00:00Z") } },
  } as unknown as OrchestratorSession;
  const tools = toolsOf((server) => registerOrchestratorTools(server, { state, env: {} }));
  const call = async (name: string, input: Record<string, unknown>) =>
    (await (tools.get(name) as Handler)(input)).structuredContent ?? {};
  return { f, stores, program, submitted, emitted, call };
};

describe("a repair through delegate (D-P15-04)", () => {
  it("is refused without its decision, and nothing is persisted", async () => {
    const world = await plannedRun();
    const result = await world.call("delegate", {
      ...REPAIR_REQUEST,
      repair: { cause: "red_base", gates: ["test"] },
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("repair_needs_decision");
    expect(world.submitted).toEqual([]);
    expect((await world.stores.decisions.listByRun(world.f.scope)).items).toEqual([]);
    expect((await world.stores.jobContracts.listByRun(world.f.scope)).items).toEqual([]);
    expect(world.emitted).toEqual([]);
  });

  it("is admitted on a planned run, with high risk, no path scope and its recorded decision", async () => {
    const world = await plannedRun();
    const result = await world.call("delegate", {
      ...REPAIR_REQUEST,
      repair: { cause: "red_base", gates: ["test"], decision: DECISION },
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);

    const decisions = (await world.stores.decisions.listByRun(world.f.scope)).items;
    expect(decisions).toHaveLength(1);
    const decision = decisions[0];
    expect(decision?.choice).toBe(DECISION.choice);
    expect(decision?.authority).toBe("agent");
    expect(result.decisionId).toBe(decision?.decisionId);
    // Recorded exactly as decision.record records one: the same event.
    expect(world.emitted.map((event) => event.type)).toEqual(["decision.recorded"]);

    expect(world.submitted).toHaveLength(1);
    const job = world.submitted[0] as JobContract;
    expect(job.repair).toEqual({
      cause: "red_base",
      gates: ["test"],
      decisionId: decision?.decisionId,
    });
    // A repair carries no path scope, like every job (the owner's ruling, 2026-10-09).
    expect(job).not.toHaveProperty("scope");
    expect(job.risk).toBe("high");
    expect(job.strandId).toBeUndefined();
    // The orchestrator's objective first, then Nightshift's paragraph and the decision.
    expect(job.objective.startsWith(REPAIR_REQUEST.objective)).toBe(true);
    expect(job.objective).toContain("REPAIR (red_base) — the gates: test.");
    expect(job.objective).toContain("at least as strong");
    expect(job.objective).toContain("a retry wrapper, a looser assertion");
    expect(job.objective).toContain("unless the decision below says why");
    expect(job.objective).toContain(DECISION.rationale);
  });

  it("still refuses an ordinary delegation on a planned run as plan_fixes_strands", async () => {
    const world = await plannedRun();
    const result = await world.call("delegate", { ...REPAIR_REQUEST });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("plan_fixes_strands");
    expect(world.submitted).toEqual([]);
  });

  it("delegates an unplanned run's repair the same way", async () => {
    const world = await plannedRun({ planned: false });
    const result = await world.call("delegate", {
      objective: "Stop the lint gate flaking.",
      acceptance: ["lint passes ten times in a row"],
      repair: { cause: "flaky", gates: ["lint"], decision: DECISION },
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(world.submitted[0]?.repair?.cause).toBe("flaky");
    expect(world.submitted[0]).not.toHaveProperty("scope");
  });

  it("is refused to a sub-program's orchestrator", async () => {
    const tools = toolsOf((server) =>
      registerSubOrchestratorTools(server, {
        identity: {},
        environment: {},
        stores: {},
        ids: {},
        clock: {},
        outbox: {},
        env: {},
      } as never),
    );
    const result = await (tools.get("delegate") as Handler)({
      ...REPAIR_REQUEST,
      repair: { cause: "flaky", gates: ["test"], decision: DECISION },
    });
    expect(result.structuredContent?.ok).toBe(false);
    expect(result.structuredContent?.code).toBe("repair_not_yours");
  });
});
