import { createFixtures, makeAgent, makeNode, makeRootNode, makeRun } from "@nightshift/core";
import { createInMemoryStores } from "@nightshift/persistence/memory";
import { describe, expect, it } from "vitest";
import { interruptOrphans, recoveryNote, remoteEnvironmentNote, rootLaunch } from "./headless.js";

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
