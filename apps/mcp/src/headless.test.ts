import { createFixtures, makeAgent, makeNode, makeRootNode, makeRun } from "@nightshift/core";
import { createInMemoryStores } from "@nightshift/persistence/memory";
import { describe, expect, it } from "vitest";
import { interruptOrphans, recoveryNote } from "./headless.js";

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
    for (const node of [running, verifying, queued, integrated, implemented])
      await stores.executionNodes.put(node);
    const worker = makeAgent(f, running.executionNodeId, { status: "started" });
    const done = makeAgent(f, integrated.executionNodeId, { status: "completed" });
    const oldRoot = makeAgent(f, root.executionNodeId, { role: "orchestrator", status: "started" });
    for (const agent of [worker, done, oldRoot]) await stores.agents.put(agent);

    const orphans = await interruptOrphans(stores, f.scope, "2026-10-04T03:00:00.000Z", 2);

    expect([...orphans.interrupted].sort()).toEqual(
      [running.executionNodeId, verifying.executionNodeId].sort(),
    );
    expect(orphans.failed).toEqual([implemented.executionNodeId]);
    expect(orphans.cancelled).toEqual([queued.executionNodeId]);
    expect((await stores.executionNodes.get(f.scope, queued.executionNodeId))?.status).toBe(
      "cancelled",
    );
    expect((await stores.executionNodes.get(f.scope, implemented.executionNodeId))?.status).toBe(
      "failed",
    );
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
    expect(
      (await stores.executionNodes.get(f.scope, running.executionNodeId))?.outcomeReason,
    ).toContain("generation 2");
  });

  it("tells the root what happened and what to retry", () => {
    const note = recoveryNote(3, {
      interrupted: ["node_a", "node_b"],
      failed: ["node_c"],
      cancelled: [],
    });
    expect(note).toContain("generation 3");
    expect(note).toContain("2 job(s) were in flight");
    expect(note).toContain("1 job(s) had been implemented");
    expect(note).toContain("job_retry");
    expect(recoveryNote(2, { interrupted: [], failed: [], cancelled: [] })).toContain(
      "No job was in flight",
    );
    expect(recoveryNote(2, { interrupted: [], failed: [], cancelled: ["node_q"] })).toContain(
      "Delegate their strands again",
    );
  });
});
