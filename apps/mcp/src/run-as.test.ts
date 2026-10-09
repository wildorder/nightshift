import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createReclaim, createWorkerUsers, WORKER_GROUP, workerUserName } from "./run-as.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the worker users (D-P10-25)", () => {
  it("gives every user the project environment, its credential directory beside it (P16 S-01)", () => {
    const root = mkdtempSync(join(tmpdir(), "ns-runas-"));
    dirs.push(root);
    mkdirSync(join(root, "worker-1", "CODEX_HOME"), { recursive: true });
    const projectEnv = {
      PATH: "/workspace/stores/runtimes/installs/node/22.11.0/bin:/usr/local/bin:/usr/bin:/bin",
      npm_config_cache: "/workspace/stores/npm",
    };
    const runAs = createWorkerUsers({
      count: 2,
      credentialRoot: root,
      projectEnv,
      exec: async () => undefined,
    });
    const first = runAs({ agentId: "agent_1", role: "worker" });
    const second = runAs({ agentId: "agent_2", role: "worker" });
    expect(first?.env).toEqual({
      ...projectEnv,
      CODEX_HOME: join(root, "worker-1", "CODEX_HOME"),
    });
    // No DOCKER_HOST of the engine's: the wrapper gives each user its own socket.
    expect(second?.env).toEqual(projectEnv);
  });

  it("hands users out round-robin, grants by chown, and names a credential directory the user has", () => {
    const root = mkdtempSync(join(tmpdir(), "ns-runas-"));
    dirs.push(root);
    mkdirSync(join(root, "worker-2", "CODEX_HOME"), { recursive: true });
    const ran: string[][] = [];
    const runAs = createWorkerUsers({
      count: 3,
      credentialRoot: root,
      exec: async (file, args) => void ran.push([file, ...args]),
    });
    const agentOf = (id: string) => ({ agentId: id, role: "worker" });
    const first = runAs(agentOf("agent_1"));
    const second = runAs(agentOf("agent_2"));
    const third = runAs(agentOf("agent_3"));
    const fourth = runAs(agentOf("agent_4"));
    expect([first?.user, second?.user, third?.user, fourth?.user]).toEqual([
      "worker-1",
      "worker-2",
      "worker-3",
      "worker-1",
    ]);
    // The same agent keeps its user: the engine asks again to verify its worktree.
    expect(runAs(agentOf("agent_2"))).toBe(second);
    expect(first?.env).toBeUndefined();
    expect(second?.env).toEqual({ CODEX_HOME: join(root, "worker-2", "CODEX_HOME") });
    return second?.grant("/tmp/cfg").then(() => {
      expect(ran).toEqual([["chown", "-R", `worker-2:${WORKER_GROUP}`, "/tmp/cfg"]]);
    });
  });

  it("names nobody when the machine has no worker users", () => {
    expect(createWorkerUsers({ count: 0 })({ agentId: "a", role: "worker" })).toBeUndefined();
    expect(workerUserName(0)).toBe("worker-1");
  });
});

describe("reclaiming a granted path (D-P10-25)", () => {
  it("chowns it back to the engine and the shared group, and skips a path that is gone", async () => {
    const root = mkdtempSync(join(tmpdir(), "ns-reclaim-"));
    dirs.push(root);
    const ran: string[][] = [];
    const reclaim = createReclaim("engine", async (file, args) => void ran.push([file, ...args]));
    await reclaim(root);
    await reclaim(join(root, "gone"));
    expect(ran).toEqual([["chown", "-R", `engine:${WORKER_GROUP}`, root]]);
  });
});
