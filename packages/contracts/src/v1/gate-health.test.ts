import { describe, expect, it } from "vitest";
import { AGGREGATE_EXAMPLES } from "./examples.js";
import { type GateHealth, GateHealthSchema, RepositoryPathSchema } from "./gate-health.js";

const example = (): GateHealth => structuredClone(AGGREGATE_EXAMPLES.GateHealth) as GateHealth;
const [finding] = example().findings;
if (finding === undefined) throw new Error("the GateHealth example has a finding");

const withMachinery = (path: string): GateHealth => ({ ...example(), machinery: [path] });
const withFindingPath = (path: string): GateHealth => ({
  ...example(),
  findings: [{ ...finding, paths: [path] }],
});

// F-01: every one of these resolves outside `C:\repo` (or names something other
// than a plain file in it) under `path.win32` or `path.posix`.
const OUTSIDE_OR_NON_CANONICAL = [
  "..\\outside\\gate.mjs",
  "\\Windows\\gate.mjs",
  "\\\\server\\share\\gate.mjs",
  "scripts\\gate.mjs",
  "C:\\Windows\\gate.mjs",
  "C:gate.mjs",
  "c:/Windows/gate.mjs",
  "//server/share/gate.mjs",
  "/etc/gate.mjs",
  "../outside/gate.mjs",
  "scripts/../../gate.mjs",
  "./gate.mjs",
  "scripts//gate.mjs",
  "scripts/",
  "gate.mjs:stream",
  "",
];

describe("GateHealth", () => {
  it("accepts the example", () => {
    expect(GateHealthSchema.parse(example())).toEqual(example());
  });

  it("accepts a healthy verdict with no findings", () => {
    expect(
      GateHealthSchema.safeParse({ ...example(), verdict: "healthy", findings: [] }).success,
    ).toBe(true);
  });

  it("refuses a healthy verdict with findings", () => {
    expect(GateHealthSchema.safeParse({ ...example(), verdict: "healthy" }).success).toBe(false);
  });

  it("accepts a finding against rule 8, declares its runtimes (P16 SC-08)", () => {
    const runtimes = { ...finding, rule: 8, found: "package.json uses node and nothing pins it" };
    expect(GateHealthSchema.safeParse({ ...example(), findings: [runtimes] }).success).toBe(true);
  });

  it("refuses an unknown verdict", () => {
    expect(GateHealthSchema.safeParse({ ...example(), verdict: "broken" }).success).toBe(false);
  });

  it("refuses duplicate finding ids and duplicate machinery", () => {
    expect(GateHealthSchema.safeParse({ ...example(), findings: [finding, finding] }).success).toBe(
      false,
    );
    expect(
      GateHealthSchema.safeParse({ ...example(), machinery: ["package.json", "package.json"] })
        .success,
    ).toBe(false);
  });

  it("refuses a malformed finding", () => {
    for (const bad of [
      { ...finding, id: "F-1" },
      { ...finding, id: "f-01" },
      { ...finding, rule: 0 },
      { ...finding, rule: 9 },
      { ...finding, rule: 1.5 },
      { ...finding, found: "" },
      { ...finding, decisionId: "" },
      { ...finding, extra: true },
    ]) {
      expect(
        GateHealthSchema.safeParse({ ...example(), findings: [bad] }).success,
        JSON.stringify(bad),
      ).toBe(false);
    }
  });

  it("refuses a malformed commit or fingerprint", () => {
    expect(GateHealthSchema.safeParse({ ...example(), commit: "abc" }).success).toBe(false);
    expect(GateHealthSchema.safeParse({ ...example(), fingerprint: "A".repeat(64) }).success).toBe(
      false,
    );
  });

  it("accepts an engine as the auditor", () => {
    const record = {
      ...example(),
      auditedBy: {
        kind: "execution",
        projectId: example().projectId,
        programId: example().programId,
        runId: "run_01HF7YAT00GGGGGGGGGGGGGGGG",
        nodeId: "node_01HF7YAT00GGGGGGGGGGGGGGGG",
        agentId: "agent_01HF7YAT00GGGGGGGGGGGGGGGG",
        role: "engine",
        generation: 1,
      },
    };
    expect(GateHealthSchema.safeParse(record).success).toBe(true);
  });

  describe.each(OUTSIDE_OR_NON_CANONICAL)("the path %j", (path) => {
    it("is refused as machinery", () => {
      expect(GateHealthSchema.safeParse(withMachinery(path)).success).toBe(false);
    });

    it("is refused as a finding's path", () => {
      expect(GateHealthSchema.safeParse(withFindingPath(path)).success).toBe(false);
    });
  });

  it("accepts plain repository-relative paths", () => {
    for (const path of [
      "package.json",
      "scripts/check.mjs",
      ".github/workflows/ci.yml",
      "a..b/c",
    ]) {
      expect(RepositoryPathSchema.safeParse(path).success, path).toBe(true);
    }
  });
});
