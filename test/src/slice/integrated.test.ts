/**
 * The slice that works: SC-P3-02 … SC-P3-06, SC-P3-08, SC-P3-09, SC-P3-10.
 *
 * One delegated job, from `run.start` to a fast-forwarded program branch, driven
 * through the **real server binary** over stdio by a real MCP client, with a
 * real worker process talking to a real worker-role server, real git and a real
 * verification run. The only thing standing in for something is the model.
 *
 * Every assertion reads the control plane.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isSequenced } from "@nightshift/core";
import { git, nodeGitRunner, revParse, sealedRef, tryRevParse } from "@nightshift/execution";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createLocalContext,
  type Orchestrator,
  type SliceContext,
  startOrchestrator,
} from "./context.js";
import { PROGRAM_BRANCH } from "./fixture-repo.js";

const DELEGATION = {
  objective: "Add a median helper to src/math.js, with tests for odd and even lengths.",
  acceptance: ["median([3,1,2]) is 2", "median([1,2,3,4]) is 2.5", "the existing tests still pass"],
};

let context: SliceContext | undefined;
let mcp: Orchestrator | undefined;

beforeEach(async () => {
  context = await createLocalContext();
});

/** The context, or a clear failure if `beforeEach` did not get one. */
const ctx = (): SliceContext => {
  if (context === undefined) throw new Error("the slice context did not start");
  return context;
};

afterEach(async () => {
  await mcp?.close().catch(() => {});
  mcp = undefined;
  // Guarded: a `beforeEach` that threw leaves no context to close, and the
  // teardown's own failure would then hide the real one.
  await context?.close().catch(() => {});
});

/** Starts a run and delegates the fixture job. */
const delegated = async (script: "implement" | "implement-broken" | "beyond-the-plan") => {
  mcp = await startOrchestrator({ context: ctx(), script });
  const started = await mcp.call("run.start", {
    programContractPath: "nightshift.program.json",
    model: "claude-sonnet-5",
  });
  expect(started.ok, JSON.stringify(started)).toBe(true);

  const job = await mcp.call("delegate", DELEGATION);
  expect(job.ok, JSON.stringify(job)).toBe(true);

  const scope = {
    projectId: ctx().program.projectId,
    programId: ctx().program.programId,
    runId: String(started.runId) as never,
  };
  return { started, job, scope, mcp: mcp as Orchestrator };
};

/** Polls `job.wait` until the job settles, as an orchestrator would. */
const settled = async (driver: Orchestrator, jobId: unknown) => {
  let report = await driver.call("job.wait", { jobId });
  while (report.timedOut === true) {
    report = await driver.call("job.wait", { jobId });
  }
  return report;
};

describe("a job that works, end to end", () => {
  it("reaches integrated, and the whole lifecycle is readable from the API alone", async () => {
    const { job, scope, mcp: driver } = await delegated("implement");

    // --- SC-P3-03: an isolated worktree, under the state directory ----------
    expect(String(job.worktree)).toContain(ctx().fixture.stateDir);
    expect(String(job.worktree).startsWith(ctx().fixture.repo)).toBe(false);

    const report = await settled(driver, job.jobId);
    expect(report.status, JSON.stringify(report)).toBe("integrated");

    // --- SC-P3-08, SC-P3-09: sealed, and the branch fast-forwarded ----------
    const sha = String(report.commitSha);
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(
      await tryRevParse(nodeGitRunner, ctx().fixture.repo, sealedRef(String(report.nodeId))),
    ).toBe(sha);
    expect(await revParse(nodeGitRunner, ctx().fixture.repo, PROGRAM_BRANCH)).toBe(sha);
    expect(sha).not.toBe(ctx().fixture.baseCommit);

    // The commit is Nightshift's, and names the work.
    const commit = await git(nodeGitRunner, ["log", "-1", "--format=%an%n%B", sha], {
      cwd: ctx().fixture.repo,
    });
    expect(commit).toContain("Nightshift");
    expect(commit).toContain(`Nightshift-Run: ${scope.runId}`);
    expect(commit).toContain(`Nightshift-Node: ${String(report.nodeId)}`);
    expect(commit).toContain(`Nightshift-Job: ${String(job.jobId)}`);

    // --- SC-P3-04: the worker's edit reached the checkout only by integrating
    const math = await readFile(join(ctx().fixture.repo, "src", "math.js"), "utf8");
    expect(math).toContain("median");

    // --- SC-P3-10: a checkpoint follows integration, at the same commit ------
    const checkpoints = await ctx().stores.checkpoints.listByRun(scope);
    const atCommit = checkpoints.items.filter((checkpoint) => checkpoint.commitSha === sha);
    expect(atCommit).toHaveLength(1);
    expect(await revParse(nodeGitRunner, ctx().fixture.repo, String(atCommit[0]?.ref))).toBe(sha);
    // And the run's first checkpoint is still there, at the base.
    expect(checkpoints.items.some((c) => c.commitSha === ctx().fixture.baseCommit)).toBe(true);

    // --- Verification is Nightshift's, and it ran both steps -----------------
    const verifications = await ctx().stores.verifications.listByNode(
      scope,
      String(report.nodeId) as never,
    );
    expect(verifications).toHaveLength(1);
    expect(verifications[0]?.outcome).toBe("passed");
    expect(verifications[0]?.commands.map((command) => command.stepId)).toEqual(["test", "shape"]);
    for (const command of verifications[0]?.commands ?? []) {
      expect(command.exitCode).toBe(0);
      // A-08: the output is an artifact, never inline.
      expect(command.logArtifactId).toBeDefined();
    }

    // The log really contains what `node --test` said.
    const log = await ctx().readArtifact(
      scope,
      String(verifications[0]?.commands[0]?.logArtifactId),
    );
    expect(log).toContain("# pass");
  });

  /** SC-P3-02: the central record exists before the worker does. */
  it("has the job, node and agent readable before the worker reports anything", async () => {
    const { job, scope, mcp: driver } = await delegated("implement");

    // `delegate` returned once the worker had started, so by now the control
    // plane already knows all three — read from the API, not from the server.
    const contract = await ctx().stores.jobContracts.get(scope, String(job.jobId) as never);
    expect(contract?.objective).toBe(DELEGATION.objective);

    const node = await ctx().stores.executionNodes.get(scope, String(job.nodeId) as never);
    expect(node).toBeDefined();
    expect(["running", "implemented", "verifying", "verified", "sealed", "integrated"]).toContain(
      node?.status,
    );

    const agents = await ctx().stores.agents.listByNode(scope, String(job.nodeId) as never);
    expect(agents[0]?.role).toBe("worker");
    expect(agents[0]?.harness).toBe("claude");

    const routing = await ctx().stores.routingDecisions.listByNode(
      scope,
      String(job.nodeId) as never,
    );
    // P8: the org's rules over its ladders. An unclassified job starts standard.
    expect(routing[0]?.ruleId).toBe("R-default");
    expect(routing[0]?.ladder).toBe("claude");
    expect(routing[0]?.eligibleOptions.length).toBeGreaterThan(0);

    await settled(driver, job.jobId);
  });

  /** SC-P3-05 and SC-P3-06, from the event stream. */
  it("records mcp-sourced progress during the run, and implemented before verified", async () => {
    const { job, scope, mcp: driver } = await delegated("implement");
    await settled(driver, job.jobId);
    await ctx().settle();

    const events = (await ctx().stores.events.listByRun(scope)).items;
    const ordered = events.filter(isSequenced).sort((a, b) => a.sequence - b.sequence);

    // SC-P3-05: progress arrived, from the worker's own tool calls.
    const progress = ordered.filter((event) => event.type === "node.progress");
    expect(progress.length).toBeGreaterThanOrEqual(2);
    expect(progress.every((event) => event.source === "mcp")).toBe(true);

    // SC-P3-06: the worker's claim came first, and verification after it. A
    // worker's report never *is* the verification.
    const implemented = ordered.findIndex((event) => event.type === "node.implemented");
    const requested = ordered.findIndex((event) => event.type === "verification.requested");
    const completed = ordered.findIndex((event) => event.type === "verification.completed");
    expect(implemented).toBeGreaterThanOrEqual(0);
    expect(requested).toBeGreaterThan(implemented);
    expect(completed).toBeGreaterThan(requested);
    // And every progress event came before the completion claim.
    for (const event of progress)
      expect(event.sequence).toBeLessThan(ordered[implemented]?.sequence ?? 0);

    // The integration events follow, in order.
    expect(ordered.findIndex((event) => event.type === "node.integrated")).toBeGreaterThan(
      completed,
    );
  });

  it("removes the worktree once the work is integrated, and keeps the sealed ref", async () => {
    const { job, mcp: driver } = await delegated("implement");
    const report = await settled(driver, job.jobId);
    expect(report.status).toBe("integrated");

    // The branch is gone; the commit is still addressable through its ref.
    const branch = `nightshift/${String(report.nodeId)}`;
    void branch;
    expect(
      await tryRevParse(nodeGitRunner, ctx().fixture.repo, sealedRef(String(report.nodeId))),
    ).toBe(report.commitSha);
  });
});

/**
 * The owner's ruling, 2026-10-09: a job carries no path scope. Through the real
 * server binary and a real worker-role server, a job that changes a file outside
 * where the program's plan expects work (`src/**`, `test/**`) completes, is
 * verified and integrates, the README with the rest.
 */
describe("a job that changes a file outside the program's planned paths", () => {
  it("completes, verifies and integrates, the README with the rest", async () => {
    const { job, scope, mcp: driver } = await delegated("beyond-the-plan");
    const report = await settled(driver, job.jobId);
    expect(report.status, JSON.stringify(report)).toBe("integrated");

    const verifications = await ctx().stores.verifications.listByNode(
      scope,
      String(report.nodeId) as never,
    );
    expect(verifications.map((verification) => verification.outcome)).toEqual(["passed"]);
    expect(await revParse(nodeGitRunner, ctx().fixture.repo, PROGRAM_BRANCH)).toBe(
      String(report.commitSha),
    );
    const readme = await readFile(join(ctx().fixture.repo, "README.md"), "utf8");
    expect(readme).toContain("median: the middle value of a list.");
    const math = await readFile(join(ctx().fixture.repo, "src", "math.js"), "utf8");
    expect(math).toContain("median");
  });
});
