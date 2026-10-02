/**
 * Which machine (P10, D-P10-13, D-P10-14).
 */
import type { ComputeTier, ComputeUtilization, UtilizationSample } from "@nightshift/contracts";
import { COMPUTE_TIERS } from "@nightshift/contracts";
import { describe, expect, it } from "vitest";
import { createFixtures, makeComputeUtilization } from "../testing/factories.js";
import {
  chooseTier,
  emptyUtilization,
  estimateUsd,
  foldUtilization,
  HEAVY_LOCKFILE_BYTES,
  isInstallStep,
  maySkipInstall,
  meterUsd,
  type ProbeSignals,
  RIGHT_SIZING_RUNS,
  recommendFromProbe,
  recommendFromUse,
} from "./compute.js";

const f = createFixtures();
const AT = "2026-10-01T12:00:00.000Z";

const plain: ProbeSignals = {
  lockfileBytes: 200_000,
  workspaces: 1,
  docker: false,
  browser: false,
  nativeBuild: false,
  cdkBundling: false,
  maxConcurrency: 2,
};

describe("recommendFromProbe (D-P10-14a, §4.2)", () => {
  const table: readonly [string, Partial<ProbeSignals>, ComputeTier, string][] = [
    ["a plain Node project", {}, "good", "no heavy build, service or browser signal"],
    ["Docker service tests", { docker: true }, "better", "Docker or Testcontainers service tests"],
    ["a browser dependency", { browser: true }, "better", "a browser test dependency"],
    ["a Rust build", { nativeBuild: true }, "better", "a Rust or native build"],
    ["CDK bundling", { cdkBundling: true }, "better", "CDK bundling"],
    [
      "a heavy lockfile",
      { lockfileBytes: HEAVY_LOCKFILE_BYTES + 1 },
      "better",
      "a lockfile over 2 MiB",
    ],
    ["a six-workspace monorepo", { workspaces: 7 }, "better", "7 workspaces"],
    ["Docker and Rust", { docker: true, nativeBuild: true }, "best", "a Rust or native build"],
    [
      "Docker with four concurrent jobs",
      { docker: true, maxConcurrency: 4 },
      "best",
      "4 concurrent jobs",
    ],
  ];

  it.each(table)("%s → %s", (_name, overrides, tier, reason) => {
    const recommendation = recommendFromProbe({ ...plain, ...overrides });
    expect(recommendation.tier).toBe(tier);
    expect(recommendation.reasons).toContain(reason);
  });

  it("explains every signal it found and nothing it did not", () => {
    const recommendation = recommendFromProbe({ ...plain, docker: true, cdkBundling: true });
    expect(recommendation.reasons).toEqual([
      "Docker or Testcontainers service tests",
      "CDK bundling",
    ]);
  });

  it("does not let concurrency alone promote a plain project", () => {
    expect(recommendFromProbe({ ...plain, maxConcurrency: 8 }).tier).toBe("good");
  });
});

describe("recommendFromUse (D-P10-14b)", () => {
  const quiet = (tier: ComputeTier, overrides: Partial<ComputeUtilization> = {}) =>
    makeComputeUtilization(f, { tier, peakMemoryPct: 30, peakCpuPct: 40, ...overrides });

  it("says so when it has fewer than three runs on the tier", () => {
    expect(recommendFromUse([quiet("better"), quiet("better")], "better")).toEqual({
      kind: "insufficient",
      have: 2,
      need: RIGHT_SIZING_RUNS,
    });
    // Runs on another tier do not count.
    expect(recommendFromUse([quiet("better"), quiet("better"), quiet("good")], "better").kind).toBe(
      "insufficient",
    );
  });

  it("recommends one tier down when every run stayed under 45% memory and 50% CPU", () => {
    const result = recommendFromUse([quiet("better"), quiet("better"), quiet("better")], "better");
    expect(result).toMatchObject({ kind: "recommendation", direction: "down", tier: "good" });
    if (result.kind === "recommendation") {
      expect(result.evidence[0]).toBe("peak memory 30% and peak CPU 40% over 3 runs");
    }
  });

  it("keeps the smallest tier when under-used, and says why", () => {
    const result = recommendFromUse([quiet("good"), quiet("good"), quiet("good")], "good");
    expect(result).toMatchObject({ kind: "recommendation", direction: "keep", tier: "good" });
    if (result.kind === "recommendation") {
      expect(result.evidence).toContain("good is the smallest tier");
    }
  });

  it("recommends one tier up on a single out-of-memory kill, however quiet the rest", () => {
    const result = recommendFromUse(
      [quiet("better"), quiet("better", { oomKills: 1 }), quiet("better")],
      "better",
    );
    expect(result).toMatchObject({ kind: "recommendation", direction: "up", tier: "best" });
    if (result.kind === "recommendation") {
      expect(result.evidence[0]).toMatch(/1 out-of-memory kill/);
    }
  });

  it("treats swap, a nearly full disk and sustained CPU as pressure too", () => {
    for (const pressure of [
      { swapUsed: true },
      { peakDiskPct: 90 },
      { cpuAbove90Pct: 0.1 },
    ] as const) {
      const result = recommendFromUse(
        [quiet("good"), quiet("good", pressure), quiet("good")],
        "good",
      );
      expect(result, JSON.stringify(pressure)).toMatchObject({ direction: "up", tier: "better" });
    }
  });

  it("keeps the largest tier under pressure, and says so", () => {
    const result = recommendFromUse(
      [quiet("best", { oomKills: 2 }), quiet("best"), quiet("best")],
      "best",
    );
    expect(result).toMatchObject({ kind: "recommendation", direction: "keep", tier: "best" });
    if (result.kind === "recommendation") {
      expect(result.evidence).toContain("best is the largest tier");
    }
  });

  it("keeps the tier when use is neither low nor pressed", () => {
    const busy = quiet("better", { peakMemoryPct: 70, peakCpuPct: 80 });
    expect(recommendFromUse([busy, busy, busy], "better")).toMatchObject({
      direction: "keep",
      tier: "better",
    });
  });

  it("reads only the three most recent runs on the tier", () => {
    const old = quiet("better", { oomKills: 1 });
    const result = recommendFromUse(
      [quiet("better"), quiet("better"), quiet("better"), old],
      "better",
    );
    expect(result).toMatchObject({ direction: "down" });
  });
});

describe("chooseTier (D-P10-14)", () => {
  const recommended = { tier: "best" as const, reasons: ["Docker"] };

  it("takes the flag, then the contract, then the config, then a recommendation, then good", () => {
    expect(chooseTier("good", { tier: "better" }, { tier: "best" })).toEqual({
      tier: "good",
      source: "flag",
    });
    expect(chooseTier(undefined, { tier: "better" }, { tier: "best" })).toEqual({
      tier: "better",
      source: "contract",
    });
    expect(chooseTier(undefined, undefined, { tier: "best" })).toEqual({
      tier: "best",
      source: "config",
    });
    expect(chooseTier(undefined, undefined, { recommended })).toEqual({
      tier: "best",
      source: "recommendation",
    });
    expect(chooseTier(undefined, { recommended }, { tier: "good", recommended })).toEqual({
      tier: "good",
      source: "config",
    });
    expect(chooseTier(undefined, undefined, undefined)).toEqual({
      tier: "good",
      source: "default",
    });
  });

  it("never lets a recommendation override a stated tier", () => {
    expect(chooseTier(undefined, { tier: "good", recommended }, undefined).tier).toBe("good");
  });
});

describe("the arithmetic (D-P10-19)", () => {
  it("prices hours on the tier plus the volume's share", () => {
    const hour = estimateUsd("good", 1);
    expect(hour).toBeGreaterThan(COMPUTE_TIERS.good.usdPerHour);
    expect(hour).toBeLessThan(COMPUTE_TIERS.good.usdPerHour + 0.02);
    expect(estimateUsd("best", 24)).toBeCloseTo(
      24 * COMPUTE_TIERS.best.usdPerHour + (24 * (400 * 0.08)) / 730,
      6,
    );
  });

  it("meters seconds as a fraction of an hour", () => {
    expect(meterUsd("better", 1800)).toBeCloseTo(estimateUsd("better", 0.5), 10);
    expect(meterUsd("better", 0)).toBe(0);
  });
});

describe("foldUtilization", () => {
  const sample = (overrides: Partial<UtilizationSample> = {}): UtilizationSample => ({
    memoryPct: 20,
    cpuPct: 30,
    diskPct: 10,
    swapUsed: false,
    oomKills: 0,
    ...overrides,
  });

  it("raises peaks, counts saturation over every sample, and sets setup once", () => {
    const empty = emptyUtilization(f.scope, "good");
    const first = foldUtilization(empty, [sample(), sample({ cpuPct: 95 })], 40, 12.5, AT);
    expect(first).toMatchObject({
      samples: 2,
      peakMemoryPct: 20,
      peakCpuPct: 95,
      cpuAbove90Pct: 0.5,
      wallClockSeconds: 40,
      setupSeconds: 12.5,
    });
    const second = foldUtilization(
      first,
      [sample({ memoryPct: 60, oomKills: 1, swapUsed: true }), sample()],
      80,
      99,
      AT,
    );
    expect(second).toMatchObject({
      samples: 4,
      peakMemoryPct: 60,
      cpuAbove90Pct: 0.25,
      oomKills: 1,
      swapUsed: true,
      wallClockSeconds: 80,
      setupSeconds: 12.5,
    });
  });

  it("tolerates an empty heartbeat", () => {
    const empty = emptyUtilization(f.scope, "good");
    expect(foldUtilization(empty, [], 0, undefined, AT)).toMatchObject({
      samples: 0,
      cpuAbove90Pct: 0,
    });
  });
});

describe("maySkipInstall (D-P10-24, SC-P10-08)", () => {
  const hashes = { "package-lock.json": "a".repeat(64) };
  const matching = { reference: hashes, checkout: hashes, installedTree: true };

  it("skips only when every lockfile matches what the tree was installed for, and the tree is there", () => {
    expect(maySkipInstall(matching)).toMatchObject({ skip: true });
    expect(maySkipInstall({ ...matching, reference: undefined }).skip).toBe(false);
    expect(
      maySkipInstall({ ...matching, checkout: { "package-lock.json": "b".repeat(64) } }).skip,
    ).toBe(false);
    // A lockfile added or removed is a change, as is having none at all.
    expect(
      maySkipInstall({ ...matching, checkout: { ...hashes, "uv.lock": "c".repeat(64) } }).skip,
    ).toBe(false);
    expect(maySkipInstall({ reference: {}, checkout: {}, installedTree: true }).skip).toBe(false);
    expect(maySkipInstall({ ...matching, installedTree: false }).skip).toBe(false);
  });

  it("knows an install step from the rest of setup", () => {
    for (const command of [
      "npm ci",
      "npm ci --prefer-offline",
      "npm install",
      "pnpm install --frozen-lockfile",
      "yarn",
      "yarn install --immutable",
      "uv sync",
      "pip install -r requirements.txt",
    ]) {
      expect(isInstallStep(command), command).toBe(true);
    }
    for (const command of ["npm run codegen", "npx prisma migrate deploy", "cargo build", "make"]) {
      expect(isInstallStep(command), command).toBe(false);
    }
  });
});
