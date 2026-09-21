/**
 * Forced serial against parallel, on the same tree (P6 T6, SC-P6-12).
 *
 * The **correctness** half runs in `npm test`: the same four jobs and the same
 * sub-program end in the same statuses, on a branch holding the same files,
 * whether the program allows one job at a time or two. The **timing** half is
 * printed, and `npm run benchmark:parallel` is how to read it; nothing asserts a
 * speed-up, because a loaded CI machine is not a reason for a red build.
 *
 * Each scripted worker takes a fixed delay standing in for a model's thinking,
 * so the difference measured is scheduling and nothing else.
 */
import { isSettled, type RunScope } from "@nightshift/core";
import { git, nodeGitRunner } from "@nightshift/execution";
import { afterEach, describe, expect, it } from "vitest";
import {
  createLocalContext,
  type Orchestrator,
  type SliceContext,
  startOrchestrator,
} from "../slice/context.js";
import { PROGRAM_BRANCH } from "../slice/fixture-repo.js";

const DELAY_MS = Number(process.env.NIGHTSHIFT_BENCHMARK_DELAY_MS ?? "400");

let context: SliceContext | undefined;
let mcp: Orchestrator | undefined;

afterEach(async () => {
  await mcp?.close().catch(() => {});
  await context?.close().catch(() => {});
  mcp = undefined;
  context = undefined;
});

const runTree = async (maxConcurrency: number) => {
  const ctx = await createLocalContext({ delegationLimits: { maxDepth: 2, maxConcurrency } });
  context = ctx;
  const driver = await startOrchestrator({ context: ctx, harness: "scripted" });
  mcp = driver;
  const started = await driver.call("run.start", {
    programContractPath: "nightshift.program.json",
    model: "claude-fable-5-1",
  });
  const scope: RunScope = {
    projectId: ctx.program.projectId,
    programId: ctx.program.programId,
    runId: String(started.runId) as never,
  };

  const beganAt = Date.now();
  const jobs: string[] = [];
  for (const [objective, extra] of [
    [`[add-module alpha delay=${DELAY_MS}] Add alpha.`, {}],
    [`[add-module beta delay=${DELAY_MS}] Add beta.`, {}],
    [`[orchestrate delay=${DELAY_MS}] Add c1 and c2.`, { kind: "sub-program" }],
  ] as const) {
    const result = await driver.call("delegate", {
      objective,
      scope: { includes: ["src/**", "test/**"] },
      acceptance: ["node --test passes"],
      ...extra,
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    jobs.push(String(result.jobId));
  }
  let remaining = jobs;
  while (remaining.length > 0) {
    const result = await driver.call("job.wait", { jobIds: remaining });
    const reports = (result.jobs ?? [result]) as { jobContractId: string; settled: boolean }[];
    remaining = remaining.filter((id) => !reports.some((r) => r.jobContractId === id && r.settled));
  }
  const wallClockMs = Date.now() - beganAt;

  const nodes = (await ctx.stores.executionNodes.listByRun(scope)).items;
  const files = await git(nodeGitRunner, ["ls-tree", "-r", "--name-only", PROGRAM_BRANCH], {
    cwd: ctx.fixture.repo,
  });
  await driver.close();
  await ctx.close();
  mcp = undefined;
  context = undefined;
  return {
    wallClockMs,
    statuses: nodes
      .filter((node) => node.parentNodeId !== null)
      .map((node) => `${node.kind}@${node.depth}:${node.status}`)
      .sort(),
    allSettled: nodes.every((node) => node.parentNodeId === null || isSettled(node.status)),
    files: files.trim().split("\n").sort(),
  };
};

describe("forced serial against parallel (SC-P6-12)", () => {
  it("reaches the same tree of statuses and the same branch either way", async () => {
    const serial = await runTree(1);
    const parallel = await runTree(2);

    expect(serial.allSettled && parallel.allSettled).toBe(true);
    expect(serial.statuses).toEqual([
      "job@1:integrated",
      "job@1:integrated",
      "job@2:integrated",
      "job@2:integrated",
      "sub-program@1:succeeded",
    ]);
    expect(parallel.statuses).toEqual(serial.statuses);
    expect(parallel.files).toEqual(serial.files);

    process.stdout.write(
      `[benchmark] worker delay ${DELAY_MS} ms; serial (maxConcurrency 1) ${serial.wallClockMs} ms; ` +
        `parallel (maxConcurrency 2) ${parallel.wallClockMs} ms; ` +
        `ratio ${(serial.wallClockMs / parallel.wallClockMs).toFixed(2)}x\n`,
    );
  });
});
