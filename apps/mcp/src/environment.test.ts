import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createFixtures } from "@nightshift/core";
import { describe, expect, it, vi } from "vitest";
import { registerOrchestratorTools } from "./orchestrator.js";
import type { ProjectSetup } from "./runner/project-setup.js";
import type { OrchestratorSession } from "./session.js";

const f = createFixtures();
type Handler = (
  input: Record<string, unknown>,
) => Promise<{ structuredContent?: Record<string, unknown> }>;
const fixture = (remote = true) => {
  const setup: ProjectSetup = {
    scope: f.scope,
    preparing: false,
    status: vi.fn<ProjectSetup["status"]>(async () => ({
      state: "failed",
      attempt: 1,
      updatedAt: 0,
      detail: "npm failed",
    })),
    prepare: vi.fn<ProjectSetup["prepare"]>(async (exclusive) => {
      await exclusive?.(async () => {});
      return { state: "preparing", attempt: 2, updatedAt: 1, detail: "retrying" };
    }),
  };
  const agentId = f.ids.next("agent");
  const idle = vi.fn(() => true);
  const withEnvironment = vi.fn(async (task: () => Promise<void>) => task());
  const state = {
    rootAgentId: agentId,
    runtime: { ...(remote ? { projectSetup: setup } : {}) },
    current: {
      session: { scope: f.scope, orchestratorAgentId: agentId },
      engine: { idle, withEnvironment },
    },
  } as unknown as OrchestratorSession;
  const tools = new Map<string, Handler>();
  const schemas = new Map<string, unknown>();
  registerOrchestratorTools(
    {
      registerTool: (name: string, config: { inputSchema: unknown }, handler: Handler) => {
        tools.set(name, handler);
        schemas.set(name, config.inputSchema);
      },
    } as unknown as McpServer,
    { state, env: {} },
  );
  const call = async (name: string) => (await tools.get(name)?.({}))?.structuredContent;
  return { setup, state, idle, withEnvironment, tools, schemas, call };
};

describe("remote root environment tools", () => {
  it("are absent locally and accept no authority-broadening inputs remotely", () => {
    expect(fixture(false).tools.has("environment.prepare")).toBe(false);
    const world = fixture();
    expect(world.schemas.get("environment.prepare")).toEqual({});
    expect(world.schemas.get("environment.status")).toEqual({});
  });

  it("reports failure and allows explicit retry without ending the run", async () => {
    const world = fixture();
    expect(await world.call("environment.status")).toMatchObject({ state: "failed" });
    expect(await world.call("environment.prepare")).toMatchObject({
      state: "preparing",
      attempt: 2,
    });
    expect(world.setup.prepare).toHaveBeenCalledTimes(1);
  });

  it("uses the engine's full-operation mutex even when dependency-held work is queued", async () => {
    const world = fixture();
    world.idle.mockReturnValue(false);
    expect(await world.call("environment.prepare")).toMatchObject({ state: "preparing" });
    expect(world.withEnvironment).toHaveBeenCalledOnce();
    expect(await world.call("environment.status")).toMatchObject({ state: "failed" });
  });

  it("requires the attached root, not merely a matching run id", async () => {
    const world = fixture();
    Object.assign(world.state, { rootAgentId: f.ids.next("agent") });
    expect(await world.call("environment.prepare")).toMatchObject({ code: "pinned_run" });
    expect(world.setup.prepare).not.toHaveBeenCalled();
  });

  it("does not race preparation against a retry whose admission has not reached the engine queue", async () => {
    const world = fixture();
    let finish!: (retried: boolean) => void;
    const retry = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    Object.assign(world.state.current?.engine ?? {}, { retry });
    const request = world.call("job.retry");
    await vi.waitFor(() => expect(retry).toHaveBeenCalledOnce());
    expect(world.idle()).toBe(true);
    expect(await world.call("environment.prepare")).toMatchObject({ code: "job_running" });
    expect(world.setup.prepare).not.toHaveBeenCalled();
    finish(true);
    await request;
  });

  it("serializes new execution against preparation, but does not require a ready environment", async () => {
    const world = fixture();
    Object.assign(world.setup, { preparing: true });
    for (const name of ["delegate", "strand.delegate", "job.retry", "finding.dispute"]) {
      expect(await world.call(name)).toMatchObject({ code: "job_running" });
    }
    Object.assign(world.setup, { preparing: false });
    // The deliberately minimal engine lacks retry: reaching it proves failed setup is not admission.
    expect(await world.call("job.retry")).not.toMatchObject({ code: "job_running" });
  });
});
