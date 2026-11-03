import { describe, expect, it } from "vitest";
import { programsDirectoryOf } from "./common.js";
import { inheritFromConfig, type NightshiftConfig, NightshiftConfigSchema } from "./config.js";

const config: NightshiftConfig = NightshiftConfigSchema.parse({
  schemaVersion: 1,
  projectId: "proj_01J0000000000000000000000A",
  contextDocs: ["docs/architecture.md"],
  verification: [{ id: "test", command: "npm test" }],
  modelPolicy: { allowedProviders: ["anthropic"], allowedModels: [], forbiddenModels: [] },
  delegationLimits: { maxDepth: 3, maxConcurrency: 4 },
  costPolicy: {},
});

describe("nightshift.config.json (D-P7-03)", () => {
  it("supplies what a contract does not state, and nothing it does", () => {
    const merged = inheritFromConfig(
      { objective: "x", verification: [{ id: "lint", command: "npm run lint" }] },
      config,
    ) as Record<string, unknown>;
    expect(merged.verification).toEqual([{ id: "lint", command: "npm run lint" }]);
    expect(merged.projectId).toBe(config.projectId);
    expect(merged.delegationLimits).toEqual(config.delegationLimits);
    // Absent from both: left for the contract's schema to refuse.
    expect("examinationPolicy" in merged).toBe(false);
  });

  it("leaves anything that is not an object for the contract schema to refuse", () => {
    expect(inheritFromConfig([], config)).toEqual([]);
    expect(inheritFromConfig(null, config)).toBeNull();
  });

  it("hands its programs directory to every contract, docs/programs when it names none", () => {
    expect(programsDirectoryOf(inheritFromConfig({}, config) as object)).toBe("docs/programs");
    const planning = NightshiftConfigSchema.parse({
      ...config,
      programsDirectory: "planning/runs",
    });
    const merged = inheritFromConfig({}, planning) as { programsDirectory?: string };
    expect(merged.programsDirectory).toBe("planning/runs");
    expect(programsDirectoryOf(merged)).toBe("planning/runs");
  });

  it("refuses a programs directory that is not plainly inside the repository", () => {
    for (const programsDirectory of [
      "",
      "/docs",
      "C:/docs",
      "docs/",
      "../docs",
      "docs/../x",
      ".git",
      "a\\b",
    ]) {
      expect(
        NightshiftConfigSchema.safeParse({ ...config, programsDirectory }).success,
        programsDirectory,
      ).toBe(false);
    }
  });

  it("refuses an unknown key, so a typo is not a silently ignored default", () => {
    expect(NightshiftConfigSchema.safeParse({ ...config, verfication: [] }).success).toBe(false);
  });
});
