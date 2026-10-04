import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkerUsers, WORKER_GROUP, workerUserName } from "./run-as.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the worker users (D-P10-25)", () => {
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
