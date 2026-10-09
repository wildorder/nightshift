import { describe, expect, it } from "vitest";
import {
  DispatchFailureCodeSchema,
  DispatchInputSchema,
  DispatchToolchainSchema,
  HeartbeatBodySchema,
  isExactRuntimeVersion,
  ReferenceAuditSchema,
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

describe("a dispatch carries the laptop's reference audit (P16 D-06)", () => {
  const reference = {
    base: input.baseSha,
    node: "22.22.0",
    auditedAt: "2026-10-09T12:00:00.000Z",
    gates: [
      { id: "setup:install", kind: "setup", verdict: "passed" },
      {
        id: "build",
        kind: "check",
        verdict: "failed",
        outputArtifactId: "art_01M4AAAAAAAAAAAAAAAAAAAAAA",
      },
      { id: "e2e", kind: "check", verdict: "waiting" },
      { id: "cloud", kind: "check", verdict: "deferred" },
      { id: "lint", kind: "check", verdict: "unrun" },
    ],
  };

  it("parses a reference with every verdict, and keeps it unchanged", () => {
    const parsed = DispatchInputSchema.parse({ ...input, reference });
    expect(parsed.reference).toEqual(reference);
  });

  it("refuses a reference of another base than the one dispatched", () => {
    const result = DispatchInputSchema.safeParse({
      ...input,
      reference: { ...reference, base: "c".repeat(40) },
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["reference", "base"]);
  });

  it("still parses an input from before the reference", () => {
    expect(DispatchInputSchema.parse(input).reference).toBeUndefined();
  });

  it("takes node as exact, without the v, and lets it be absent", () => {
    expect(ReferenceAuditSchema.safeParse({ ...reference, node: "22" }).success).toBe(false);
    expect(ReferenceAuditSchema.safeParse({ ...reference, node: "v22.22.0" }).success).toBe(false);
    const { node: _node, ...without } = reference;
    expect(ReferenceAuditSchema.safeParse(without).success).toBe(true);
  });

  it("refuses an unknown verdict, and an output artifact on a gate that did not fail", () => {
    const gates = (gate: object) => ({ ...reference, gates: [gate] });
    expect(
      ReferenceAuditSchema.safeParse(gates({ id: "a", kind: "check", verdict: "skipped" })).success,
    ).toBe(false);
    expect(
      ReferenceAuditSchema.safeParse(
        gates({
          id: "a",
          kind: "check",
          verdict: "passed",
          outputArtifactId: "art_01M4AAAAAAAAAAAAAAAAAAAAAA",
        }),
      ).success,
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
