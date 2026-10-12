import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFixtures, makeProgramContract, makeRootNode, makeRun } from "@nightshift/core";
import { createEngine, type Engine } from "@nightshift/execution";
import { createInMemoryStores } from "@nightshift/persistence/memory";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "./compose.js";
import { attachRun, type OrchestratorSession } from "./session.js";

vi.mock("@nightshift/execution", async (original) => ({
  ...(await original<typeof import("@nightshift/execution")>()),
  createEngine: vi.fn(),
  repairProvisionalLine: vi.fn(async () => undefined),
}));

const directories: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

const fixture = async (remote: boolean) => {
  const f = createFixtures();
  const path = await mkdtemp(join(tmpdir(), "nightshift-attach-recovery-"));
  directories.push(path);
  const stores = createInMemoryStores();
  const program = makeProgramContract(f);
  await stores.programContracts.put(program);
  await stores.runs.put(makeRun(f));
  await stores.executionNodes.put(makeRootNode(f, { status: "running" }));
  await writeFile(join(path, "nightshift.program.json"), JSON.stringify(program));
  const state: OrchestratorSession = {
    repoPath: path,
    contractFile: "nightshift.program.json",
    ...(remote ? { pinnedRun: f.scope } : {}),
    clientInfo: () => ({ name: "test-orchestrator", version: "1" }),
    workerLaunch: () => ({ name: "test", command: "test", args: [], env: {} }),
    runtime: {
      stores,
      ids: f.ids,
      clock: { now: () => Date.parse("2026-10-11T12:00:00Z") },
      paths: { spool: () => join(path, "no-spool") },
    } as unknown as Runtime,
  };
  const recover = vi.fn(async () => {
    expect(state.current?.session.scope).toEqual(f.scope);
  });
  vi.mocked(createEngine).mockReturnValue({ recover } as unknown as Engine);
  return { state, f, recover };
};

describe("remote attach rebuilds the engine", () => {
  it("binds the session before adopting durable work and waits for recovery", async () => {
    const { state, f, recover } = await fixture(true);
    const attached = await attachRun(state, { model: "test", runId: f.scope.runId });
    expect(state.current).toBe(attached);
    expect(recover).toHaveBeenCalledTimes(1);
    await attached.outbox.flush(1000);
  });

  it("does not adopt work on an ordinary local attach", async () => {
    const { state, f, recover } = await fixture(false);
    const attached = await attachRun(state, { model: "test", runId: f.scope.runId });
    expect(recover).not.toHaveBeenCalled();
    await attached.outbox.flush(1000);
  });
});
