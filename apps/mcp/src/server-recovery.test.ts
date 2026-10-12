import { createFixtures, makeNode, makeRootNode, makeRun } from "@nightshift/core";
import { createInMemoryStores } from "@nightshift/persistence/memory";
import { describe, expect, it, vi } from "vitest";
import { suspendRemoteRun } from "./server.js";
import type { AttachedRun, OrchestratorSession } from "./session.js";

const fixture = async () => {
  const f = createFixtures();
  const stores = createInMemoryStores();
  const run = makeRun(f, { status: "running" });
  const root = makeRootNode(f, { status: "running" });
  const worker = makeNode(f, root.executionNodeId, { status: "running" });
  const queued = makeNode(f, root.executionNodeId, { status: "queued" });
  const candidate = makeNode(f, root.executionNodeId, { status: "verifying" });
  await stores.runs.put(run);
  for (const node of [root, worker, queued, candidate]) await stores.executionNodes.put(node);
  const close = vi.fn(async () => []);
  const stopWorker = vi.fn(async () => undefined);
  const stopCandidate = vi.fn(async () => undefined);
  const flush = vi.fn(async () => undefined);
  const spill = vi.fn(async () => 0);
  const attached = {
    session: { scope: f.scope },
    environment: { stores, paths: { spool: () => "/run/spool" } },
    engine: {
      close,
      jobs: () => [
        { nodeId: worker.executionNodeId, stop: stopWorker },
        { nodeId: candidate.executionNodeId, stop: stopCandidate },
      ],
    },
    outbox: { flush, spill },
  } as unknown as AttachedRun;
  const state = { pinnedRun: f.scope, current: attached } as OrchestratorSession;
  return {
    f,
    stores,
    run,
    root,
    queued,
    candidate,
    close,
    stopWorker,
    stopCandidate,
    flush,
    spill,
    attached,
    state,
  };
};

describe("remote MCP process shutdown is recoverable", () => {
  it("keeps the run, root, accepted queue and candidate intact while stopping live workers", async () => {
    const world = await fixture();
    expect(await suspendRemoteRun(world.state, world.attached, "SIGTERM")).toBe(true);
    expect(world.close).toHaveBeenCalledWith(expect.stringContaining("SIGTERM"), {
      preserveWork: true,
    });
    expect(world.stopWorker).toHaveBeenCalledWith("interrupted");
    expect(world.stopCandidate).not.toHaveBeenCalled();
    expect(await world.stores.runs.get(world.f.scope, world.f.scope.runId)).toEqual(world.run);
    for (const node of [world.root, world.queued, world.candidate]) {
      expect(await world.stores.executionNodes.get(world.f.scope, node.executionNodeId)).toEqual(
        node,
      );
    }
    expect(world.flush).toHaveBeenCalled();
    expect(world.spill).toHaveBeenCalledWith("/run/spool");
  });

  it.each(["cancelled", "failed", "succeeded", "interrupted"] as const)(
    "does not turn an explicit %s outcome into a resumable run",
    async (status) => {
      const world = await fixture();
      await world.stores.runs.put({ ...world.run, status });
      expect(await suspendRemoteRun(world.state, world.attached, "stdin closed")).toBe(false);
      expect(world.close).not.toHaveBeenCalled();
    },
  );

  it("leaves ordinary local shutdown semantics unchanged", async () => {
    const world = await fixture();
    const { pinnedRun: _pinned, ...local } = world.state;
    expect(await suspendRemoteRun(local, world.attached, "SIGTERM")).toBe(false);
    expect(world.close).not.toHaveBeenCalled();
  });

  it("does not interpret an unreachable control plane as authority to discard work", async () => {
    const world = await fixture();
    vi.spyOn(world.stores.runs, "get").mockRejectedValue(new Error("network unavailable"));
    expect(await suspendRemoteRun(world.state, world.attached, "SIGTERM")).toBe(true);
    expect(world.close).toHaveBeenCalledWith(expect.any(String), { preserveWork: true });
  });
});
