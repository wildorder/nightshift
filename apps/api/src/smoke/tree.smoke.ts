/**
 * The Stage 5 tree, for real (P6 T7, SC-P6-18).
 *
 *   AWS_PROFILE=nightshift npm run slice        (its last phase)
 *
 * The deployed control plane, real adapters, real models:
 *
 * ```text
 * Program  (maxDepth 2, maxConcurrency 2)
 * ├── Job A            pinned to Claude Code
 * ├── Job B            pinned to Codex
 * └── Sub-program C    a real model as orchestrator, holding a delegating token
 *     └── whatever jobs it decides to delegate
 * ```
 *
 * What is asserted is what Nightshift guarantees, not what a model chooses: A
 * and B land through different harnesses at the same time; C delegates at least
 * two jobs of its own, which the engine finds through the control plane and
 * runs; everything that landed was verified on the head it landed on; and the
 * run ends with its program node `succeeded`.
 */
import type { Event, ExecutionNode } from "@nightshift/contracts";
import { isSequenced, isSettled, type RunScope } from "@nightshift/core";
import { git, nodeGitRunner } from "@nightshift/execution";
import { type Orchestrator, PROGRAM_BRANCH, startOrchestrator } from "@nightshift/test/slice";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type DeployedSlice, openDeployedSlice } from "./deployed-slice.js";

/**
 * `1` forces the tree serial, for the benchmark (SC-P6-12). Everything Nightshift
 * guarantees is asserted either way; only the overlap is not, because there is
 * none.
 */
const MAX_CONCURRENCY = Number(process.env.NIGHTSHIFT_TREE_MAX_CONCURRENCY ?? "2");

let slice: DeployedSlice;
let mcp: Orchestrator | undefined;
const startedAt = Date.now();

beforeAll(async () => {
  slice = await openDeployedSlice({
    label: "tree",
    delegationLimits: { maxDepth: 2, maxConcurrency: MAX_CONCURRENCY },
    modelPolicy: {
      allowedProviders: ["anthropic", "openai"],
      allowedModels: ["claude-sonnet-5", "gpt-6-sol"],
      forbiddenModels: [],
    },
  });
});

afterAll(async () => {
  await mcp?.close().catch(() => {});
  try {
    await slice?.cleanup();
  } finally {
    slice?.say(`runtime ${((Date.now() - startedAt) / 1000).toFixed(1)} s`);
  }
});

interface WaitReport {
  readonly jobContractId: string;
  readonly status: string;
  readonly settled: boolean;
  readonly outcomeReason: string | null;
}

/** Waits on several jobs the way an orchestrator does, saying when each one settles. */
const waitForAll = async (
  driver: Orchestrator,
  jobIds: readonly string[],
  began: number,
): Promise<Record<string, string>> => {
  const statuses: Record<string, string> = {};
  let remaining = [...jobIds];
  while (remaining.length > 0) {
    const result = await driver.call("job.wait", { jobIds: remaining });
    for (const report of (result.jobs ?? [result]) as WaitReport[]) {
      if (!report.settled || statuses[report.jobContractId] !== undefined) continue;
      statuses[report.jobContractId] = report.status;
      slice.say(
        `${report.jobContractId} settled ${report.status} at +${Date.now() - began} ms` +
          (report.outcomeReason === null ? "" : `: ${report.outcomeReason}`),
      );
    }
    remaining = remaining.filter((jobId) => statuses[jobId] === undefined);
  }
  return statuses;
};

/** A-05 over the whole run: each commit on the branch has a passed Verification naming it. */
const expectEveryLandedCommitVerified = async (
  scope: RunScope,
  nodes: readonly ExecutionNode[],
): Promise<readonly string[]> => {
  const { context } = slice;
  const commits = (
    await git(nodeGitRunner, ["rev-list", `${context.fixture.baseCommit}..${PROGRAM_BRANCH}`], {
      cwd: context.fixture.repo,
    })
  )
    .trim()
    .split("\n");
  const passed = new Set<string>();
  for (const node of nodes.filter((candidate) => candidate.kind === "job")) {
    for (const v of await context.stores.verifications.listByNode(scope, node.executionNodeId)) {
      if (v.outcome === "passed") passed.add(v.commitSha);
    }
  }
  for (const commit of commits) expect(passed.has(commit), commit).toBe(true);
  return commits;
};

const SCOPE = { includes: ["src/**", "test/**"] };

describe("the Stage 5 tree, with real adapters, against the deployed control plane", () => {
  it("runs two harnesses at once and a real sub-orchestrator, and lands only verified work", async () => {
    const { context } = slice;
    mcp = await startOrchestrator({ context, harness: "claude" });
    const run = await mcp.call("run.start", {
      programContractPath: "nightshift.program.json",
      model: "claude-fable-5-1",
    });
    expect(run.ok, JSON.stringify(run)).toBe(true);
    const scope: RunScope = {
      projectId: slice.projectId,
      programId: context.program.programId,
      runId: String(run.runId) as never,
    };
    slice.track(scope);
    slice.say(`run ${scope.runId}`);

    const delegate = async (input: Record<string, unknown>) => {
      const result = await (mcp as Orchestrator).call("delegate", { scope: SCOPE, ...input });
      expect(result.ok, JSON.stringify(result)).toBe(true);
      slice.say(
        `delegated ${String(result.jobId)} as ${String(result.nodeId)}: ${String(result.status)} ` +
          `on ${String(result.harness)}/${String(result.model)}`,
      );
      return result;
    };

    const began = Date.now();
    const a = await delegate({
      harness: "claude",
      objective:
        "Add a `median` helper to src/math.js, following the conventions of the helpers already " +
        "there, export it from src/index.js, and test it in a new file test/median.test.js. Do " +
        "not change the existing tests.",
      acceptance: ["median([3, 1, 2]) is 2", "median([1, 2, 3, 4]) is 2.5", "node --test passes"],
    });
    const b = await delegate({
      harness: "codex",
      objective:
        "Add a `range` helper (the largest value minus the smallest) in a NEW file src/range.js, " +
        "tested in a new file test/range.test.js. Do not change src/math.js, src/index.js or any " +
        "existing test: another job is working in those files right now.",
      acceptance: [
        "range([1, 5, 3]) is 4",
        "an empty list throws a RangeError",
        "node --test passes",
      ],
    });
    const c = await delegate({
      kind: "sub-program",
      harness: "claude",
      objective:
        "Add two small, independent string helpers to this package, each in its own new module " +
        "with its own new test file: `capitalize` in src/capitalize.js and `reverse` in " +
        "src/reverse.js. They share nothing, so delegate them as two separate jobs and run them " +
        "at the same time. Do not touch src/math.js, src/index.js or the existing tests.",
      acceptance: [
        "capitalize('night') is 'Night', tested in test/capitalize.test.js",
        "reverse('abc') is 'cba', tested in test/reverse.test.js",
        "node --test passes",
      ],
    });
    // The limit is two, and A and B took both slots.
    expect(c.status).toBe("queued");

    const statuses = await waitForAll(
      mcp,
      [a, b, c].map((job) => String(job.jobId)),
      began,
    );
    const status = await mcp.call("program.status");
    slice.say(`tree:\n${(status.tree as string[]).join("\n")}`);

    expect(statuses[String(a.jobId)]).toBe("integrated");
    expect(statuses[String(b.jobId)]).toBe("integrated");
    expect(statuses[String(c.jobId)]).toBe("succeeded");

    const nodes: readonly ExecutionNode[] = (await context.stores.executionNodes.listByRun(scope))
      .items;
    const harnessOf = async (nodeId: string) =>
      (await context.stores.agents.listByNode(scope, nodeId as never)).at(-1);
    expect((await harnessOf(String(a.nodeId)))?.harness).toBe("claude");
    expect((await harnessOf(String(b.nodeId)))?.harness).toBe("codex");
    expect((await harnessOf(String(c.nodeId)))?.role).toBe("orchestrator");

    // C orchestrated: at least two jobs of its own, all of which landed.
    const kids = nodes.filter((node) => node.parentNodeId === c.nodeId);
    expect(kids.length).toBeGreaterThanOrEqual(2);
    expect(kids.every((kid) => kid.depth === 2 && kid.kind === "job")).toBe(true);
    expect(kids.filter((kid) => kid.status === "integrated").length).toBeGreaterThanOrEqual(2);
    expect(nodes.every((node) => node.parentNodeId === null || isSettled(node.status))).toBe(true);

    // A and B ran at the same time, from the event sequence.
    await context.settle();
    // Every page: a tree's run has more events than one page holds.
    const all: Event[] = [];
    let cursor: string | undefined;
    do {
      const page = await context.stores.events.listByRun(
        scope,
        cursor === undefined ? {} : { cursor },
      );
      all.push(...page.items);
      cursor = page.cursor;
    } while (cursor !== undefined);
    const events = all.filter(isSequenced).sort((x, y) => x.sequence - y.sequence);
    const at = (nodeId: unknown, type: string) =>
      events.findIndex((event) => event.executionNodeId === nodeId && event.type === type);
    if (MAX_CONCURRENCY > 1) {
      expect(at(a.nodeId, "node.started")).toBeLessThan(at(b.nodeId, "node.implemented"));
      expect(at(b.nodeId, "node.started")).toBeLessThan(at(a.nodeId, "node.implemented"));
    }
    slice.say(
      `stale bases rebased: ${events.filter((event) => event.type === "node.rebased").length}`,
    );

    // Every commit that landed was verified as itself (A-05).
    const commits = await expectEveryLandedCommitVerified(scope, nodes);
    slice.say(`${commits.length} commits landed, each verified as itself`);

    const finished = await mcp.call("run.finish", { outcome: "succeeded" });
    expect(finished.ok, JSON.stringify(finished)).toBe(true);
    const root = (await context.stores.executionNodes.listByRun(scope)).items.find(
      (node) => node.parentNodeId === null,
    );
    expect(root?.status).toBe("succeeded");
    slice.say(
      `total wall clock ${((Date.now() - began) / 1000).toFixed(1)} s at maxConcurrency ${MAX_CONCURRENCY}`,
    );
  });
});
