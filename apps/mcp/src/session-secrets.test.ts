import { createFixtures, makeProgramContract, makeRun } from "@nightshift/core";
import { describe, expect, it } from "vitest";
import type { Runtime } from "./compose.js";
import { buildEnvironment } from "./session.js";

describe("the run's environment and the project's secrets (A-62)", () => {
  it("holds the declared secrets this engine has, and redacts them from what it sends from then on", () => {
    const f = createFixtures();
    const redacted: Record<string, string>[] = [];
    const runtime = {
      secretsFrom: { NPM_TOKEN: "ghp_engine_held_value", UNDECLARED: "kept out" },
      redactFromNowOn: (secrets: Record<string, string>) => void redacted.push(secrets),
      workerLaunch: () => ({ name: "nightshift", command: "node", args: [], env: {} }),
    } as unknown as Runtime;
    const environment = buildEnvironment(runtime, {} as never, makeRun(f), {
      ...makeProgramContract(f),
      secrets: ["NPM_TOKEN", "NOT_HELD"],
    });
    expect(environment.secretEnv).toEqual({ NPM_TOKEN: "ghp_engine_held_value" });
    expect(redacted).toEqual([{ NPM_TOKEN: "ghp_engine_held_value" }]);
  });

  it("holds none for a program that declares none", () => {
    const f = createFixtures();
    const runtime = {
      secretsFrom: { NPM_TOKEN: "ghp_engine_held_value" },
      workerLaunch: () => ({ name: "nightshift", command: "node", args: [], env: {} }),
    } as unknown as Runtime;
    const environment = buildEnvironment(runtime, {} as never, makeRun(f), makeProgramContract(f));
    expect(environment.secretEnv).toEqual({});
  });
});
