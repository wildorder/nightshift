import { createFixtures, makeAgent, makeNode, makeRootNode, makeRun } from "@nightshift/core";
import { createInMemoryStores } from "@nightshift/persistence/memory";
import { describe, expect, it } from "vitest";
import {
  type HeadlessInput,
  interruptOrphans,
  type RootLaunch,
  recoveryNote,
  remoteEnvironmentNote,
  replacingLimitedRoots,
  rootLaunch,
} from "./headless.js";

describe("resuming a run on a replacement machine (P10, T6)", () => {
  it("interrupts what the lost machine had in flight, its agents and the old root's, and leaves settled work alone", async () => {
    const f = createFixtures();
    const stores = createInMemoryStores();
    await stores.runs.put(makeRun(f, { status: "running" }));
    const root = makeRootNode(f, { status: "running" });
    await stores.executionNodes.put(root);
    const running = makeNode(f, root.executionNodeId, { status: "running" });
    const verifying = makeNode(f, root.executionNodeId, { status: "verifying" });
    const queued = makeNode(f, root.executionNodeId, { status: "queued" });
    const integrated = makeNode(f, root.executionNodeId, { status: "integrated" });
    const implemented = makeNode(f, root.executionNodeId, { status: "implemented" });
    const verified = makeNode(f, root.executionNodeId, { status: "verified" });
    const examining = makeNode(f, root.executionNodeId, { status: "examining" });
    const sealed = makeNode(f, root.executionNodeId, { status: "sealed" });
    const subprogram = makeNode(f, root.executionNodeId, {
      kind: "sub-program",
      status: "running",
    });
    const preserved = [verifying, queued, implemented, verified, examining, sealed];
    for (const node of [running, integrated, subprogram, ...preserved])
      await stores.executionNodes.put(node);
    const worker = makeAgent(f, running.executionNodeId, { status: "started" });
    const done = makeAgent(f, integrated.executionNodeId, { status: "completed" });
    const oldRoot = makeAgent(f, root.executionNodeId, { role: "orchestrator", status: "started" });
    const examiner = makeAgent(f, examining.executionNodeId, {
      role: "examiner",
      status: "started",
    });
    for (const agent of [worker, done, oldRoot, examiner]) await stores.agents.put(agent);

    const orphans = await interruptOrphans(stores, f.scope, "2026-10-04T03:00:00.000Z", 2);

    expect([...orphans.interrupted].sort()).toEqual(
      [running.executionNodeId, subprogram.executionNodeId].sort(),
    );
    expect([...orphans.preserved].sort()).toEqual(
      preserved.map((node) => node.executionNodeId).sort(),
    );
    for (const node of preserved) {
      expect(await stores.executionNodes.get(f.scope, node.executionNodeId)).toEqual(node);
    }
    expect((await stores.executionNodes.get(f.scope, running.executionNodeId))?.status).toBe(
      "interrupted",
    );
    expect((await stores.executionNodes.get(f.scope, integrated.executionNodeId))?.status).toBe(
      "integrated",
    );
    expect((await stores.executionNodes.get(f.scope, root.executionNodeId))?.status).toBe(
      "running",
    );
    expect((await stores.agents.get(f.scope, worker.agentId))?.status).toBe("interrupted");
    expect((await stores.agents.get(f.scope, oldRoot.agentId))?.status).toBe("interrupted");
    expect((await stores.agents.get(f.scope, done.agentId))?.status).toBe("completed");
    expect((await stores.agents.get(f.scope, examiner.agentId))?.status).toBe("interrupted");
    expect(
      (await stores.executionNodes.get(f.scope, running.executionNodeId))?.outcomeReason,
    ).toContain("generation 2");
  });

  it("sweeps every page, including running work beyond the first 500 records", async () => {
    const f = createFixtures();
    const stores = createInMemoryStores();
    for (let index = 0; index < 501; index += 1) {
      await stores.executionNodes.put(makeNode(f, f.rootNodeId, { status: "queued" }));
    }
    const last = makeNode(f, f.rootNodeId, { status: "running" });
    await stores.executionNodes.put(last);
    const orphans = await interruptOrphans(stores, f.scope, "2026-10-04T03:00:00.000Z", 2);
    expect(orphans.preserved).toHaveLength(501);
    expect(orphans.interrupted).toEqual([last.executionNodeId]);
    expect((await stores.executionNodes.get(f.scope, last.executionNodeId))?.status).toBe(
      "interrupted",
    );
  });

  it("tells the root what happened and what to retry", () => {
    const note = recoveryNote(3, {
      interrupted: ["node_a", "node_b"],
      preserved: ["node_c"],
    });
    expect(note).toContain("generation 3");
    expect(note).toContain("2 running node(s)");
    expect(note).toContain("1 accepted job(s)");
    expect(note).toContain("job.retry");
    expect(note).toContain("sub-program parents before their children");
    expect(recoveryNote(2, { interrupted: [], preserved: [] })).toContain("No job was in flight");
    expect(note).not.toContain("Delegate their strands again");
  });
});

describe("the remote root owns retryable project setup", () => {
  it("forwards the remote workspace to its MCP engine", () => {
    expect(
      rootLaunch(
        { NIGHTSHIFT_REMOTE_WORKSPACE: "/workspace" },
        { repoPath: "/workspace/checkout", agentId: "agent-root" },
      ).env.NIGHTSHIFT_REMOTE_WORKSPACE,
    ).toBe("/workspace");
  });

  it("briefs status, preparation, diagnosis and retry without a readiness gate", () => {
    expect(remoteEnvironmentNote).toContain("run.attach");
    expect(remoteEnvironmentNote).toContain("environment.status");
    expect(remoteEnvironmentNote).toContain("environment.prepare again");
    expect(remoteEnvironmentNote).toContain("project user, not as the engine");
    expect(remoteEnvironmentNote).toContain("not a delegation certificate");
  });
});

describe("a root stopped by a usage limit (D-P8-06, as amended 2026-10-12)", () => {
  const scope = {
    projectId: "proj_01",
    programId: "prog_01",
    runId: "run_01",
  } as unknown as HeadlessInput["scope"];
  const clock = { now: () => Date.parse("2026-10-12T10:00:00.000Z") };
  const limited = {
    kind: "failed" as const,
    exitCode: 1,
    unavailable: "the provider answered 429 after work began: You've hit your session limit",
    availableAgainAt: "2026-10-12T15:00:00.000Z",
    workBegan: true,
  };
  const run = (status: string) => ({ runId: "run_01", rootNodeId: "node_root", status }) as never;
  const route = (model: string) => ({ harness: "h", provider: "p", model });

  it("is replaced on the next route, told why, unpinned, with every transcript kept", async () => {
    const launches: Parameters<RootLaunch>[] = [];
    const launch: RootLaunch = async (...args) => {
      launches.push(args);
      const first = launches.length === 1;
      return {
        exit: first ? limited : { kind: "completed" },
        run: run(first ? "running" : "succeeded"),
        agentId: `agent_${launches.length}` as never,
        transcript: `t${launches.length}`,
        route: route(first ? "opus" : "astra"),
      };
    };
    const result = await replacingLimitedRoots(
      clock,
      { scope, repoPath: "/repo", harness: "h", model: "opus" },
      launch,
    );
    expect(result.exit.kind).toBe("completed");
    expect(result.transcripts.map((t) => t.path)).toEqual(["t1", "t2"]);
    const [, second] = launches;
    expect(second?.[0]).toEqual({ scope, repoPath: "/repo", recovering: { generation: 0 } });
    expect(second?.[1]).toEqual([{ harness: "h", model: "opus" }]);
    expect(second?.[2]).toMatch(/stopped by a usage limit[\s\S]*It ran on opus/);
  });

  it("leaves every other ending to the run: a failure, or a run no longer running", async () => {
    for (const [exit, status] of [
      [{ kind: "failed" as const, exitCode: 1 }, "running"],
      [limited, "interrupted"],
    ] as const) {
      let launched = 0;
      await replacingLimitedRoots(clock, { scope, repoPath: "/repo" }, async () => {
        launched += 1;
        return {
          exit,
          run: run(status),
          agentId: "agent_1" as never,
          transcript: "t",
          route: route("opus"),
        };
      });
      expect(launched).toBe(1);
    }
  });
});
