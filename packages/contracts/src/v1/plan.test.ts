/**
 * Where a prerequisite check ran (P16, D-08): the laptop's and the machines'
 * are recorded apart, and a record written before P16 reads as the laptop's.
 */
import { describe, expect, it } from "vitest";
import { PrerequisiteWriteBodySchema } from "./api.js";
import { MAX_MACHINE_CHECKS, PrerequisiteSchema } from "./plan.js";

const RUN = "run_01M4FQ2A0RVJBX1N6EAAYM96MV";
const AT = "2026-10-09T00:00:00.000Z";

const base = {
  id: "HP-01",
  description: "Docker is running.",
  remediation: "Start Docker.",
  verifyCommand: "docker info",
};

const machineCheck = (overrides: Record<string, unknown> = {}) => ({
  where: "machine",
  runId: RUN,
  generation: 1,
  exitCode: 0,
  checkedAt: AT,
  ...overrides,
});

describe("PrerequisiteSchema", () => {
  it("reads a record written before P16, with no where, as it was: the laptop's", () => {
    const old = { ...base, status: "satisfied", lastCheck: { exitCode: 0, checkedAt: AT } };
    const parsed = PrerequisiteSchema.parse(old);
    expect(parsed).toEqual(old);
    expect(parsed.lastCheck?.where).toBeUndefined();
    expect(parsed.machineChecks).toBeUndefined();
  });

  it("reads a laptop check that says where it ran, and machine checks beside it", () => {
    const parsed = PrerequisiteSchema.parse({
      ...base,
      status: "satisfied",
      lastCheck: { exitCode: 0, checkedAt: AT, where: "laptop" },
      machineChecks: [machineCheck({ exitCode: 1 })],
    });
    expect(parsed.lastCheck?.where).toBe("laptop");
    expect(parsed.machineChecks).toEqual([machineCheck({ exitCode: 1 })]);
  });

  it("keeps the laptop's lastCheck the laptop's, and each machine check tied to its dispatch", () => {
    expect(
      PrerequisiteSchema.safeParse({
        ...base,
        status: "pending",
        lastCheck: { exitCode: 0, checkedAt: AT, where: "machine" },
      }).success,
    ).toBe(false);
    for (const broken of [
      machineCheck({ where: "laptop" }),
      machineCheck({ runId: undefined }),
      machineCheck({ generation: 0 }),
    ]) {
      expect(
        PrerequisiteSchema.safeParse({ ...base, status: "pending", machineChecks: [broken] })
          .success,
        JSON.stringify(broken),
      ).toBe(false);
    }
  });

  it("bounds the machine checks it keeps", () => {
    const many = Array.from({ length: MAX_MACHINE_CHECKS + 1 }, () => machineCheck());
    expect(
      PrerequisiteSchema.safeParse({ ...base, status: "pending", machineChecks: many }).success,
    ).toBe(false);
  });
});

describe("PrerequisiteWriteBodySchema", () => {
  it("takes a check that says nowhere, as every check before P16 was: the laptop's", () => {
    expect(PrerequisiteWriteBodySchema.parse({ kind: "check", exitCode: 0 })).toEqual({
      kind: "check",
      exitCode: 0,
    });
    expect(
      PrerequisiteWriteBodySchema.parse({ kind: "check", exitCode: 1, where: "laptop" }),
    ).toEqual({ kind: "check", exitCode: 1, where: "laptop" });
  });

  it("takes a machine check with the dispatch it ran under, and only with one", () => {
    const body = {
      kind: "check",
      exitCode: 0,
      where: "machine",
      dispatch: { runId: RUN, generation: 2 },
    };
    expect(PrerequisiteWriteBodySchema.parse(body)).toEqual(body);
    expect(
      PrerequisiteWriteBodySchema.safeParse({ kind: "check", exitCode: 0, where: "machine" })
        .success,
    ).toBe(false);
    expect(
      PrerequisiteWriteBodySchema.safeParse({
        kind: "check",
        exitCode: 0,
        dispatch: { runId: RUN, generation: 1 },
      }).success,
    ).toBe(false);
    expect(PrerequisiteWriteBodySchema.safeParse({ ...body, where: "somewhere" }).success).toBe(
      false,
    );
  });
});
