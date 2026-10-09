import { describe, expect, it } from "vitest";
import {
  DispatchFailureCodeSchema,
  DispatchInputSchema,
  DispatchToolchainSchema,
  HeartbeatBodySchema,
  isExactRuntimeVersion,
  RuntimeVersionSchema,
} from "./dispatch.js";

const input = {
  repositoryUrl: "https://github.com/acme/keki.git",
  branch: "nightshift/run",
  baseSha: "a".repeat(40),
  planHash: "sha256:plan",
};

const nodePin = (version: string) => ({
  runtime: "node",
  version,
  source: { kind: "pin", file: ".nvmrc", spec: "22" },
});

describe("the versions a dispatch carries are exact (P16 D-03)", () => {
  const table: readonly [string, string, boolean][] = [
    ["node", "22.22.0", true],
    ["node", "22", false],
    ["node", "22.22", false],
    ["node", "v22.22.0", false],
    ["node", ">=24 <25", false],
    ["python", "3.12.7", true],
    ["python", "3.13.0rc1", true],
    ["python", "3.12", false],
    ["ruby", "3.3.0", true],
    ["ruby", "3.4.0preview1", true],
    ["ruby", "3.3", false],
    ["go", "1.22.3", true],
    ["go", "1.22rc1", true],
    ["go", "1.20", true],
    ["go", "1.22", false],
    ["java", "21.0.2", true],
    ["java", "21", false],
    ["rust", "1.79.0", true],
    ["rust", "1.81.0-nightly", true],
    ["rust", "1.79", false],
    ["deno", "2.0.0", true],
    ["deno", "2", false],
  ];
  it.each(table)("%s %s → %s", (runtime, version, exact) => {
    expect(isExactRuntimeVersion(runtime, version)).toBe(exact);
    expect(
      RuntimeVersionSchema.safeParse({ runtime, version, source: { kind: "image" } }).success,
    ).toBe(exact);
  });

  it("refuses a partial measured Node version in a dispatch's input", () => {
    expect(DispatchInputSchema.safeParse({ ...input, toolchain: [nodePin("22")] }).success).toBe(
      false,
    );
    expect(
      DispatchInputSchema.safeParse({ ...input, toolchain: [nodePin("22.22.0")] }).success,
    ).toBe(true);
  });

  it("leaves the toolchain optional, so dispatches from before P16 still parse", () => {
    expect(DispatchInputSchema.safeParse(input).success).toBe(true);
  });

  it("carries each runtime once", () => {
    expect(
      DispatchToolchainSchema.safeParse([nodePin("22.22.0"), nodePin("22.22.1")]).success,
    ).toBe(false);
  });
});

describe("a heartbeat can say why the runner stopped (P16 SC-07, D-07)", () => {
  const beat = { generation: 1, meteredSeconds: 30, samples: [] };

  it("knows the runner's two failure codes", () => {
    expect(DispatchFailureCodeSchema.options).toContain("setup_failed");
    expect(DispatchFailureCodeSchema.options).toContain("environment_fault");
  });

  it("accepts stopped with a setup failure or an environment fault", () => {
    for (const code of ["setup_failed", "environment_fault"]) {
      const parsed = HeartbeatBodySchema.parse({
        ...beat,
        report: "stopped",
        failure: { code, message: "npm ci exited 1" },
      });
      expect(parsed.failure).toEqual({ code, message: "npm ci exited 1" });
    }
  });

  it("leaves the failure optional", () => {
    expect(HeartbeatBodySchema.parse({ ...beat, report: "stopped" }).failure).toBeUndefined();
  });

  it("refuses a code only the plane may write", () => {
    for (const code of ["cancelled", "run_cap", "wall_clock", "provisioning_failed"]) {
      expect(
        HeartbeatBodySchema.safeParse({
          ...beat,
          report: "stopped",
          failure: { code, message: "no" },
        }).success,
      ).toBe(false);
    }
  });

  it("refuses a failure without stopped, or without a message", () => {
    const failure = { code: "setup_failed", message: "clone failed" };
    expect(HeartbeatBodySchema.safeParse({ ...beat, failure }).success).toBe(false);
    expect(HeartbeatBodySchema.safeParse({ ...beat, report: "ready", failure }).success).toBe(
      false,
    );
    expect(
      HeartbeatBodySchema.safeParse({
        ...beat,
        report: "stopped",
        failure: { code: "setup_failed", message: "" },
      }).success,
    ).toBe(false);
  });
});
