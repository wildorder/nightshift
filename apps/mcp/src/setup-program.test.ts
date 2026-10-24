import { createFixtures, makeProgramContract } from "@nightshift/core";
import type { GitRunner } from "@nightshift/execution";
import { createInMemoryStores } from "@nightshift/persistence/memory";
import { describe, expect, it } from "vitest";
import { projectSetupProgram } from "./compose.js";

describe("setup commands after a committed repository repair", () => {
  const f = createFixtures();
  const original = makeProgramContract(f, { setup: [{ id: "deps", command: "broken-install" }] });
  const fixed = [{ id: "deps", command: "fixed-install" }];
  const config = {
    schemaVersion: 1,
    projectId: original.projectId,
    contextDocs: [],
    setup: fixed,
    verification: original.verification,
    modelPolicy: original.modelPolicy,
    delegationLimits: original.delegationLimits,
    costPolicy: original.costPolicy,
  };
  const runner = (changed: boolean): GitRunner => {
    const before = { ...config, setup: original.setup };
    const files: Record<string, string> = {
      "HEAD:nightshift.config.json": JSON.stringify(config),
      "HEAD^:nightshift.config.json": JSON.stringify(changed ? before : config),
    };
    return async (args) => {
      const text = files[args[1] ?? ""];
      return { exitCode: text === undefined ? 1 : 0, stdout: text ?? "", stderr: "" };
    };
  };

  it("uses the repaired config when the landing changed the config setup", async () => {
    const result = await projectSetupProgram(
      createInMemoryStores(),
      f.scope,
      original,
      "/repo",
      runner(true),
    );
    expect(result.setup).toEqual(fixed);
    expect(result.verification).toBe(original.verification);
    expect(result.scope).toBe(original.scope);
    expect(original.setup?.[0]?.command).toBe("broken-install");
  });

  it("keeps the plane contract setup when the landing left the config alone", async () => {
    const result = await projectSetupProgram(
      createInMemoryStores(),
      f.scope,
      original,
      "/repo",
      runner(false),
    );
    expect(result.setup).toEqual(original.setup);
  });
});
