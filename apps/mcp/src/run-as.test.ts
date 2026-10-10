import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createProjectUser, createReclaim, PROJECT_USER, WORKER_GROUP } from "./run-as.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the project user (D-P10-30)", () => {
  it("is the one user for every agent and step, with the project environment and its credential directory", () => {
    const root = mkdtempSync(join(tmpdir(), "ns-runas-"));
    dirs.push(root);
    mkdirSync(join(root, "CODEX_HOME"), { recursive: true });
    const projectEnv = {
      PATH: "/workspace/stores/runtimes/installs/node/22.11.0/bin:/usr/local/bin:/usr/bin:/bin",
      npm_config_cache: "/workspace/stores/npm",
    };
    const runAs = createProjectUser({
      user: PROJECT_USER,
      credentialRoot: root,
      projectEnv,
      exec: async () => undefined,
    });
    const worker = runAs({ agentId: "agent_1", role: "worker" });
    const examiner = runAs({ agentId: "agent_2", role: "examiner" });
    const gates = runAs({ agentId: "agent_3-gates", role: "worker" });
    expect([worker.user, examiner.user, gates.user]).toEqual(["project", "project", "project"]);
    expect(examiner).toBe(worker);
    // No DOCKER_HOST of the engine's: the wrapper gives the user its own socket.
    expect(worker.env).toEqual({ ...projectEnv, CODEX_HOME: join(root, "CODEX_HOME") });
  });

  it("grants by chown to the project user and kills as it", async () => {
    const ran: string[][] = [];
    const runAs = createProjectUser({
      user: PROJECT_USER,
      exec: async (file, args) => void ran.push([file, ...args]),
    })({ agentId: "agent_1", role: "worker" });
    expect(runAs.env).toBeUndefined();
    await runAs.grant("/tmp/cfg");
    runAs.kill?.(123, "SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ran).toEqual([
      ["chown", "-R", `project:${WORKER_GROUP}`, "/tmp/cfg"],
      ["sudo", "-u", "project", "kill", "-SIGTERM", "--", "-123"],
    ]);
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
