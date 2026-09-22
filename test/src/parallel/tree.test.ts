/**
 * Stage 5's fixture, and what it has to prove (P6 T6, SC-P6-01 … SC-P6-17).
 *
 * ```text
 * Program  (maxDepth 2, maxConcurrency 2)
 * ├── Job A
 * ├── Job B
 * └── Sub-program C
 *     ├── Job C1
 *     └── Job C2
 * ```
 *
 * Driven through the **real server binary** over stdio, as an orchestrating
 * harness drives it. Every worker is a real child process speaking to a real
 * worker-role MCP server, and C is a real child speaking to a real
 * **sub-orchestrator**-role server with a delegating token: nothing in C's
 * process can start a job, and the engine finds what it delegated by reading the
 * control plane.
 *
 * Concurrency is asserted from the **event sequence** and forced with barriers
 * between processes, never inferred from timing. Every assertion reads the
 * control plane or the repository.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Event, ExecutionNode } from "@nightshift/contracts";
import { isSequenced, isSettled, type RunScope } from "@nightshift/core";
import { git, nodeGitRunner } from "@nightshift/execution";
import { afterEach, describe, expect, it } from "vitest";
import {
  createLocalContext,
  type Orchestrator,
  type SliceContext,
  type Structured,
  startOrchestrator,
  waitFor,
} from "../slice/context.js";
import { PROGRAM_BRANCH } from "../slice/fixture-repo.js";

let context: SliceContext | undefined;
let mcp: Orchestrator | undefined;

afterEach(async () => {
  await mcp?.close().catch(() => {});
  mcp = undefined;
  await context?.close().catch(() => {});
  context = undefined;
});

const SCOPE = { includes: ["src/**", "test/**"] };

const begin = async (limits: { maxDepth: number; maxConcurrency: number }) => {
  const ctx = await createLocalContext({ delegationLimits: limits });
  context = ctx;
  const driver = await startOrchestrator({ context: ctx, harness: "scripted" });
  mcp = driver;
  const started = await driver.call("run.start", {
    programContractPath: "nightshift.program.json",
    model: "claude-fable-5-1",
  });
  expect(started.ok, JSON.stringify(started)).toBe(true);
  const scope: RunScope = {
    projectId: ctx.program.projectId,
    programId: ctx.program.programId,
    runId: String(started.runId) as never,
  };
  const delegate = async (objective: string, extra: Record<string, unknown> = {}) => {
    const result = await driver.call("delegate", {
      objective,
      scope: SCOPE,
      acceptance: ["node --test passes"],
      ...extra,
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    return result;
  };
  /** Waits until every named job has settled, the way an orchestrator would. */
  const waitAll = async (jobs: readonly Structured[]): Promise<Record<string, string>> => {
    const statuses: Record<string, string> = {};
    let remaining = jobs.map((job) => String(job.jobId));
    while (remaining.length > 0) {
      const result = await driver.call("job.wait", { jobIds: remaining });
      const reports = (result.jobs ?? [result]) as {
        jobContractId: string;
        status: string;
        settled: boolean;
      }[];
      for (const report of reports)
        if (report.settled) statuses[report.jobContractId] = report.status;
      remaining = remaining.filter((jobId) => statuses[jobId] === undefined);
      if (process.env.NIGHTSHIFT_DEBUG_TREE !== undefined) {
        const status = await driver.call("program.status");
        console.log((status.tree as string[]).join("\n"), JSON.stringify(status.engine));
      }
    }
    return statuses;
  };
  const nodes = async (): Promise<readonly ExecutionNode[]> =>
    (await ctx.stores.executionNodes.listByRun(scope)).items;
  const events = async (): Promise<readonly Event[]> => {
    await ctx.settle();
    return (await ctx.stores.events.listByRun(scope)).items
      .filter(isSequenced)
      .sort((a, b) => a.sequence - b.sequence);
  };
  return { ctx, driver, scope, started, delegate, waitAll, nodes, events };
};

/** Whether two nodes were `running` at the same time, by the order of their events. */
const overlapped = (events: readonly Event[], a: string, b: string): boolean => {
  const at = (nodeId: string, type: string): number =>
    events.findIndex((event) => event.executionNodeId === nodeId && event.type === type);
  const ended = (nodeId: string): number => {
    const index = events.findIndex(
      (event) =>
        event.executionNodeId === nodeId &&
        ["node.implemented", "node.failed", "node.cancelled"].includes(event.type),
    );
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
  };
  return at(a, "node.started") < ended(b) && at(b, "node.started") < ended(a);
};

describe("the Stage 5 tree", () => {
  it("runs A and B at once, C as an orchestrator of C1 and C2, and lands all four", async () => {
    const run = await begin({ maxDepth: 2, maxConcurrency: 2 });
    // `wait=2`: neither finishes until both are running. A barrier, not a sleep.
    const a = await run.delegate(
      "[add-module alpha wait=2 group=root] Add the alpha module and its test.",
    );
    const b = await run.delegate(
      "[add-module beta wait=2 group=root] Add the beta module and its test.",
    );
    const c = await run.delegate("Add the c1 and c2 modules, each with its test.", {
      kind: "sub-program",
      scope: { includes: ["src/**", "test/**"] },
    });

    // SC-P6-05: the limit is two and A and B hold both slots, so C queues.
    expect(c.status).toBe("queued");
    expect((await run.driver.call("job.get", { jobId: c.jobId })).waitingFor).toMatchObject({
      kind: "parent_full",
      maxConcurrency: 2,
    });

    const statuses = await run.waitAll([a, b, c]);
    expect(statuses).toEqual({
      [String(a.jobId)]: "integrated",
      [String(b.jobId)]: "integrated",
      [String(c.jobId)]: "succeeded",
    });

    const tree = await run.nodes();
    const events = await run.events();
    const cNode = tree.find((node) => node.executionNodeId === c.nodeId) as ExecutionNode;
    const kids = tree.filter((node) => node.parentNodeId === cNode.executionNodeId);

    // SC-P6-02: C orchestrated. Its children are its own, delegated with its
    // token, by its agent, and they are one level deeper.
    expect(cNode.kind).toBe("sub-program");
    expect(kids).toHaveLength(2);
    expect(kids.every((kid) => kid.status === "integrated" && kid.depth === 2)).toBe(true);
    const [cAgent] = await run.ctx.stores.agents.listByNode(run.scope, cNode.executionNodeId);
    expect(cAgent?.role).toBe("orchestrator");
    const delegations = events.filter(
      (event) =>
        event.type === "node.delegated" &&
        kids.some((kid) => kid.executionNodeId === event.executionNodeId),
    );
    expect(delegations.map((event) => event.agentId)).toEqual([cAgent?.agentId, cAgent?.agentId]);

    // SC-P6-01, SC-P6-03: overlap, read from the event sequence.
    expect(overlapped(events, String(a.nodeId), String(b.nodeId))).toBe(true);
    expect(
      overlapped(events, String(kids[0]?.executionNodeId), String(kids[1]?.executionNodeId)),
    ).toBe(true);
    // And C did not start until one of A and B had finished.
    const started = (nodeId: string) =>
      events.findIndex(
        (event) => event.executionNodeId === nodeId && event.type === "node.started",
      );
    const firstDone = events.findIndex(
      (event) =>
        event.type === "node.implemented" && [a.nodeId, b.nodeId].includes(event.executionNodeId),
    );
    expect(started(String(c.nodeId))).toBeGreaterThan(firstDone);

    // SC-P6-07: every snapshot holds its own job's two files and nothing else.
    for (const event of events.filter((candidate) => candidate.type === "node.implemented")) {
      const paths = (event.payload as { changedPaths: string[] }).changedPaths;
      expect(paths).toHaveLength(2);
      expect(
        new Set(paths.map((path) => path.replace(/^(src|test)\/|\.test\.js$|\.js$/g, ""))).size,
      ).toBe(1);
    }

    // The branch has all four modules, and nothing the orchestrator edited.
    const files = await git(nodeGitRunner, ["ls-tree", "-r", "--name-only", PROGRAM_BRANCH], {
      cwd: run.ctx.fixture.repo,
    });
    for (const name of ["alpha", "beta", "c1", "c2"]) expect(files).toContain(`src/${name}.js`);
    expect(files).not.toContain("orchestrator-was-here");

    // SC-P6-15: every commit that landed was verified as itself.
    const commits = (
      await git(nodeGitRunner, ["rev-list", `${run.ctx.fixture.baseCommit}..${PROGRAM_BRANCH}`], {
        cwd: run.ctx.fixture.repo,
      })
    )
      .trim()
      .split("\n");
    expect(commits).toHaveLength(4);
    const passed = new Set<string>();
    for (const node of tree.filter((candidate) => candidate.kind === "job")) {
      for (const v of await run.ctx.stores.verifications.listByNode(
        run.scope,
        node.executionNodeId,
      )) {
        if (v.outcome === "passed") passed.add(v.commitSha);
      }
    }
    for (const commit of commits) expect(passed.has(commit), commit).toBe(true);

    // The run ends, and its program node with it.
    const finished = await run.driver.call("run.finish", { outcome: "succeeded" });
    expect(finished.ok, JSON.stringify(finished)).toBe(true);
    expect((await run.nodes()).find((node) => node.parentNodeId === null)?.status).toBe(
      "succeeded",
    );

    // SC-P5-14 still holds: every route has an ending, C's among them.
    const cRoute = await run.ctx.stores.routingDecisions.listByNode(
      run.scope,
      cNode.executionNodeId,
    );
    expect(cRoute[0]?.outcome).toBe("succeeded");
  });

  it("leaves every node and agent durable when the server is stopped mid-tree (SC-P6-16)", async () => {
    const run = await begin({ maxDepth: 2, maxConcurrency: 3 });
    // `wait=9` is a barrier nobody will ever satisfy: these workers run until stopped.
    const a = await run.delegate("[add-module alpha wait=9 group=never] Never finishes.");
    const c = await run.delegate("Add the c1 and c2 modules.", { kind: "sub-program" });
    const late = await run.delegate("[add-module late wait=9 group=never] Never finishes.");

    // Until C's own children are running too: two levels of work in flight.
    await waitFor("C's jobs to be running", async () => {
      const kids = (await run.nodes()).filter((node) => node.parentNodeId === c.nodeId);
      return kids.length === 2 && kids.every((kid) => kid.status === "running") ? kids : undefined;
    });

    // The session ends underneath all of it.
    await run.driver.close();
    mcp = undefined;

    const settledTree = await waitFor("every node to settle", async () => {
      const tree = await run.nodes();
      return tree.every((node) => node.parentNodeId === null || isSettled(node.status))
        ? tree
        : undefined;
    });
    const byId = new Map(settledTree.map((node) => [node.executionNodeId as string, node.status]));
    expect(byId.get(String(a.nodeId))).toBe("interrupted");
    expect(byId.get(String(late.nodeId))).toBe("interrupted");
    expect(["interrupted", "cancelled", "failed"]).toContain(byId.get(String(c.nodeId)));
    for (const kid of settledTree.filter((node) => node.parentNodeId === c.nodeId)) {
      expect(["interrupted", "cancelled"]).toContain(kid.status);
    }
    // No agent is left saying it is still working.
    for (const node of settledTree) {
      for (const agent of await run.ctx.stores.agents.listByNode(run.scope, node.executionNodeId)) {
        if (agent.role !== "orchestrator" || node.parentNodeId !== null) {
          expect(["started", "created"], `${agent.agentId} on ${node.kind}`).not.toContain(
            agent.status,
          );
        }
      }
    }
    // The run is written after its nodes: waited for, like them, rather than read
    // once, or a slow runner reads it a moment before shutdown gets there.
    const status = await waitFor("the run to be interrupted", async () => {
      const stored = await run.ctx.stores.runs.get(run.scope, run.scope.runId);
      return stored?.status === "interrupted" ? stored.status : undefined;
    });
    expect(status).toBe("interrupted");
  });

  it("refuses depth and scope from a sub-orchestrator exactly as from the root (SC-P6-04, SC-P6-06)", async () => {
    const run = await begin({ maxDepth: 1, maxConcurrency: 2 });
    // The root may delegate one level. Its own widening is refused...
    const wide = await run.driver.call("delegate", {
      objective: "[add-module wide] Too wide.",
      scope: { includes: ["**"] },
      acceptance: ["x"],
    });
    expect(wide).toMatchObject({ ok: false, code: "scope_widening" });

    // ...and a sub-program's children would be depth 2, which this program
    // forbids: C starts, is refused both delegations by the API, and fails.
    const c = await run.delegate("Add the c1 and c2 modules.", { kind: "sub-program" });
    const statuses = await run.waitAll([c]);
    expect(statuses[String(c.jobId)]).toBe("failed");
    const tree = await run.nodes();
    expect(tree.filter((node) => node.parentNodeId === c.nodeId)).toEqual([]);
    expect(tree.every((node) => node.depth <= 1)).toBe(true);
  });

  it("keeps a conflict explicit and recoverable, and catches an incompatible pair (SC-P6-10, SC-P6-11)", async () => {
    const run = await begin({ maxDepth: 2, maxConcurrency: 2 });
    const loop = await run.delegate("[rewrite-sum loop] Rewrite sum as a reduce.");
    const strict = await run.delegate("[rewrite-sum strict] Rewrite sum to coerce its inputs.");
    const first = await run.waitAll([loop, strict]);
    expect(Object.values(first).sort()).toEqual(["failed", "integrated"]);

    const loser = first[String(loop.jobId)] === "failed" ? loop : strict;
    const report = await run.driver.call("job.get", { jobId: loser.jobId });
    expect(String(report.outcomeReason)).toContain("integration_conflict");
    expect(String(report.outcomeReason)).toContain("src/math.js");

    const retried = await run.driver.call("job.retry", { jobId: loser.jobId });
    expect(retried.ok, JSON.stringify(retried)).toBe(true);
    expect((await run.waitAll([loser]))[String(loser.jobId)]).toBe("integrated");

    // Two jobs with no textual conflict at all. Verification, on the head each
    // would land on, is what tells them apart.
    const rename = await run.delegate("[rename-sum] Rename sum to total.");
    const caller = await run.delegate("[call-sum] Add range, which uses sum.");
    const second = await run.waitAll([rename, caller]);
    expect(Object.values(second).sort()).toEqual(["integrated", "verification_failed"]);

    // The branch still passes the program's own checks.
    const math = await readFile(join(run.ctx.fixture.repo, "src", "math.js"), "utf8");
    expect(
      math.includes("total") !==
        (await readFile(join(run.ctx.fixture.repo, "src", "index.js"), "utf8")).includes("range"),
    ).toBe(true);
    expect(
      (await run.nodes()).every((node) => node.parentNodeId === null || isSettled(node.status)),
    ).toBe(true);
  });
});
