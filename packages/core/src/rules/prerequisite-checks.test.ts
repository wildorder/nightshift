import {
  MAX_MACHINE_CHECKS,
  type Prerequisite,
  PrerequisiteSchema,
  RunIdSchema,
} from "@nightshift/contracts";
import { describe, expect, it } from "vitest";
import {
  isMetAt,
  machineCheckOf,
  unmetPrerequisitesAt,
  withLaptopCheck,
  withMachineCheck,
} from "./prerequisite-checks.js";

const RUN = RunIdSchema.parse("run_01M4FQ2A0RVJBX1N6EAAYM96MV");
const OTHER_RUN = RunIdSchema.parse("run_01M4FQ2A0RVJBX1N6EAAYM96MW");
const AT = "2026-10-09T00:00:00.000Z";

const docker = (overrides: Partial<Prerequisite> = {}): Prerequisite =>
  PrerequisiteSchema.parse({
    id: "HP-01",
    description: "Docker is running",
    remediation: "Start Docker",
    verifyCommand: "docker info",
    status: "pending",
    ...overrides,
  });

const laptopSatisfied = (): Prerequisite =>
  withLaptopCheck(docker(), { exitCode: 0, checkedAt: AT });

describe("where a prerequisite is met (P16, D-08)", () => {
  it("is met on the laptop by the laptop's check, as before", () => {
    expect(isMetAt(laptopSatisfied(), { where: "laptop" })).toBe(true);
    expect(isMetAt(docker(), { where: "laptop" })).toBe(false);
  });

  it("is never met on a machine by the laptop's check", () => {
    const site = { where: "machine" as const, dispatch: { runId: RUN, generation: 1 } };
    expect(unmetPrerequisitesAt([laptopSatisfied()], site)).toEqual(new Set(["HP-01"]));
  });

  it("is met on a machine only by this dispatch's own check, exited zero", () => {
    const passed = withMachineCheck(docker(), {
      runId: RUN,
      generation: 1,
      exitCode: 0,
      checkedAt: AT,
    });
    expect(isMetAt(passed, { where: "machine", dispatch: { runId: RUN, generation: 1 } })).toBe(
      true,
    );
    // Another run's machine, or another generation of this one, is no evidence.
    expect(
      isMetAt(passed, { where: "machine", dispatch: { runId: OTHER_RUN, generation: 1 } }),
    ).toBe(false);
    expect(isMetAt(passed, { where: "machine", dispatch: { runId: RUN, generation: 2 } })).toBe(
      false,
    );
    // And a machine's pass says nothing of the laptop.
    expect(isMetAt(passed, { where: "laptop" })).toBe(false);

    const failed = withMachineCheck(laptopSatisfied(), {
      runId: RUN,
      generation: 1,
      exitCode: 1,
      checkedAt: AT,
    });
    expect(
      unmetPrerequisitesAt([failed], { where: "machine", dispatch: { runId: RUN, generation: 1 } }),
    ).toEqual(new Set(["HP-01"]));
    expect(unmetPrerequisitesAt([failed], { where: "laptop" })).toEqual(new Set());
  });
});

describe("applying a check", () => {
  it("a machine check leaves the laptop's status and lastCheck exactly as they were", () => {
    const before = laptopSatisfied();
    const after = withMachineCheck(before, {
      runId: RUN,
      generation: 1,
      exitCode: 1,
      checkedAt: AT,
    });
    expect(after.status).toBe("satisfied");
    expect(after.lastCheck).toEqual(before.lastCheck);
    expect(PrerequisiteSchema.parse(after)).toEqual(after);
  });

  it("a laptop check leaves the machines' checks exactly as they were", () => {
    const machine = withMachineCheck(docker(), {
      runId: RUN,
      generation: 1,
      exitCode: 0,
      checkedAt: AT,
    });
    const after = withLaptopCheck(machine, { exitCode: 1, checkedAt: AT });
    expect(after.status).toBe("pending");
    expect(after.lastCheck).toEqual({ exitCode: 1, checkedAt: AT, where: "laptop" });
    expect(after.machineChecks).toEqual(machine.machineChecks);
  });

  it("keeps the latest check per run, and a bounded number of runs", () => {
    let prerequisite = withMachineCheck(docker(), {
      runId: RUN,
      generation: 1,
      exitCode: 1,
      checkedAt: AT,
    });
    prerequisite = withMachineCheck(prerequisite, {
      runId: RUN,
      generation: 2,
      exitCode: 0,
      checkedAt: "2026-10-09T01:00:00.000Z",
    });
    expect(prerequisite.machineChecks).toHaveLength(1);
    expect(machineCheckOf(prerequisite, { runId: RUN, generation: 2 })?.exitCode).toBe(0);

    for (let index = 0; index < MAX_MACHINE_CHECKS + 5; index += 1) {
      const suffix = String(index).padStart(4, "0");
      prerequisite = withMachineCheck(prerequisite, {
        runId: RunIdSchema.parse(`run_01M4FQ2A0RVJBX1N6EAAYM${suffix}`),
        generation: 1,
        exitCode: 0,
        checkedAt: `2026-10-10T00:00:${String(index).padStart(2, "0")}.000Z`,
      });
    }
    expect(prerequisite.machineChecks).toHaveLength(MAX_MACHINE_CHECKS);
    // The oldest went first: the first run's is gone.
    expect(machineCheckOf(prerequisite, { runId: RUN, generation: 2 })).toBeUndefined();
    expect(PrerequisiteSchema.parse(prerequisite)).toEqual(prerequisite);
  });
});
