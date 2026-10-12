import { createFixtures, makeDispatch, makeProgramContract } from "@nightshift/core";
import { describe, expect, it, vi } from "vitest";
import type { Machine } from "./machine.js";
import { createProjectSetup } from "./project-setup.js";
import { layoutOf, type Prepared } from "./workspace.js";

const f = createFixtures();
const layout = layoutOf("/workspace", f.scope.runId);
const prepared: Prepared = {
  environment: { PATH: "/project/node/bin:/usr/bin" },
  environmentFile: `${layout.run}/project.env`,
  setupSeconds: 1,
  lockfileHashes: {},
  warm: false,
};
const fixture = () => {
  const files = new Map<string, string>();
  const machine = {
    now: () => 100,
    readFile: async (path: string) => files.get(path),
    writeFile: async (path: string, value: string) => {
      files.set(path, value);
    },
  } as Machine;
  const projectEnv = { PATH: "/image/bin", OLD: "remove" } as Record<string, string>;
  const load = vi.fn(async () => ({ dispatch: makeDispatch(f), program: makeProgramContract(f) }));
  return { files, machine, projectEnv, load, scope: f.scope, layout, projectUser: "project" };
};

describe("retryable project preparation", () => {
  it("returns promptly, coalesces concurrent requests, and refreshes the shared environment in place", async () => {
    const input = fixture();
    let finish!: (value: Prepared) => void;
    const perform = vi.fn<typeof import("./workspace.js").prepareProject>(
      () =>
        new Promise<Prepared>((resolve) => {
          finish = resolve;
        }),
    );
    const service = createProjectSetup({ ...input, perform });
    const reference = input.projectEnv;
    expect((await service.status()).state).toBe("not_started");
    const statuses = await Promise.all([service.prepare(), service.prepare()]);
    expect(statuses.map((status) => status.attempt)).toEqual([1, 1]);
    await vi.waitFor(() => expect(perform).toHaveBeenCalledTimes(1));
    expect(service.preparing).toBe(true);
    expect(perform.mock.calls[0]?.[1]).toMatchObject({ projectUser: "project", layout });
    finish(prepared);
    await vi.waitFor(() => expect(service.preparing).toBe(false));
    expect((await service.status()).state).toBe("ready");
    expect(input.projectEnv).toBe(reference);
    expect(reference).toEqual(prepared.environment);
  });

  it("keeps a setup failure retryable, returns bounded redacted diagnostics, and retains a diagnostic log", async () => {
    const input = fixture();
    const perform = vi
      .fn<typeof import("./workspace.js").prepareProject>()
      .mockRejectedValueOnce(new Error(`setup exited 1: password=private ${"x".repeat(4500)}`))
      .mockResolvedValueOnce(prepared);
    const service = createProjectSetup({ ...input, perform });
    await service.prepare();
    await vi.waitFor(() => expect(service.preparing).toBe(false));
    const failed = await service.status();
    expect(failed.state).toBe("failed");
    expect(failed.detail.length).toBeLessThanOrEqual(4000);
    expect(input.files.get(failed.logPath ?? "")).toContain("password=[masked]");
    expect([...input.files.values()].join("\n")).not.toContain("private");
    expect(input.projectEnv.PATH).toBe("/image/bin");
    await service.prepare();
    await vi.waitFor(() => expect(service.preparing).toBe(false));
    expect(await service.status()).toMatchObject({ state: "ready", attempt: 2 });
    expect(input.load).toHaveBeenCalledTimes(2);
  });

  it("recognizes preparation interrupted by a server restart and retries it", async () => {
    const input = fixture();
    input.files.set(
      `${layout.run}/project-setup.json`,
      JSON.stringify({ state: "preparing", attempt: 3, updatedAt: 0, detail: "starting" }),
    );
    const service = createProjectSetup({ ...input, perform: async () => prepared });
    expect(await service.status()).toMatchObject({ state: "interrupted", attempt: 3 });
    await service.prepare();
    await vi.waitFor(() => expect(service.preparing).toBe(false));
    expect(await service.status()).toMatchObject({ state: "ready", attempt: 4 });
  });

  it("keeps successfully installed runtimes available to repair workers after setup fails", async () => {
    const input = fixture();
    const reference = input.projectEnv;
    const service = createProjectSetup({
      ...input,
      perform: async () => {
        input.files.set(`${layout.run}/project.env`, "PATH=/installed/node/bin\n");
        throw new Error("dependency install failed");
      },
    });
    await service.prepare();
    await vi.waitFor(() => expect(service.preparing).toBe(false));
    expect((await service.status()).state).toBe("failed");
    expect(input.projectEnv).toBe(reference);
    expect(reference).toEqual({ PATH: "/installed/node/bin" });
  });

  it("holds the engine mutex until setup and environment refresh have finished", async () => {
    const input = fixture();
    let finish!: (value: Prepared) => void;
    let locked = false;
    const perform = vi.fn<typeof import("./workspace.js").prepareProject>(
      () =>
        new Promise<Prepared>((resolve) => {
          finish = resolve;
        }),
    );
    const service = createProjectSetup({ ...input, perform });
    await service.prepare(async (task) => {
      locked = true;
      await task();
      expect(input.projectEnv).toEqual(prepared.environment);
      locked = false;
    });
    await vi.waitFor(() => expect(perform).toHaveBeenCalledOnce());
    expect(locked).toBe(true);
    expect(service.preparing).toBe(true);
    finish(prepared);
    await vi.waitFor(() => expect(service.preparing).toBe(false));
    expect(locked).toBe(false);
  });

  it("returns an active-work lock refusal without running setup or refreshing the shared environment", async () => {
    const input = fixture();
    input.files.set(`${layout.run}/project.env`, "PATH=/must/not/be/read\n");
    const perform = vi.fn<typeof import("./workspace.js").prepareProject>();
    const service = createProjectSetup({ ...input, perform });
    await service.prepare(async () => {
      throw new Error("environment_busy: a worker is still running");
    });
    await vi.waitFor(() => expect(service.preparing).toBe(false));
    expect(await service.status()).toMatchObject({
      state: "failed",
      detail: "environment_busy: a worker is still running",
    });
    expect(perform).not.toHaveBeenCalled();
    expect(input.load).not.toHaveBeenCalled();
    expect(input.projectEnv.PATH).toBe("/image/bin");
  });
});
