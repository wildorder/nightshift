/**
 * Which machine (P10, D-P10-13, D-P10-14, D-P10-19).
 *
 * Three pure functions and their arithmetic:
 *
 * - `recommendFromProbe`: the tier a repository needs, from what it declares,
 *   before the first run. The signals are gathered by the CLI's probe over the
 *   file system; this is the rule table they feed (§4.2 of the contract).
 * - `recommendFromUse`: the tier the last three runs say, from what the machine
 *   was actually asked to do. Lambda's power tuning, for a build machine.
 * - `chooseTier`: the customer's choice, in the order D-P10-14 gives it.
 *
 * Nothing here changes a tier. A recommendation is printed; the customer decides.
 */
import type {
  ComputeChoice,
  ComputeRecommendation,
  ComputeTier,
  ComputeUtilization,
  UtilizationSample,
} from "@nightshift/contracts";
import { COMPUTE_TIER_ORDER, COMPUTE_TIERS, GP3_USD_PER_GIB_MONTH } from "@nightshift/contracts";

/** What the probe found in a repository. Facts, read from files; nothing is run. */
export interface ProbeSignals {
  /** The largest lockfile's size. */
  readonly lockfileBytes: number;
  /** Workspaces declared by `package.json` or `pnpm-workspace.yaml`; 1 for a single package. */
  readonly workspaces: number;
  /** A Dockerfile, a compose file, Testcontainers, or a CI workflow using services or Docker. */
  readonly docker: boolean;
  /** Playwright, Puppeteer or Chromium among the dependencies. */
  readonly browser: boolean;
  /** `Cargo.toml`, `binding.gyp`, node-gyp or napi among the dependencies. */
  readonly nativeBuild: boolean;
  /** `cdk.json` with `aws-cdk-lib` among the dependencies. */
  readonly cdkBundling: boolean;
  /** The contract's or config's `delegationLimits.maxConcurrency`. */
  readonly maxConcurrency: number;
}

/** A lockfile this large says a dependency tree that takes a machine to install. */
export const HEAVY_LOCKFILE_BYTES = 2 * 1024 * 1024;
/** More workspaces than this is a monorepo whose builds want the cores. */
export const MANY_WORKSPACES = 6;
/** With this much concurrency, one heavy signal already wants `best`. */
export const HIGH_CONCURRENCY = 4;

interface Signal {
  readonly present: boolean;
  readonly reason: string;
}

const signalsOf = (probe: ProbeSignals): readonly Signal[] => [
  { present: probe.docker, reason: "Docker or Testcontainers service tests" },
  { present: probe.browser, reason: "a browser test dependency" },
  { present: probe.nativeBuild, reason: "a Rust or native build" },
  { present: probe.cdkBundling, reason: "CDK bundling" },
  {
    present: probe.lockfileBytes > HEAVY_LOCKFILE_BYTES,
    reason: `a lockfile over ${HEAVY_LOCKFILE_BYTES / (1024 * 1024)} MiB`,
  },
  {
    present: probe.workspaces > MANY_WORKSPACES,
    reason: `${probe.workspaces} workspaces`,
  },
];

/**
 * The §4.2 table: no heavy signal is `good`; one is `better`; two or more, or
 * one with high concurrency, is `best`. The reasons are the signals found.
 */
export const recommendFromProbe = (probe: ProbeSignals): ComputeRecommendation => {
  const found = signalsOf(probe).filter((signal) => signal.present);
  const reasons = found.map((signal) => signal.reason);
  if (found.length === 0) {
    return { tier: "good", reasons: ["no heavy build, service or browser signal"] };
  }
  if (found.length >= 2) return { tier: "best", reasons };
  if (probe.maxConcurrency >= HIGH_CONCURRENCY) {
    return { tier: "best", reasons: [...reasons, `${probe.maxConcurrency} concurrent jobs`] };
  }
  return { tier: "better", reasons };
};

/** How many completed runs on one tier the right-sizing rule wants before it speaks. */
export const RIGHT_SIZING_RUNS = 3;
/** Under these peaks on every run, the tier is more than the project uses. */
export const UNDER_USE_MEMORY_PCT = 45;
export const UNDER_USE_CPU_PCT = 50;
/** Any of these on any run and the tier is too small. */
export const PRESSURE_DISK_PCT = 85;
export const PRESSURE_CPU_SATURATION = 0.1;

export type RightSizing =
  | { readonly kind: "insufficient"; readonly have: number; readonly need: number }
  | {
      readonly kind: "recommendation";
      readonly direction: "down" | "up" | "keep";
      readonly tier: ComputeTier;
      readonly evidence: readonly string[];
    };

const neighbour = (tier: ComputeTier, step: -1 | 1): ComputeTier => {
  const index = COMPUTE_TIER_ORDER.indexOf(tier) + step;
  return COMPUTE_TIER_ORDER[Math.min(COMPUTE_TIER_ORDER.length - 1, Math.max(0, index))] ?? tier;
};

const pct = (value: number): string => `${Math.round(value)}%`;

/**
 * The right-sizing rule (D-P10-14b) over the last `RIGHT_SIZING_RUNS` completed
 * runs on `current`. Pressure on any run wins over under-use on every run: a
 * machine that ran out of memory once is too small, however idle it was otherwise.
 */
export const recommendFromUse = (
  records: readonly ComputeUtilization[],
  current: ComputeTier,
): RightSizing => {
  const onTier = records.filter((record) => record.tier === current).slice(0, RIGHT_SIZING_RUNS);
  if (onTier.length < RIGHT_SIZING_RUNS) {
    return { kind: "insufficient", have: onTier.length, need: RIGHT_SIZING_RUNS };
  }
  const pressure: string[] = [];
  for (const record of onTier) {
    if (record.oomKills > 0)
      pressure.push(`${record.oomKills} out-of-memory kill(s) in ${record.runId}`);
    if (record.swapUsed) pressure.push(`swap used in ${record.runId}`);
    if (record.peakDiskPct > PRESSURE_DISK_PCT) {
      pressure.push(`disk at ${pct(record.peakDiskPct)} in ${record.runId}`);
    }
    if (record.cpuAbove90Pct >= PRESSURE_CPU_SATURATION) {
      pressure.push(
        `CPU above 90% for ${pct(record.cpuAbove90Pct * 100)} of the run in ${record.runId}`,
      );
    }
  }
  if (pressure.length > 0) {
    const up = neighbour(current, 1);
    return {
      kind: "recommendation",
      direction: up === current ? "keep" : "up",
      tier: up,
      evidence: up === current ? [...pressure, `${current} is the largest tier`] : pressure,
    };
  }
  const peakMemory = Math.max(...onTier.map((record) => record.peakMemoryPct));
  const peakCpu = Math.max(...onTier.map((record) => record.peakCpuPct));
  if (peakMemory < UNDER_USE_MEMORY_PCT && peakCpu < UNDER_USE_CPU_PCT) {
    const down = neighbour(current, -1);
    const evidence = [
      `peak memory ${pct(peakMemory)} and peak CPU ${pct(peakCpu)} over ${onTier.length} runs`,
    ];
    return {
      kind: "recommendation",
      direction: down === current ? "keep" : "down",
      tier: down,
      evidence: down === current ? [...evidence, `${current} is the smallest tier`] : evidence,
    };
  }
  return {
    kind: "recommendation",
    direction: "keep",
    tier: current,
    evidence: [
      `peak memory ${pct(peakMemory)} and peak CPU ${pct(peakCpu)} over ${onTier.length} runs`,
    ],
  };
};

export type TierSource = "flag" | "contract" | "config" | "recommendation" | "default";

export interface TierChoice {
  readonly tier: ComputeTier;
  readonly source: TierSource;
}

/**
 * The customer's choice (D-P10-14): `--compute`, else the contract's `tier`,
 * else the config's, else a recommendation (the contract's, else the config's),
 * else `good`. A recommendation never overrides a stated tier.
 */
export const chooseTier = (
  flag: ComputeTier | undefined,
  contract: ComputeChoice | undefined,
  config: ComputeChoice | undefined,
): TierChoice => {
  if (flag !== undefined) return { tier: flag, source: "flag" };
  if (contract?.tier !== undefined) return { tier: contract.tier, source: "contract" };
  if (config?.tier !== undefined) return { tier: config.tier, source: "config" };
  const recommended = contract?.recommended ?? config?.recommended;
  if (recommended !== undefined) return { tier: recommended.tier, source: "recommendation" };
  return { tier: "good", source: "default" };
};

const HOURS_PER_MONTH = 730;

/** The volume's share of an hour, at the gp3 rate. */
export const volumeUsdPerHour = (tier: ComputeTier): number =>
  (COMPUTE_TIERS[tier].volumeGiB * GP3_USD_PER_GIB_MONTH) / HOURS_PER_MONTH;

/** What `hours` on `tier` cost, machine and volume. */
export const estimateUsd = (tier: ComputeTier, hours: number): number =>
  hours * (COMPUTE_TIERS[tier].usdPerHour + volumeUsdPerHour(tier));

/** What `seconds` on `tier` have cost so far, machine and volume. */
export const meterUsd = (tier: ComputeTier, seconds: number): number =>
  estimateUsd(tier, seconds / 3600);

/**
 * Folds a heartbeat's samples into the run's utilization record (D-P10-14b).
 * Peaks only ever rise; the saturation fraction is recomputed over all samples
 * so far; `setupSeconds` is set once, by the first heartbeat that knows it.
 */
export const foldUtilization = (
  existing: Omit<ComputeUtilization, "updatedAt">,
  samples: readonly UtilizationSample[],
  meteredSeconds: number,
  setupSeconds: number | undefined,
  at: string,
): ComputeUtilization => {
  const saturatedBefore = Math.round(existing.cpuAbove90Pct * existing.samples);
  const saturatedNow = samples.filter((sample) => sample.cpuPct > 90).length;
  const total = existing.samples + samples.length;
  const max = (current: number, pick: (sample: UtilizationSample) => number): number =>
    samples.reduce((peak, sample) => Math.max(peak, pick(sample)), current);
  return {
    ...existing,
    samples: total,
    peakMemoryPct: max(existing.peakMemoryPct, (sample) => sample.memoryPct),
    peakCpuPct: max(existing.peakCpuPct, (sample) => sample.cpuPct),
    peakDiskPct: max(existing.peakDiskPct, (sample) => sample.diskPct),
    cpuAbove90Pct: total === 0 ? 0 : (saturatedBefore + saturatedNow) / total,
    oomKills: max(existing.oomKills, (sample) => sample.oomKills),
    swapUsed: existing.swapUsed || samples.some((sample) => sample.swapUsed),
    wallClockSeconds: Math.max(existing.wallClockSeconds, meteredSeconds),
    ...(existing.setupSeconds === undefined && setupSeconds !== undefined ? { setupSeconds } : {}),
    updatedAt: at,
  };
};

/** A run's utilization before any heartbeat. */
export const emptyUtilization = (
  scope: Pick<ComputeUtilization, "projectId" | "programId" | "runId">,
  tier: ComputeTier,
): Omit<ComputeUtilization, "updatedAt"> => ({
  schemaVersion: 1,
  ...scope,
  tier,
  samples: 0,
  peakMemoryPct: 0,
  peakCpuPct: 0,
  cpuAbove90Pct: 0,
  peakDiskPct: 0,
  oomKills: 0,
  swapUsed: false,
  wallClockSeconds: 0,
});
