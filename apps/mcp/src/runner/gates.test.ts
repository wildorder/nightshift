/**
 * A replacement machine checks the prerequisites for itself (2026-10-16): a
 * prerequisite is met where the work runs, by this generation's own check, and
 * without one every check that needs it would defer on the new machine. The
 * gate audit is the first machine's alone.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CheckDispatch, ProgramContract } from "@nightshift/contracts";
import { systemClock } from "@nightshift/core";
import { afterEach, describe, expect, it } from "vitest";
import { auditOnMachine, type MachineAuditContext, type MachineAuditRuntime } from "./gates.js";

const made: string[] = [];
afterEach(async () => {
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
});

const program = {
  programId: "prog_1",
  projectId: "proj_1",
  verification: [{ id: "check", command: 'node -e "process.exit(0)"', requires: ["HP-01"] }],
  prerequisites: [
    {
      id: "HP-01",
      description: "Docker is reachable.",
      remediation: "Start Docker.",
      verifyCommand: 'node -e "process.exit(0)"',
      status: "pending",
    },
  ],
} as unknown as ProgramContract;

describe("a replacement machine (generation 2)", () => {
  it("checks every prerequisite on itself and records it under its own generation, and skips the gate audit", async () => {
    const checkout = await mkdtemp(join(tmpdir(), "nightshift-machine-"));
    made.push(checkout);
    const recorded: { id: string; exitCode: number; dispatch: CheckDispatch }[] = [];
    const runtime = {
      clock: systemClock,
      prerequisites: {
        recordMachineCheck: async (
          _scope: unknown,
          id: string,
          exitCode: number,
          dispatch: CheckDispatch,
        ) => {
          recorded.push({ id, exitCode, dispatch });
          return {
            ...program.prerequisites?.[0],
            machineChecks: [
              { where: "machine", ...dispatch, exitCode, checkedAt: new Date().toISOString() },
            ],
          };
        },
      },
    } as unknown as MachineAuditRuntime;
    const progress: unknown[] = [];
    const context = {
      scope: { projectId: "proj_1", programId: "prog_1", runId: "run_1" },
      layout: { checkout, run: checkout, root: checkout },
      projectEnv: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      program,
      dispatch: {
        generation: 2,
        engineAgentId: "agent_engine",
        input: { baseSha: "a".repeat(40), toolchain: {} },
      },
      onProgress: (event: unknown) => progress.push(event),
    } as unknown as MachineAuditContext;

    const result = await auditOnMachine(runtime, context, () => undefined);

    expect(recorded).toEqual([
      { id: "HP-01", exitCode: 0, dispatch: { runId: "run_1", generation: 2 } },
    ]);
    expect(result.audit).toBeUndefined();
    expect(progress).toContainEqual(
      expect.objectContaining({ stage: "audit", verdict: "skipped" }),
    );
  }, 60_000);
});
