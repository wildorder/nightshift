/**
 * A run raises a step's time, then skips it, and finishes (P19 S-02), through the
 * real MCP server and its real finish path, with a fake harness.
 *
 * Scenario 1 is a strand whose landing times out twice: its orchestrator is
 * resumed with the step that timed out, raises it, and then skips it. Scenario 2
 * is the root's end gate, adjusted through the root's own `step.timeout` and
 * `step.skip` tools at `run.finish`.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  type ExecutionNode,
  type ExecutionNodeId,
  type JobContract,
  JobContractSchema,
  type Verification,
} from "@nightshift/contracts";
import {
  gatherReport,
  markImplemented,
  nowIso,
  type RunScope,
  renderReport,
} from "@nightshift/core";
import {
  completeJob,
  contractGatesAt,
  createEventOutbox,
  git,
  nodeGitRunner,
  recordStepSkip,
  recordStepTimeout,
  recordWorkerDecision,
  runDecisions,
} from "@nightshift/execution";
import type { AgentTask, Harness, HarnessExit } from "@nightshift/harness";
import { createNightshiftServer, type NightshiftServer } from "@nightshift/mcp";
import { afterEach, describe, expect, it } from "vitest";
import {
  createFakeHarness,
  type HarnessScript,
  type ScriptContext,
} from "../execution/fake-harness.js";
import {
  type BaseWorld,
  CONTRACT_FILE,
  cleanupWorlds,
  createBaseWorld,
  localPathsIn,
  workerEnvironmentIn,
} from "../execution/world.js";

afterEach(cleanupWorlds);

const MODEL = "claude-sonnet-5";

interface Structured extends Record<string, unknown> {
  readonly ok: boolean;
}

interface Harnessed {
  readonly call: (name: string, args?: Record<string, unknown>) => Promise<Structured>;
  readonly stop: () => Promise<void>;
}

const start = async (world: BaseWorld, harness: Harness): Promise<Harnessed> => {
  const server: NightshiftServer = await createNightshiftServer({
    env: {
      NIGHTSHIFT_API_ENDPOINT: world.plane.url,
      NIGHTSHIFT_API_TOKEN: "ignored-by-the-local-plane",
      NIGHTSHIFT_STATE_DIR: world.stateDir,
    },
    cwd: world.repo,
    runtime: {
      stores: world.stores,
      bodies: world.bodies,
      tokens: world.tokens,
      harness,
      paths: localPathsIn(world.stateDir),
      git: nodeGitRunner,
      transport: (async () => ({ status: 500, body: undefined })) as never,
      ids: world.ids,
      clock: world.clock,
      endpoint: world.plane.url,
      workerEnvironment: workerEnvironmentIn(world),
      workerLaunch: () => ({
        name: "nightshift",
        command: process.execPath,
        args: ["--version"],
        env: {},
      }),
    },
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "claude-code", version: "2.1.273" });
  await client.connect(clientSide);
  return {
    call: async (name, args = {}) => {
      const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
      return (result.structuredContent ?? {
        ok: false,
        code: "no_structured_content",
      }) as Structured;
    },
    stop: async () => {
      await client.close();
      await server.stop("the test finished");
    },
  };
};

const until = async <T>(what: string, read: () => Promise<T | undefined>): Promise<T> => {
  const deadline = Date.now() + 90_000;
  for (;;) {
    const found = await read();
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error(`${what} did not happen`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

const waitFor = async (mcp: Harnessed, jobId: unknown): Promise<Structured> => {
  let waited = await mcp.call("job.wait", { jobId, timeoutSeconds: 30 });
  while (waited.timedOut === true) {
    waited = await mcp.call("job.wait", { jobId, timeoutSeconds: 30 });
  }
  return waited;
};

/** `run.finish`, called again while the gates run, as an orchestrator would. */
const finish = async (mcp: Harnessed, outcome = "succeeded"): Promise<Structured> => {
  let finished = await mcp.call("run.finish", { outcome });
  while (finished.ok === true && finished.outcome === "verifying") {
    finished = await mcp.call("run.finish", { outcome });
  }
  return finished;
};

const sortedByTime = (verifications: readonly Verification[]): Verification[] =>
  [...verifications].sort((a, b) => a.startedAt.localeCompare(b.startedAt));

const SLOW = { id: "slow", command: "sleep 30", timeoutSeconds: 1, cleanupSeconds: 1 };

const start_ = async (world: BaseWorld, mcp: Harnessed) => {
  const started = await mcp.call("run.start", {
    programContractPath: CONTRACT_FILE,
    model: MODEL,
    repoPath: world.repo,
  });
  expect(started.ok, JSON.stringify(started)).toBe(true);
  return {
    started,
    scope: {
      projectId: world.program.projectId,
      programId: world.program.programId,
      runId: started.runId,
    } as RunScope,
  };
};

/** Adds a median helper and a passing test, then reports completion (server.test.ts's worker). */
const implementWell =
  (world: BaseWorld): HarnessScript =>
  async ({ worktree, identity }) => {
    const math = await readFile(join(worktree, "src", "math.js"), "utf8");
    await writeFile(
      join(worktree, "src", "math.js"),
      `${math}export const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];\n`,
      "utf8",
    );
    await writeFile(
      join(worktree, "test", "median.test.js"),
      [
        'import { test } from "node:test";',
        'import assert from "node:assert/strict";',
        'import { median } from "../src/math.js";',
        'test("median", () => { assert.equal(median([3, 1, 2]), 2); });',
        "",
      ].join("\n"),
      "utf8",
    );
    const outbox = createEventOutbox({
      events: world.stores.events,
      scope: identity.scope,
      clock: world.clock,
      ids: world.ids,
      writerId: identity.agentId,
      initialDelayMs: 1,
    });
    await completeJob(
      { stores: world.stores, clock: world.clock, git: nodeGitRunner, outbox },
      identity,
      "Added a median helper.",
    );
    await outbox.flush(2_000);
    return { kind: "completed" };
  };

describe("a strand's step times out, is raised, then skipped", () => {
  it("lands the strand, ends the run succeeded, and reports what was not verified", async () => {
    const world = await createBaseWorld({
      program: {
        verification: [{ id: "test", command: "node --test" }, SLOW],
        delegationLimits: { maxDepth: 2, maxConcurrency: 2 },
      },
    });
    const fixes: AgentTask[] = [];
    const decisions: { timeout?: string; skip?: string } = {};

    const outboxFor = (context: ScriptContext) =>
      createEventOutbox({
        events: world.stores.events,
        scope: context.identity.scope,
        clock: world.clock,
        ids: world.ids,
        writerId: context.identity.agentId,
        initialDelayMs: 1,
      });
    const environmentFor = (context: ScriptContext) => ({
      stores: world.stores,
      clock: world.clock,
      git: nodeGitRunner,
      outbox: outboxFor(context),
    });

    /** `subprogram.complete`: the strand's node implemented at its branch's head. */
    const complete = async (context: ScriptContext): Promise<void> => {
      const head = (
        await git(nodeGitRunner, ["rev-parse", "HEAD"], { cwd: context.worktree })
      ).trim();
      const node = await world.stores.executionNodes.get(
        context.identity.scope,
        context.identity.executionNodeId,
      );
      await world.stores.executionNodes.put(
        markImplemented(node as ExecutionNode, head as never, nowIso(world.clock)),
      );
    };

    const orchestrate = async (context: ScriptContext): Promise<HarnessExit> => {
      const task = context.input.task as AgentTask | undefined;
      const identity = context.identity;
      if (task?.kind === "strand_fix") {
        fixes.push(task);
        const environment = environmentFor(context);
        const gates = await contractGatesAt(
          nodeGitRunner,
          context.worktree,
          "HEAD",
          identity.scope.programId,
          CONTRACT_FILE,
        );
        if (gates === undefined) throw new Error("the strand cannot read its contract");
        const record = (input: Parameters<typeof recordWorkerDecision>[3]) =>
          recordWorkerDecision(environment, identity, world.ids, input);
        const decided = await runDecisions(world.stores, identity.scope);
        if (fixes.length === 1) {
          const raised = await recordStepTimeout(record, {
            steps: gates.verification,
            decisions: decided,
            stepId: "slow",
            timeoutSeconds: 2,
            reason: "the build step is real work and needs longer",
          });
          decisions.timeout = raised.decisionId;
        } else {
          const own = await world.stores.verifications.listByNode(
            identity.scope,
            identity.executionNodeId,
          );
          const skipped = await recordStepSkip(record, {
            steps: gates.verification,
            decisions: decided,
            verifications: own,
            stepId: "slow",
            reason: "waiting longer did not help; the sleep never ends",
          });
          decisions.skip = skipped.decisionId;
        }
        await environment.outbox.flush();
        await complete(context);
        return { kind: "completed", sessionId: "strand-session" };
      }

      const environment = environmentFor(context);
      await recordWorkerDecision(environment, identity, world.ids, {
        context: "STRAND PLAN: round 1 — 1 job, 1 starting at once",
        alternatives: [{ summary: "the plan as authored" }],
        choice: "J1: the module",
        rationale: "One module is the whole strand.",
        reversibility: "reversible",
      });
      await environment.outbox.flush();
      const at = nowIso(world.clock);
      const job: JobContract = JobContractSchema.parse({
        schemaVersion: 1,
        ...identity.scope,
        jobContractId: world.ids.next("job"),
        objective: "[mod] Add the module.",
        acceptance: ["node --test passes"],
        dependencies: [],
        risk: "low",
        ambiguity: "low",
        createdAt: at,
      });
      await world.stores.jobContracts.put(job);
      await world.stores.executionNodes.put({
        schemaVersion: 1,
        ...identity.scope,
        executionNodeId: world.ids.next("node"),
        kind: "job",
        parentNodeId: identity.executionNodeId,
        depth: 2,
        status: "validated",
        jobContractId: job.jobContractId,
        commitSha: null,
        createdAt: at,
        updatedAt: at,
      } as ExecutionNode);
      await until("the job to merge", async () => {
        const nodes = (await world.stores.executionNodes.listByRun(identity.scope)).items;
        return nodes.find((node) => node.jobContractId === job.jobContractId)?.status === "merged"
          ? true
          : undefined;
      });
      await complete(context);
      return { kind: "completed", sessionId: "strand-session" };
    };

    const work: HarnessScript = async (context) => {
      await writeFile(join(context.worktree, "src", "mod.js"), "export const mod = 1;\n");
      const outbox = outboxFor(context);
      await completeJob(
        { stores: world.stores, clock: world.clock, git: nodeGitRunner, outbox },
        context.identity,
        "Added the module.",
      );
      await outbox.flush();
      return { kind: "completed" };
    };

    const mcp = await start(
      world,
      createFakeHarness({
        script: (context) => {
          if (context.input.agent.role === "examiner")
            return Promise.resolve({ kind: "completed" });
          return context.input.node.kind === "sub-program" ? orchestrate(context) : work(context);
        },
      }),
    );
    const { scope } = await start_(world, mcp);
    const contractBefore = await world.stores.programContracts.get(
      scope.projectId,
      scope.programId,
    );
    const runBefore = await world.stores.runs.get(scope, scope.runId);

    const delegated = await mcp.call("delegate", {
      kind: "sub-program",
      objective: "Add the module.",
      acceptance: ["node --test passes"],
      risk: "low",
    });
    expect(delegated.ok, JSON.stringify(delegated)).toBe(true);
    const strandNodeId = delegated.nodeId as ExecutionNodeId;

    const waited = await waitFor(mcp, delegated.jobId);
    expect(waited.status, JSON.stringify(waited)).toBe("integrated");

    // The orchestrator was told which step timed out, and its time, twice.
    expect(fixes).toHaveLength(2);
    for (const [index, fix] of fixes.entries()) {
      expect(fix.kind).toBe("strand_fix");
      if (fix.kind !== "strand_fix") continue;
      const slow = fix.failedChecks.find((check) => check.stepId === "slow");
      expect(slow?.timedOut, `fix ${index + 1}`).toBe(true);
      expect(slow?.timeoutSeconds).toBe(index === 0 ? 1 : 2);
      expect(slow?.exitCode).toBe(124);
    }
    expect(decisions.timeout).toBeDefined();
    expect(decisions.skip).toBeDefined();

    // The strand's landings: slow exits 124 twice, then is skipped.
    const landings = sortedByTime(await world.stores.verifications.listByNode(scope, strandNodeId));
    expect(landings.map((landing) => landing.outcome)).toEqual(["failed", "failed", "passed"]);
    for (const landing of landings.slice(0, 2)) {
      const slow = landing.commands.find((command) => command.stepId === "slow");
      expect(slow?.exitCode).toBe(124);
    }
    const last = landings.at(-1) as Verification;
    expect(last.commands.find((command) => command.stepId === "test")?.exitCode).toBe(0);
    const skippedSlow = last.commands.find((command) => command.stepId === "slow");
    expect(skippedSlow?.skipped).toEqual({ decisionId: decisions.skip });
    expect(skippedSlow?.exitCode).toBeUndefined();

    // run.finish, through the tool.
    const finished = await finish(mcp);
    expect(finished.ok, JSON.stringify(finished)).toBe(true);
    expect(finished.outcome).toBe("succeeded");
    const notVerified = finished.notVerified as {
      skipped: { stepId: string; decisionId: string; reason: string; commits: string[] }[];
      raised: { stepId: string; from: number; to: number }[];
    };
    expect(notVerified.skipped).toHaveLength(1);
    expect(notVerified.skipped[0]).toMatchObject({
      stepId: "slow",
      decisionId: decisions.skip,
      reason: "waiting longer did not help; the sleep never ends",
    });
    expect(notVerified.raised[0]).toMatchObject({ stepId: "slow", from: 1, to: 2 });

    // The report opens with what was not verified.
    const report = renderReport(await gatherReport(world.stores, scope));
    const section = report.indexOf("## Not verified");
    expect(section).toBeGreaterThan(-1);
    expect(report.slice(0, section)).not.toMatch(/^## /m);
    const landed = String(waited.commitSha);
    expect(report).toContain("**slow was not run**");
    expect(report).toContain(decisions.skip as string);
    expect(report).toContain("waiting longer did not help; the sleep never ends");
    expect(report).toContain(landed.slice(0, 12));
    expect(report).toContain("raised** from 1 to 2 seconds");

    // Nothing was written into the contract or the run's plan.
    expect(await world.stores.programContracts.get(scope.projectId, scope.programId)).toEqual(
      contractBefore,
    );
    const runAfter = await world.stores.runs.get(scope, scope.runId);
    expect(runAfter?.rootNodeId).toBe(runBefore?.rootNodeId);
    expect(runAfter?.policy).toEqual(runBefore?.policy);
    expect(runAfter?.carriedStrands).toEqual(runBefore?.carriedStrands);
    const contractAfter = await world.stores.programContracts.get(scope.projectId, scope.programId);
    expect(contractAfter?.planHash).toBe(contractBefore?.planHash);
    await mcp.stop();
  }, 120_000);
});

describe("the root's end gate times out, is raised, then skipped", () => {
  it("runs the gates again on the same head after each, and ends succeeded with the step skipped", async () => {
    const world = await createBaseWorld({
      program: {
        verification: [
          { id: "test", command: "node --test" },
          { id: "shape", command: 'node -e "process.exit(0)"' },
          { ...SLOW, at: "end" as const },
        ],
      },
    });
    const mcp = await start(world, createFakeHarness({ script: implementWell(world) }));
    const { scope } = await start_(world, mcp);
    const delegated = await mcp.call("delegate", {
      objective: "Add a median helper to src/math.js and a test for it.",
      acceptance: ["median([1,2,3]) is 2", "node --test passes"],
    });
    expect(delegated.ok, JSON.stringify(delegated)).toBe(true);
    const waited = await waitFor(mcp, delegated.jobId);
    expect(waited.status, JSON.stringify(waited)).toBe("integrated");

    const rootVerifications = async () => {
      const nodes = await world.stores.executionNodes.listByRun(scope);
      const root = nodes.items.find((node) => node.kind === "program");
      if (root === undefined) throw new Error("no program node");
      return sortedByTime(
        (await world.stores.verifications.listByNode(scope, root.executionNodeId)).filter(
          (verification) => verification.phase === "run",
        ),
      );
    };

    const refused = await finish(mcp);
    expect(refused.ok).toBe(false);
    expect(refused.code).toBe("end_gates_failed");
    const failing = refused.failing as { stepId: string; exitCode: number }[];
    expect(failing.map((step) => [step.stepId, step.exitCode])).toEqual([["slow", 124]]);
    expect(String(refused.message)).toContain("step.timeout");
    expect(String(refused.message)).toContain("step.skip");
    expect(await rootVerifications()).toHaveLength(1);

    // A step that passed cannot be skipped.
    const passed = await mcp.call("step.skip", { stepId: "test", reason: "it is slow to run" });
    expect(passed.ok).toBe(false);
    expect(String(passed.message)).toContain("test");
    expect(String(passed.message).toLowerCase()).toContain("passed");

    const raised = await mcp.call("step.timeout", {
      stepId: "slow",
      timeoutSeconds: 2,
      reason: "the gate is real work and needs longer",
    });
    expect(raised.ok, JSON.stringify(raised)).toBe(true);
    expect(String(raised.decisionId)).toMatch(/^dec_/);

    const again = await finish(mcp);
    expect(again.ok).toBe(false);
    expect(again.code).toBe("end_gates_failed");
    expect(
      (again.failing as { stepId: string; exitCode: number }[]).map((s) => s.exitCode),
    ).toEqual([124]);
    expect(await rootVerifications()).toHaveLength(2);

    const skipped = await mcp.call("step.skip", {
      stepId: "slow",
      reason: "waiting longer did not help",
    });
    expect(skipped.ok, JSON.stringify(skipped)).toBe(true);

    const finished = await finish(mcp);
    expect(finished.ok, JSON.stringify(finished)).toBe(true);
    expect(finished.outcome).toBe("succeeded");
    const notVerified = finished.notVerified as {
      skipped: { stepId: string; decisionId: string }[];
    };
    expect(notVerified.skipped.map((skip) => [skip.stepId, skip.decisionId])).toEqual([
      ["slow", skipped.decisionId],
    ]);

    const verifications = await rootVerifications();
    expect(verifications).toHaveLength(3);
    expect(new Set(verifications.map((verification) => verification.commitSha)).size).toBe(1);
    const slow = verifications.at(-1)?.commands.find((command) => command.stepId === "slow");
    expect(slow?.skipped).toEqual({ decisionId: skipped.decisionId });
    expect(slow?.exitCode).toBeUndefined();
    await mcp.stop();
  }, 120_000);
});
