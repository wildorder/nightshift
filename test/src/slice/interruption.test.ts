/**
 * SC-P3-11 and SC-P3-12: what survives a process.
 *
 * These two are the reason the slice suite drives real child processes rather
 * than in-process fakes. Both are claims about what is true *after* something
 * has died, and a fake that never dies cannot make either.
 *
 * - **SC-P3-11**: kill the worker from outside, by the pid the control plane
 *   itself reports, and the node and agent still end durably with a reason. Then
 *   close the orchestrator entirely and open a new one: the state is still
 *   there, because it was never in the process.
 * - **SC-P3-12**: the worst-behaved worker imaginable — one that calls no tool,
 *   prints nothing and exits non-zero — still produces `agent.started` and an
 *   ending, from the harness observing the process.
 */
import { nodeGitRunner, revParse } from "@nightshift/execution";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createLocalContext,
  killPid,
  type Orchestrator,
  type SliceContext,
  startOrchestrator,
  waitFor,
} from "./context.js";
import { PROGRAM_BRANCH } from "./fixture-repo.js";

let context: SliceContext | undefined;
const opened: Orchestrator[] = [];

const ctx = (): SliceContext => {
  if (context === undefined) throw new Error("the slice context did not start");
  return context;
};

beforeEach(async () => {
  context = await createLocalContext();
});

afterEach(async () => {
  for (const mcp of opened.splice(0)) await mcp.close().catch(() => {});
  await context?.close().catch(() => {});
});

const open = async (script: "hang" | "silent-exit"): Promise<Orchestrator> => {
  const mcp = await startOrchestrator({ context: ctx(), script });
  opened.push(mcp);
  return mcp;
};

const DELEGATION = {
  objective: "Add a median helper to src/math.js.",
  scope: { includes: ["src/**", "test/**"] },
  acceptance: ["median works"],
};

describe("SC-P3-11: killing the worker leaves durable state", () => {
  it("ends the node and agent with a reason, readable after the orchestrator is gone", async () => {
    const first = await open("hang");
    const started = await first.call("run.start", {
      programContractPath: "nightshift.program.json",
      model: "claude-sonnet-5",
    });
    const runId = String(started.runId);
    const scope = {
      projectId: ctx().program.projectId,
      programId: ctx().program.programId,
      runId: runId as never,
    };

    const job = await first.call("delegate", DELEGATION);
    expect(job.ok, JSON.stringify(job)).toBe(true);

    // The worker's pid, as the control plane reports it — not as this test
    // happens to know it. Killing something the API could not name would prove
    // less.
    const report = await first.call("job.get", { jobId: job.jobId });
    const pid = Number(report.pid);
    expect(Number.isInteger(pid), JSON.stringify(report)).toBe(true);

    // Wait until the worker has actually reported something, so the kill lands
    // mid-job rather than before it started.
    await waitFor("the worker to report progress", async () => {
      await ctx().settle();
      const events = (await ctx().stores.events.listByRun(scope)).items;
      return events.some((event) => event.type === "node.progress") ? true : undefined;
    });

    killPid(pid, "SIGKILL");

    const node = await waitFor("the node to end durably", async () => {
      const found = await ctx().stores.executionNodes.get(scope, String(job.nodeId) as never);
      return found !== undefined && ["interrupted", "failed", "cancelled"].includes(found.status)
        ? found
        : undefined;
    });

    // A signal on POSIX; Windows reports no signal and an exit code, and the
    // contract says the proof is durable state rather than the label.
    expect(process.platform === "win32" ? ["failed", "interrupted"] : ["interrupted"]).toContain(
      node.status,
    );
    expect(node.outcomeReason, "silence is the one outcome nobody can act on").toBeDefined();

    const agents = await ctx().stores.agents.listByNode(scope, String(job.nodeId) as never);
    expect(["interrupted", "failed"]).toContain(agents[0]?.status);
    expect(agents[0]?.outcomeReason).toBeDefined();
    expect(agents[0]?.endedAt).toBeDefined();

    // Nothing integrated, and the worktree is kept for inspection.
    expect(await revParse(nodeGitRunner, ctx().fixture.repo, PROGRAM_BRANCH)).toBe(
      ctx().fixture.baseCommit,
    );

    // --- And now the part that matters: close the server entirely ------------
    await first.close();
    opened.length = 0;

    const second = await startOrchestrator({ context: ctx(), script: "hang" });
    opened.push(second);
    const attached = await second.call("run.attach", { model: "claude-sonnet-5", runId });
    expect(attached.ok, JSON.stringify(attached)).toBe(true);

    // The state is readable from a process that never saw the job run, because
    // it was never in a process.
    const after = await second.call("job.get", { jobId: job.jobId });
    expect(after.status).toBe(node.status);
    expect(String(after.outcomeReason)).toBe(node.outcomeReason);

    const tree = await second.call("execution.status");
    expect(String((tree.lines as string[]).join("\n"))).toContain(node.status);
  });
});

describe("SC-P3-12: hook events arrive without the worker's cooperation", () => {
  it("records agent.started and an ending for a worker that calls and prints nothing", async () => {
    const mcp = await open("silent-exit");
    const started = await mcp.call("run.start", {
      programContractPath: "nightshift.program.json",
      model: "claude-sonnet-5",
    });
    const scope = {
      projectId: ctx().program.projectId,
      programId: ctx().program.programId,
      runId: String(started.runId) as never,
    };

    const job = await mcp.call("delegate", DELEGATION);
    let report = await mcp.call("job.wait", { jobId: job.jobId });
    while (report.timedOut === true) report = await mcp.call("job.wait", { jobId: job.jobId });

    // The node ended durably, and the reason names what actually happened: this
    // script exits 1, so it is the exit that is reported. (A worker that exits
    // *zero* having said nothing gets "exited 0 without reporting completion"
    // instead — `test/src/execution/failures.test.ts` covers that one.)
    expect(report.status).toBe("failed");
    expect(String(report.outcomeReason)).toContain("exited 1");

    await ctx().settle();
    const events = (await ctx().stores.events.listByRun(scope)).items;

    const hooks = events.filter((event) => event.source === "hook");
    const types = hooks.map((event) => event.type);
    expect(types, "the start came from observing the process").toContain("agent.started");
    expect(types, "and so did the ending").toContain("agent.failed");

    // The worker called nothing, so there is no `mcp`-sourced event about it at
    // all. That asymmetry is the whole point of having two channels: the gap is
    // visible rather than indistinguishable from silence.
    expect(events.filter((event) => event.type === "node.progress")).toEqual([]);
    expect(events.filter((event) => event.type === "node.implemented")).toEqual([]);

    // And every event an adapter produced is labelled as an adapter's.
    for (const hook of hooks) {
      expect(hook.type.startsWith("agent.") || hook.type.startsWith("tool.")).toBe(true);
    }
  });

  it("labels a worker's own reports as mcp, and the adapter's as hook", async () => {
    const mcp = await startOrchestrator({ context: ctx(), script: "implement" });
    opened.push(mcp);
    const started = await mcp.call("run.start", {
      programContractPath: "nightshift.program.json",
      model: "claude-sonnet-5",
    });
    const scope = {
      projectId: ctx().program.projectId,
      programId: ctx().program.programId,
      runId: String(started.runId) as never,
    };
    const job = await mcp.call("delegate", DELEGATION);
    let report = await mcp.call("job.wait", { jobId: job.jobId });
    while (report.timedOut === true) report = await mcp.call("job.wait", { jobId: job.jobId });

    await ctx().settle();
    const events = (await ctx().stores.events.listByRun(scope)).items;
    const sourceOf = (type: string) =>
      new Set(events.filter((event) => event.type === type).map((event) => event.source));

    // Intent, from the worker's own tool calls.
    expect(sourceOf("node.progress")).toEqual(new Set(["mcp"]));
    expect(sourceOf("node.implemented")).toEqual(new Set(["mcp"]));
    // Ground truth, from the adapter watching the process.
    expect(sourceOf("agent.started")).toEqual(new Set(["hook"]));
    expect(sourceOf("tool.called")).toEqual(new Set(["hook"]));
    // Nightshift's own actions.
    expect(sourceOf("node.queued")).toEqual(new Set(["control-plane"]));
    expect(sourceOf("verification.completed")).toEqual(new Set(["control-plane"]));
    expect(sourceOf("node.integrated")).toEqual(new Set(["control-plane"]));
  });
});
