import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFixtures, makeProgramContract, makeRootNode, makeRun } from "@nightshift/core";
import { createInMemoryStores } from "@nightshift/persistence/memory";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "../compose.js";
import type { LineIdentity } from "./bootstrap.js";
import {
  createLineSession,
  LINE_COMPOSER_CLIENT,
  LINE_COMPOSER_MODEL,
  LINE_COMPOSER_PROVIDER,
  lineEnvironment,
} from "./line-session.js";
import { layoutOf } from "./workspace.js";

vi.mock("@nightshift/execution", async (original) => ({
  ...(await original<typeof import("@nightshift/execution")>()),
  repairProvisionalLine: vi.fn(async () => undefined),
}));

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

const f = createFixtures();

const world = async () => {
  const root = await mkdtemp(join(tmpdir(), "nightshift-line-session-"));
  directories.push(root);
  const stores = createInMemoryStores();
  const program = makeProgramContract(f, { kind: "line" });
  await stores.programContracts.put(program);
  await stores.runs.put(makeRun(f));
  await stores.executionNodes.put(makeRootNode(f));
  const layout = layoutOf(root, f.scope.runId);
  const identity: LineIdentity = {
    kind: "line",
    projectId: f.scope.projectId,
    branch: "nightshift/develop",
    scope: f.scope,
    generation: 1,
    stage: "dev",
    apiEndpoint: "https://api.dev.nightshift.invalid",
    instanceId: "i-0",
  };
  const dispatch = { input: { baseSha: "a".repeat(40) }, generation: 1, amiVersion: "ami-1" };
  const context = {
    identity,
    scope: f.scope,
    layout,
    program,
    dispatch,
    projectEnv: { PATH: "/usr/bin" },
    projectEnvFile: `${layout.run}/project.env`,
  } as unknown as Parameters<typeof createLineSession>[0];
  const runtime = {
    stores,
    ids: f.ids,
    clock: { now: () => Date.parse("2026-10-11T12:00:00Z") },
    paths: { spool: (runId: string) => join(root, "spool", runId) },
    bodies: {},
    workerLaunch: () => ({ name: "worker", command: "worker", args: [], env: {} }),
    projectEnv: { PATH: "/usr/bin" },
  } as unknown as Runtime;
  return { stores, context, runtime, layout };
};

describe("the line's composer host", () => {
  it("gives the composer an orchestrator Agent record written through the stores, an engine and the project environment", async () => {
    const { stores, context, runtime } = await world();
    let made: Record<string, string> | undefined;
    const line = await createLineSession(context, {
      parentEnv: { PATH: "/usr/bin" },
      makeRuntime: async (env) => {
        made = env;
        return runtime;
      },
    });
    const agent = await stores.agents.get(f.scope, line.composerAgentId);
    expect(agent).toMatchObject({
      role: "orchestrator",
      status: "started",
      provider: LINE_COMPOSER_PROVIDER,
      model: LINE_COMPOSER_MODEL,
      harness: LINE_COMPOSER_CLIENT.name,
      executionNodeId: f.rootNodeId,
    });
    expect(line.session.orchestratorAgentId).toBe(line.composerAgentId);
    expect(line.session.scope).toEqual(f.scope);
    expect(line.session.repoPath).toBe(context.layout.checkout);
    expect(line.engine.idle()).toBe(true);
    expect(line.environment.projectEnv).toEqual({ PATH: "/usr/bin" });
    expect((await stores.runs.get(f.scope, f.scope.runId))?.status).toBe("running");
    // The runtime is made for this run, under the engine's token file.
    expect(made?.NIGHTSHIFT_PINNED_RUN).toBe(
      `${f.scope.projectId}/${f.scope.programId}/${f.scope.runId}`,
    );
    expect(made?.NIGHTSHIFT_API_TOKEN_FILE).toContain(f.scope.runId);
    await line.outbox.flush(1000);
  });

  it("never sets the publication base, so the engine installs no landing publisher", async () => {
    const { context, runtime } = await world();
    const withBase = { ...context, program: { ...context.program, kind: undefined } };
    // Even a context whose program were not marked a line is stripped of it.
    const env = lineEnvironment(withBase, { parentEnv: { NIGHTSHIFT_PUBLISH_BASE: "x" } });
    expect(env).not.toHaveProperty("NIGHTSHIFT_PUBLISH_BASE");
    const line = await createLineSession(context, {
      parentEnv: {},
      makeRuntime: async () => runtime,
    });
    expect(line.environment.publish).toBeUndefined();
    expect(line.environment.publishStrand).toBeUndefined();
    await line.outbox.flush(1000);
  });

  it("completes the run, its program node and the composer's agent when the line goes idle", async () => {
    const { stores, context, runtime } = await world();
    const line = await createLineSession(context, {
      parentEnv: {},
      makeRuntime: async () => runtime,
    });
    await line.complete();
    const run = await stores.runs.get(f.scope, f.scope.runId);
    expect(run?.status).toBe("succeeded");
    expect(run?.endedAt).toBeDefined();
    expect((await stores.agents.get(f.scope, line.composerAgentId))?.status).toBe("completed");
    // A second call is a no-op.
    await line.complete();
  });
});
