/**
 * What the machine behind a remote run cost and how it was used (P20, S-05).
 * Pure: dispatch, utilization and agent records in, a report out.
 *
 * The instance and the volume have separate lifetimes. The instance is the sum
 * of its attempts; the volume lives from the request until it is deleted and
 * outlives machine replacements. Each component is priced over its own
 * observed lifetime and carries the provenance of its rate.
 */
import type {
  Agent,
  ComputeUtilization,
  Dispatch,
  ExecutionNodeId,
  IsoTimestamp,
  Run,
} from "@nightshift/contracts";
import { volumeUsdPerHour } from "../rules/compute.js";

export interface InfrastructureInput {
  readonly run: Run;
  readonly dispatch?: Dispatch;
  readonly utilization?: ComputeUtilization;
  readonly agents: readonly Agent[];
  readonly occupied?: readonly {
    readonly nodeId: ExecutionNodeId;
    readonly from: IsoTimestamp;
    readonly to?: IsoTimestamp;
  }[];
  readonly asOf: IsoTimestamp;
}

export type LifetimeCoverage = "complete" | "partial" | "unknown";

export interface InfrastructureAttempt {
  readonly generation: number;
  readonly reason: string;
  readonly startedAt: IsoTimestamp;
  readonly readyAt?: IsoTimestamp;
  readonly runningAt?: IsoTimestamp;
  readonly endedAt?: IsoTimestamp;
  readonly endReason?: string;
  readonly instanceId?: string;
  readonly meteredSeconds?: number;
  /** Closed attempts only. */
  readonly lifetimeMs?: number;
  readonly provisioningMs?: number;
  readonly incomplete: boolean;
}

export interface InfrastructureLifetime {
  readonly requestedAt: IsoTimestamp;
  readonly firstReadyAt?: IsoTimestamp;
  readonly lastEndedAt?: IsoTimestamp;
  readonly instanceLifetimeMs?: number;
  readonly gapsBetweenAttemptsMs: number;
  readonly openAttempts: number;
  readonly coverage: LifetimeCoverage;
}

export interface InfrastructureStage {
  readonly stage: string;
  readonly startedAt: IsoTimestamp;
  /** Absent for the last stage, which is open. */
  readonly durationMs?: number;
}

export interface InfrastructureStages {
  readonly generation: number;
  readonly stages: readonly InfrastructureStage[];
}

export interface InstanceComponent {
  readonly seconds: number;
  readonly basis: "metered seconds" | "closed attempt lifetimes" | "none observed";
  readonly usdPerHour: number;
  readonly usd: number;
  readonly provenance: string;
  readonly coverage: LifetimeCoverage;
}

export interface VolumeComponent {
  readonly seconds: number;
  /** True when the volume was not observed deleted: priced to `asOf`. */
  readonly open: boolean;
  readonly usdPerHour: number;
  readonly usd: number;
  readonly provenance: string;
  readonly coverage: "complete" | "open";
}

export interface InfrastructureReconciliation {
  /** Instance + volume priced over `spend.meteredSeconds`, like `meterUsd`. */
  readonly computedUsd: number;
  readonly meteredUsd: number;
  readonly meteredSeconds: number;
  readonly covers: string;
  readonly discrepancy?: { readonly computedUsd: number; readonly meteredUsd: number };
}

export interface InfrastructureOccupancy {
  readonly setupSeconds?: number;
  readonly busyMs: number;
  readonly idleMs: number;
  readonly provisioningMs: number;
  readonly peakConcurrentOccupants: number;
  readonly utilization?: {
    readonly peakCpuPct: number;
    readonly peakMemoryPct: number;
    readonly cpuAbove90Pct: number;
    readonly peakDiskPct: number;
    readonly oomKills: number;
  };
}

export interface InfrastructureApportionment {
  readonly method: "occupied-time share of the instance lifetime";
  readonly perNode?: readonly {
    readonly nodeId: ExecutionNodeId;
    readonly occupiedMs: number;
    readonly shareUsd: number;
  }[];
  readonly unapportionedUsd?: number;
  readonly note?: string;
}

export interface InfrastructureReport {
  readonly attempts: readonly InfrastructureAttempt[];
  readonly lifetime: InfrastructureLifetime;
  readonly stages: readonly InfrastructureStages[];
  readonly components: {
    readonly instance: InstanceComponent;
    readonly volume: VolumeComponent;
    readonly total: { readonly usd: number; readonly basis: string };
  };
  readonly recorded: Dispatch["spend"];
  readonly reconciliation: InfrastructureReconciliation;
  readonly occupancy: InfrastructureOccupancy;
  readonly apportionment: InfrastructureApportionment;
}

const DISCREPANCY_USD = 0.01;
const SNAPSHOT_PROVENANCE = "dispatch.usdPerHour snapshot at creation; no recorded price source";
const TABLE_PROVENANCE = "COMPUTE_TIERS/GP3 table constant, not a recorded basis";

const ms = (value: string): number => Date.parse(value);
const roundUsd = (value: number): number => Math.round(value * 1e6) / 1e6;
const usdOf = (seconds: number, perHour: number): number => roundUsd((seconds / 3600) * perHour);

interface Span {
  readonly from: number;
  readonly to: number;
}

const clip = (span: Span, windows: readonly Span[]): Span[] =>
  windows
    .map((w) => ({ from: Math.max(span.from, w.from), to: Math.min(span.to, w.to) }))
    .filter((s) => s.to > s.from);

const unionMs = (spans: readonly Span[]): number => {
  let total = 0;
  let end = Number.NEGATIVE_INFINITY;
  for (const s of [...spans].sort((a, b) => a.from - b.from)) {
    const from = Math.max(s.from, end);
    if (s.to > from) total += s.to - from;
    end = Math.max(end, s.to);
  }
  return total;
};

const attemptsOf = (dispatch: Dispatch): InfrastructureAttempt[] =>
  [...dispatch.attempts]
    .sort((a, b) => ms(a.startedAt) - ms(b.startedAt))
    .map((a) => ({
      generation: a.generation,
      reason: a.reason,
      startedAt: a.startedAt,
      ...(a.readyAt === undefined ? {} : { readyAt: a.readyAt }),
      ...(a.runningAt === undefined ? {} : { runningAt: a.runningAt }),
      ...(a.endedAt === undefined ? {} : { endedAt: a.endedAt }),
      ...(a.endReason === undefined ? {} : { endReason: a.endReason }),
      ...(a.instanceId === undefined ? {} : { instanceId: a.instanceId }),
      ...(a.meteredSeconds === undefined ? {} : { meteredSeconds: a.meteredSeconds }),
      ...(a.endedAt === undefined ? {} : { lifetimeMs: ms(a.endedAt) - ms(a.startedAt) }),
      ...(a.readyAt === undefined ? {} : { provisioningMs: ms(a.readyAt) - ms(a.startedAt) }),
      incomplete: a.endedAt === undefined,
    }));

const lifetimeOf = (dispatch: Dispatch, attempts: readonly InfrastructureAttempt[]) => {
  const closed = attempts.filter((a) => a.lifetimeMs !== undefined);
  const ready = attempts.flatMap((a) => (a.readyAt === undefined ? [] : [a.readyAt]));
  const ended = attempts.flatMap((a) => (a.endedAt === undefined ? [] : [a.endedAt]));
  let gaps = 0;
  for (let i = 1; i < attempts.length; i++) {
    const prev = attempts[i - 1];
    const next = attempts[i];
    if (prev?.endedAt === undefined || next === undefined) continue;
    gaps += Math.max(0, ms(next.startedAt) - ms(prev.endedAt));
  }
  const coverage: LifetimeCoverage =
    closed.length === 0 ? "unknown" : closed.length === attempts.length ? "complete" : "partial";
  const byTime = (a: string, b: string): number => ms(a) - ms(b);
  const firstReadyAt = [...ready].sort(byTime)[0];
  const lastEndedAt = [...ended].sort(byTime).at(-1);
  const lifetime: InfrastructureLifetime = {
    requestedAt: dispatch.requestedAt,
    ...(firstReadyAt === undefined ? {} : { firstReadyAt }),
    ...(lastEndedAt === undefined ? {} : { lastEndedAt }),
    ...(closed.length === 0
      ? {}
      : { instanceLifetimeMs: closed.reduce((sum, a) => sum + (a.lifetimeMs ?? 0), 0) }),
    gapsBetweenAttemptsMs: gaps,
    openAttempts: attempts.length - closed.length,
    coverage,
  };
  return lifetime;
};

const stagesOf = (dispatch: Dispatch): InfrastructureStages[] => {
  const byGeneration = new Map<number, { stage: string; startedAt: IsoTimestamp }[]>();
  for (const s of dispatch.stages ?? []) {
    const list = byGeneration.get(s.generation) ?? [];
    list.push({ stage: s.stage, startedAt: s.startedAt });
    byGeneration.set(s.generation, list);
  }
  return [...byGeneration.entries()]
    .sort(([a], [b]) => a - b)
    .map(([generation, list]) => {
      const sorted = list.sort((a, b) => ms(a.startedAt) - ms(b.startedAt));
      return {
        generation,
        stages: sorted.map((s, i) => {
          const next = sorted[i + 1];
          return next === undefined
            ? s
            : { ...s, durationMs: ms(next.startedAt) - ms(s.startedAt) };
        }),
      };
    });
};

const nodeSpans = (input: InfrastructureInput): Map<ExecutionNodeId, Span[]> => {
  const asOf = ms(input.asOf);
  const spans = new Map<ExecutionNodeId, Span[]>();
  const add = (nodeId: ExecutionNodeId, from: string, to: string | undefined): void => {
    const list = spans.get(nodeId) ?? [];
    list.push({ from: ms(from), to: to === undefined ? asOf : ms(to) });
    spans.set(nodeId, list);
  };
  if (input.occupied !== undefined) {
    for (const o of input.occupied) add(o.nodeId, o.from, o.to);
  } else {
    for (const a of input.agents) {
      if (a.startedAt !== undefined) add(a.executionNodeId, a.startedAt, a.endedAt);
    }
  }
  return spans;
};

export const infrastructureOf = (input: InfrastructureInput): InfrastructureReport | undefined => {
  const { dispatch } = input;
  if (dispatch === undefined) return undefined;
  const attempts = attemptsOf(dispatch);
  const lifetime = lifetimeOf(dispatch, attempts);
  const stages = stagesOf(dispatch);
  const basis = dispatch.priceBasis;

  const meteredAttempts = attempts.filter((a) => a.meteredSeconds !== undefined);
  const closedSeconds = (lifetime.instanceLifetimeMs ?? 0) / 1000;
  const instanceBasis: InstanceComponent["basis"] =
    meteredAttempts.length > 0
      ? "metered seconds"
      : lifetime.instanceLifetimeMs !== undefined
        ? "closed attempt lifetimes"
        : "none observed";
  const instanceSeconds =
    instanceBasis === "metered seconds"
      ? meteredAttempts.reduce((sum, a) => sum + (a.meteredSeconds ?? 0), 0)
      : closedSeconds;
  const instanceRate = basis?.usdPerHour ?? dispatch.usdPerHour;
  const instance: InstanceComponent = {
    seconds: instanceSeconds,
    basis: instanceBasis,
    usdPerHour: instanceRate,
    usd: usdOf(instanceSeconds, instanceRate),
    provenance:
      basis === undefined
        ? SNAPSHOT_PROVENANCE
        : `priceBasis ${basis.source}, as of ${basis.asOf}, region ${basis.region}`,
    coverage: lifetime.coverage,
  };

  const volumeOpen = dispatch.cleanup.volumeDeletedAt === undefined;
  const volumeEnd = ms(dispatch.cleanup.volumeDeletedAt ?? input.asOf);
  const volumeSeconds = Math.max(0, (volumeEnd - ms(dispatch.requestedAt)) / 1000);
  const volumeRate = basis?.volumeUsdPerHour ?? volumeUsdPerHour(dispatch.tier);
  const volume: VolumeComponent = {
    seconds: volumeSeconds,
    open: volumeOpen,
    usdPerHour: volumeRate,
    usd: usdOf(volumeSeconds, volumeRate),
    provenance:
      basis === undefined
        ? TABLE_PROVENANCE
        : `priceBasis ${basis.source}, as of ${basis.asOf}, region ${basis.region}`,
    coverage: volumeOpen ? "open" : "complete",
  };

  const total = {
    usd: roundUsd(instance.usd + volume.usd),
    basis:
      `Instance: ${instance.seconds} s from ${instance.basis} at ${instance.usdPerHour} USD/h (${instance.provenance}); ` +
      `volume: ${volume.seconds} s from request to ${volumeOpen ? "asOf (not yet deleted)" : "deletion"} at ${volume.usdPerHour} USD/h (${volume.provenance}).`,
  };

  const { spend } = dispatch;
  const computedUsd = roundUsd(
    usdOf(spend.meteredSeconds, instanceRate) + usdOf(spend.meteredSeconds, volumeRate),
  );
  const reconciliation: InfrastructureReconciliation = {
    computedUsd,
    meteredUsd: spend.meteredUsd,
    meteredSeconds: spend.meteredSeconds,
    covers:
      "computedUsd prices instance and volume together over spend.meteredSeconds, as meteredUsd does; the components above use each one's own observed lifetime.",
    ...(Math.abs(computedUsd - spend.meteredUsd) > DISCREPANCY_USD
      ? { discrepancy: { computedUsd, meteredUsd: spend.meteredUsd } }
      : {}),
  };

  // Occupancy: windows are the closed attempt lifetimes.
  const windows: Span[] = attempts.flatMap((a) =>
    a.endedAt === undefined ? [] : [{ from: ms(a.startedAt), to: ms(a.endedAt) }],
  );
  const clipped = new Map<ExecutionNodeId, Span[]>();
  for (const [nodeId, spans] of nodeSpans(input)) {
    const list = spans.flatMap((s) => clip(s, windows));
    if (list.length > 0) clipped.set(nodeId, list);
  }
  const allSpans = [...clipped.values()].flat();
  const busyMs = unionMs(allSpans);

  // Sweep: concurrent occupants split each moment equally.
  const points = [...new Set(allSpans.flatMap((s) => [s.from, s.to]))].sort((a, b) => a - b);
  const weighted = new Map<ExecutionNodeId, number>();
  const occupiedMs = new Map<ExecutionNodeId, number>();
  let peak = 0;
  for (let i = 1; i < points.length; i++) {
    const from = points[i - 1] ?? 0;
    const to = points[i] ?? 0;
    const active = [...clipped.entries()]
      .filter(([, spans]) => spans.some((s) => s.from <= from && s.to >= to))
      .map(([nodeId]) => nodeId);
    peak = Math.max(peak, active.length);
    for (const nodeId of active) {
      weighted.set(nodeId, (weighted.get(nodeId) ?? 0) + (to - from) / active.length);
      occupiedMs.set(nodeId, (occupiedMs.get(nodeId) ?? 0) + (to - from));
    }
  }

  const closedMs = lifetime.instanceLifetimeMs;
  const idleMs = closedMs === undefined ? 0 : Math.max(0, closedMs - busyMs);
  const u = input.utilization;
  const occupancy: InfrastructureOccupancy = {
    ...(u?.setupSeconds === undefined ? {} : { setupSeconds: u.setupSeconds }),
    busyMs,
    idleMs,
    provisioningMs: attempts.reduce((sum, a) => sum + (a.provisioningMs ?? 0), 0),
    peakConcurrentOccupants: peak,
    ...(u === undefined
      ? {}
      : {
          utilization: {
            peakCpuPct: u.peakCpuPct,
            peakMemoryPct: u.peakMemoryPct,
            cpuAbove90Pct: u.cpuAbove90Pct,
            peakDiskPct: u.peakDiskPct,
            oomKills: u.oomKills,
          },
        }),
  };

  let apportionment: InfrastructureApportionment;
  if (closedMs === undefined || closedMs === 0) {
    apportionment = {
      method: "occupied-time share of the instance lifetime",
      note: "No attempt has an observed end, so the instance lifetime is unknown and cost cannot be apportioned to nodes.",
    };
  } else {
    const perNode = [...weighted.entries()].map(([nodeId, w]) => ({
      nodeId,
      occupiedMs: occupiedMs.get(nodeId) ?? 0,
      shareUsd: roundUsd((instance.usd * w) / closedMs),
    }));
    const shared = perNode.reduce((sum, n) => sum + n.shareUsd, 0);
    apportionment = {
      method: "occupied-time share of the instance lifetime",
      perNode,
      unapportionedUsd: roundUsd(instance.usd - shared + volume.usd),
      ...(lifetime.coverage === "partial"
        ? { note: "Open attempts are excluded; shares cover closed attempts only." }
        : {}),
    };
  }

  return {
    attempts,
    lifetime,
    stages,
    components: { instance, volume, total },
    recorded: spend,
    reconciliation,
    occupancy,
    apportionment,
  };
};

/** The one line a caller prints when local machine expense has no configured basis. */
export const infrastructureUnavailable = (reason: string): string =>
  `Local machine expense is not reported: no configured basis (${reason}).`;
