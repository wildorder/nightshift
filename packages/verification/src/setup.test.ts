import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCheckoutSteps, runSetupSteps, setupAsStep } from "./setup.js";

/** `node -e` with no double quote inside, so it survives `sh -c` and `cmd /c` alike. */
const nodeCommand = (script: string): string => `"${process.execPath}" -e "${script}"`;
const exitWith = (code: number): string => nodeCommand(`process.exit(${code})`);

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
const scratch = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "ns-setup-"));
  dirs.push(dir);
  return dir;
};

describe("setup", () => {
  it("is recorded under a prefixed id, so it cannot collide with a check", () => {
    expect(setupAsStep({ id: "install", command: "npm ci" })).toEqual({
      id: "setup:install",
      command: "npm ci",
    });
  });

  it("stops at the first step that fails", async () => {
    const results = await runSetupSteps({
      setup: [
        { id: "one", command: exitWith(0) },
        { id: "two", command: exitWith(3) },
        { id: "three", command: exitWith(0) },
      ],
      cwd: await scratch(),
      timeoutMs: 30_000,
    });
    expect(results.map((result) => [result.stepId, result.exitCode])).toEqual([
      ["setup:one", 0],
      ["setup:two", 3],
    ]);
  });

  it("runs no check when setup fails", async () => {
    const ran = await runCheckoutSteps({
      setup: [{ id: "install", command: exitWith(1) }],
      steps: [{ id: "test", command: exitWith(0) }],
      cwd: await scratch(),
      timeoutMs: 30_000,
    });
    expect(ran.setupFailed).toBe(true);
    expect(ran.checks).toEqual([]);
  });

  it("runs the checks in the directory setup prepared", async () => {
    const ran = await runCheckoutSteps({
      setup: [{ id: "install", command: nodeCommand("require('fs').writeFileSync('ready','ok')") }],
      steps: [
        {
          id: "ready",
          command: nodeCommand("process.exit(require('fs').existsSync('ready') ? 0 : 1)"),
        },
      ],
      cwd: await scratch(),
      timeoutMs: 30_000,
    });
    expect(ran.setupFailed).toBe(false);
    expect(ran.checks.map((result) => [result.stepId, result.exitCode])).toEqual([["ready", 0]]);
  });

  it("with no setup, is exactly the checks", async () => {
    const ran = await runCheckoutSteps({
      setup: [],
      steps: [{ id: "test", command: exitWith(0) }],
      cwd: await scratch(),
      timeoutMs: 30_000,
    });
    expect(ran.setup).toEqual([]);
    expect(ran.checks.map((result) => result.exitCode)).toEqual([0]);
  });
});
