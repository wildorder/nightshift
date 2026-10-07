import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { rerunFailedChecks, rerunnableChecks } from "./rerun.js";
import type { StepResult } from "./run.js";

/** `node -e` with no double quote inside, so it survives `sh -c` and `cmd /c` alike. */
const nodeCommand = (script: string): string => `"${process.execPath}" -e "${script}"`;

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
const scratch = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "ns-rerun-"));
  dirs.push(dir);
  return dir;
};

const result = (stepId: string, exitCode: number, output = ""): StepResult => ({
  stepId,
  command: stepId,
  exitCode,
  durationMs: 1,
  output: new TextEncoder().encode(output),
  timedOut: false,
});

/** Fails the first time it runs in a directory, passes after: a counter file in the cwd. */
const flaky = nodeCommand(
  "const fs=require('fs');if(fs.existsSync('ran')){process.exit(0)}fs.writeFileSync('ran','1');process.exit(3)",
);

describe("rerunnableChecks", () => {
  it("takes the failures and leaves passes and declared deferrals alone", () => {
    const picked = rerunnableChecks([
      result("passes", 0),
      result("fails", 1),
      result("declares", 75, "NIGHTSHIFT_DEFER HP-01 a key nobody has\n"),
      result("exits-75", 75, "no declaration\n"),
    ]);
    expect(picked.map((r) => r.stepId)).toEqual(["fails", "exits-75"]);
  });
});

describe("rerunFailedChecks", () => {
  it("runs nothing when nothing failed", async () => {
    const reruns = await rerunFailedChecks({
      steps: [{ id: "ok", command: nodeCommand("process.exit(9)") }],
      first: [result("ok", 0)],
      cwd: await scratch(),
      timeoutMs: 30_000,
    });
    expect(reruns).toEqual([]);
  });

  it("runs each failed check once more, and only those", async () => {
    const cwd = await scratch();
    const reruns = await rerunFailedChecks({
      steps: [
        { id: "flaky", command: flaky },
        { id: "broken", command: nodeCommand("process.exit(2)") },
        { id: "ok", command: nodeCommand("process.exit(9)") },
      ],
      // `flaky` already ran once here and wrote its counter.
      first: [result("flaky", 3), result("broken", 2), result("ok", 0)],
      cwd,
      timeoutMs: 30_000,
    });
    // The counter is missing, so this rerun is its "first" run: it fails.
    expect(reruns.map((r) => [r.rerun.stepId, r.first.exitCode, r.rerun.exitCode])).toEqual([
      ["flaky", 3, 3],
      ["broken", 2, 2],
    ]);
    const again = await rerunFailedChecks({
      steps: [{ id: "flaky", command: flaky }],
      first: [result("flaky", 3)],
      cwd,
      timeoutMs: 30_000,
    });
    expect(again.map((r) => r.rerun.exitCode)).toEqual([0]);
  });
});
