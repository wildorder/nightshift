/** A worker's token file: the engine's to write, first and at every renewal; the worker's to read. */
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentId } from "@nightshift/contracts";
import type { RunScope } from "@nightshift/core";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkerTokenFiles, workerTokenFile } from "./worker-token-files.js";

const scope = {
  orgId: "org_1",
  projectId: "proj_1",
  programId: "prog_1",
  runId: "run_1",
} as unknown as RunScope;
const agent = "agent_1" as AgentId;

let root = "";
afterEach(async () => {
  if (root !== "") await rm(root, { recursive: true, force: true });
  root = "";
});

const files = async () => {
  root = await mkdtemp(join(tmpdir(), "nightshift-tokens-"));
  const grouped: string[] = [];
  const directory = (runId: string) => join(root, runId);
  return {
    directory,
    grouped,
    files: createWorkerTokenFiles({
      group: "nightshift",
      chgrp: async (group, path) => {
        grouped.push(`${group} ${path}`);
      },
      tokenDirectory: directory,
    }),
  };
};

const mode = async (path: string): Promise<number> => (await stat(path)).mode & 0o7777;

describe("a worker's token file", () => {
  it("is written by the engine where the worker can read it, and renewed in place", async () => {
    const { files: tokens, directory, grouped } = await files();
    const path = await tokens.place(scope, agent, "first");
    expect(path).toBe(workerTokenFile("run_1", "agent_1", directory));
    expect(await readFile(path, "utf8")).toBe("first\n");
    expect(await mode(path)).toBe(0o640);
    expect(await mode(join(directory("run_1"), "agents", agent))).toBe(0o710);
    expect(await mode(join(directory("run_1"), "agents"))).toBe(0o2711);
    expect(await mode(directory("run_1"))).toBe(0o711);
    expect(grouped).toEqual([`nightshift ${join(directory("run_1"), "agents")}`]);

    // The renewal: the same process writes the same file again, and nothing is
    // left beside it.
    await tokens.place(scope, agent, "second");
    expect(await readFile(path, "utf8")).toBe("second\n");
    expect(await readdir(join(directory("run_1"), "agents", agent))).toEqual(["token"]);
  });

  it("goes with the worker, and is not missed twice", async () => {
    const { files: tokens, directory } = await files();
    await tokens.place(scope, agent, "t");
    await tokens.remove(scope, agent);
    expect(existsSync(join(directory("run_1"), "agents", agent))).toBe(false);
    await expect(tokens.remove(scope, agent)).resolves.toBeUndefined();
  });
});
