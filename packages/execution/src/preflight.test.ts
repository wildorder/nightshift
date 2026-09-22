/**
 * Preflight over real subprocesses (SC-P7-05). The commands are `node -e`, so
 * they mean the same thing on the Windows and Linux CI legs.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Prerequisite, ProgramContract } from "@nightshift/contracts";
import { createFixtures, makeProgramContract } from "@nightshift/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runPreflight } from "./preflight.js";

const prerequisite = (id: string, verifyCommand: string, status = "pending"): Prerequisite => ({
  id,
  description: `${id} is done.`,
  remediation: `Do ${id}.`,
  verifyCommand,
  status: status as Prerequisite["status"],
  ...(status === "satisfied"
    ? { lastCheck: { exitCode: 0, checkedAt: "2026-09-21T00:00:00.000Z" } }
    : {}),
});

let cwd: string;
let recorded: [string, number][];

const record = async (_scope: unknown, id: string, exitCode: number): Promise<Prerequisite> => {
  recorded.push([id, exitCode]);
  // What the control plane does: the status follows from the exit code.
  return prerequisite(id, "recorded", exitCode === 0 ? "satisfied" : "pending");
};

const contractWith = (prerequisites: Prerequisite[]): ProgramContract =>
  makeProgramContract(createFixtures(), { prerequisites });

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "nightshift-preflight-"));
  recorded = [];
});

afterEach(async () => {
  // On Windows a killed process tree can hold the directory for a moment.
  await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe("runPreflight (D-P7-05)", () => {
  it("runs every pending verifyCommand in the repository and records each exit code", async () => {
    await writeFile(join(cwd, "token"), "present");
    const result = await runPreflight({
      contract: contractWith([
        prerequisite("HP-01", `node -e "require('fs').accessSync('token')"`),
        prerequisite("HP-02", `node -e "process.exit(3)"`),
        prerequisite("HP-03", `node -e "console.log('checked'); process.exit(0)"`),
      ]),
      cwd,
      record,
    });

    expect(recorded).toEqual([
      ["HP-01", 0],
      ["HP-02", 3],
      ["HP-03", 0],
    ]);
    // One failure does not stop the rest: the human fixes everything in one sitting.
    expect(result.pending.map((p) => p.id)).toEqual(["HP-02"]);
    expect(result.checks[2]?.output).toContain("checked");
  });

  it("does not run what is already satisfied unless asked to recheck", async () => {
    const contract = contractWith([
      prerequisite("HP-01", `node -e "process.exit(1)"`, "satisfied"),
      prerequisite("HP-02", `node -e "process.exit(0)"`),
    ]);
    const first = await runPreflight({ contract, cwd, record });
    expect(recorded).toEqual([["HP-02", 0]]);
    expect(first.skipped.map((p) => p.id)).toEqual(["HP-01"]);
    expect(first.pending).toEqual([]);

    recorded = [];
    const again = await runPreflight({ contract, cwd, record, recheck: true });
    // Satisfied is what the last check said: a revoked credential stops counting.
    expect(recorded).toEqual([
      ["HP-01", 1],
      ["HP-02", 0],
    ]);
    expect(again.pending.map((p) => p.id)).toEqual(["HP-01"]);
  });

  it("checks only what it is asked to, for a run that needs its first strands' alone", async () => {
    const contract = contractWith([
      prerequisite("HP-01", `node -e "process.exit(0)"`),
      prerequisite("HP-02", `node -e "process.exit(1)"`),
    ]);
    const result = await runPreflight({ contract, cwd, record, only: ["HP-01"] });
    expect(recorded).toEqual([["HP-01", 0]]);
    expect(result.pending).toEqual([]);
  });

  it("does not hand the command the caller's environment", async () => {
    process.env.NIGHTSHIFT_PREFLIGHT_SECRET = "leaky";
    try {
      await runPreflight({
        contract: contractWith([
          prerequisite(
            "HP-01",
            `node -e "process.exit(process.env.NIGHTSHIFT_PREFLIGHT_SECRET ? 1 : 0)"`,
          ),
        ]),
        cwd,
        record,
      });
    } finally {
      delete process.env.NIGHTSHIFT_PREFLIGHT_SECRET;
    }
    expect(recorded).toEqual([["HP-01", 0]]);
  });

  it("ends a command that never returns, as a failure", async () => {
    const result = await runPreflight({
      contract: contractWith([prerequisite("HP-01", `node -e "setInterval(() => {}, 1000)"`)]),
      cwd,
      record,
      timeoutMs: 500,
    });
    expect(result.checks[0]?.timedOut).toBe(true);
    expect(result.pending.map((p) => p.id)).toEqual(["HP-01"]);
  });
});
