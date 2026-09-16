/**
 * SC-P3-01: delegation requires a valid Job Contract.
 *
 * Two refusals, and one property that matters more than either: **nothing is
 * persisted**. A refused delegation that had already written a node would leave
 * a run whose tree contains work nobody asked for, and an orchestrator with no
 * way to tell a refusal from a half-started job.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createLocalContext,
  type Orchestrator,
  type SliceContext,
  startOrchestrator,
} from "./context.js";

let context: SliceContext | undefined;
let mcp: Orchestrator | undefined;

const ctx = (): SliceContext => {
  if (context === undefined) throw new Error("the slice context did not start");
  return context;
};

beforeEach(async () => {
  context = await createLocalContext();
});

afterEach(async () => {
  await mcp?.close().catch(() => {});
  mcp = undefined;
  await context?.close().catch(() => {});
});

/** A started run, with nothing delegated yet. */
const attached = async () => {
  mcp = await startOrchestrator({ context: ctx(), script: "implement" });
  const started = await mcp.call("run.start", {
    programContractPath: "nightshift.program.json",
    model: "claude-sonnet-5",
  });
  expect(started.ok, JSON.stringify(started)).toBe(true);
  return {
    driver: mcp,
    scope: {
      projectId: ctx().program.projectId,
      programId: ctx().program.programId,
      runId: String(started.runId) as never,
    },
  };
};

/** The job nodes of a run. The root is a `program` node and is not one. */
const jobNodes = async (scope: Parameters<SliceContext["readArtifact"]>[0]) => {
  const nodes = await ctx().stores.executionNodes.listByRun(scope);
  return nodes.items.filter((node) => node.kind === "job");
};

describe("SC-P3-01: a delegation must be a valid Job Contract", () => {
  it("refuses an invalid contract, and persists nothing", async () => {
    const { driver, scope } = await attached();

    const refusal = await driver.call("delegate", {
      objective: "Add a median helper.",
      scope: { includes: ["src/**"] },
      // Empty: a job with no acceptance criteria is a job nobody can judge.
      acceptance: [],
    });

    expect(refusal.ok).toBe(false);
    expect(refusal.code).toBe("validation_failed");
    // Refused for the right reason, and by name.
    expect(String(refusal.message)).toContain("acceptance");
    expect(await jobNodes(scope), "a refused delegation leaves no node").toEqual([]);
    expect((await ctx().stores.jobContracts.listByRun(scope)).items).toEqual([]);
  });

  it("refuses a scope the program does not cover, naming the pattern, and persists nothing", async () => {
    const { driver, scope } = await attached();

    const refusal = await driver.call("delegate", {
      objective: "Rewrite the documentation.",
      // The program allows `src/**` and `test/**`. This claims authority it
      // does not inherit, which is A-11 enforced structurally.
      scope: { includes: ["docs/**"] },
      acceptance: ["the docs read better"],
    });

    expect(refusal.ok).toBe(false);
    expect(refusal.code).toBe("scope_widening");
    expect(JSON.stringify(refusal.reasons)).toContain("docs/**");
    // And it says what the parent *does* hold, so the orchestrator can restate.
    expect(JSON.stringify(refusal.reasons)).toContain("src/**");

    expect(await jobNodes(scope)).toEqual([]);
    expect((await ctx().stores.jobContracts.listByRun(scope)).items).toEqual([]);
  });

  it("refuses a scope that drops an exclude the program requires", async () => {
    const { driver, scope } = await attached();
    const refusal = await driver.call("delegate", {
      objective: "Regenerate the generated sources.",
      // `src/**` is covered, but the program excludes `src/generated/**`, and a
      // child that omits an exclude has widened its authority.
      scope: { includes: ["src/**"], excludes: [] },
      acceptance: ["the generated sources are current"],
    });

    expect(refusal.ok).toBe(false);
    expect(refusal.code).toBe("scope_widening");
    expect(JSON.stringify(refusal.reasons)).toContain("src/generated/**");
    expect(await jobNodes(scope)).toEqual([]);
  });

  it("accepts a narrowing scope, which is the whole point of the rule", async () => {
    const { driver, scope } = await attached();
    const job = await driver.call("delegate", {
      objective: "Add a median helper.",
      // Narrower than the program's on every axis: fewer includes, fewer
      // permissions. Narrowing is always allowed; widening never is.
      scope: { includes: ["src/math.js"], permissions: ["fs.read", "fs.write"] },
      acceptance: ["median works"],
    });

    expect(job.ok, JSON.stringify(job)).toBe(true);
    const nodes = await jobNodes(scope);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.scope.includes).toEqual(["src/math.js"]);
    // The effective scope kept the parent's excludes, which were not narrowed.
    expect(nodes[0]?.scope.excludes).toEqual(["src/generated/**"]);
    expect(nodes[0]?.scope.permissions).toEqual(["fs.read", "fs.write"]);

    await driver.call("job.cancel", { jobId: job.jobId });
  });
});
