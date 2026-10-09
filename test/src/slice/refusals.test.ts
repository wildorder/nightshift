/**
 * SC-P3-01: delegation requires a valid Job Contract.
 *
 * One refusal, and one property that matters more than it: **nothing is
 * persisted**. A refused delegation that had already written a node would leave
 * a run whose tree contains work nobody asked for, and an orchestrator with no
 * way to tell a refusal from a half-started job. A delegation is never refused
 * for the paths its work will change (the owner's ruling, 2026-10-09).
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

  // The owner's ruling, 2026-10-09: a job carries no path scope, so there is
  // nothing to state, narrow or refuse. Work outside the program's planned
  // paths, and under what it excludes, is delegated like any other.
  it("delegates work anywhere in the repository, with no path scope to state or refuse", async () => {
    const { driver, scope } = await attached();
    const job = await driver.call("delegate", {
      objective: "Rewrite the documentation and regenerate src/generated/.",
      acceptance: ["the docs read better", "the generated sources are current"],
    });

    expect(job.ok, JSON.stringify(job)).toBe(true);
    const nodes = await jobNodes(scope);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).not.toHaveProperty("scope");
    const stored = await ctx().stores.jobContracts.get(scope, job.jobId as never);
    expect(stored).toBeDefined();
    expect(stored).not.toHaveProperty("scope");

    await driver.call("job.cancel", { jobId: job.jobId });
  });
});
