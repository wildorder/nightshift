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
  DispatchAttempt,
  ExecutionNodeId,
  IsoTimestamp,
  Run,
} from "@nightshift/contracts";
import { volumeUsdPerHour } from "../rules/compute.js";
import type { OperationsReport } from "./operations.js";

export interface InfrastructureInput {
  readonly run: Run;
  readonly dispatch?: Dispatch;
  readonly utilization?: ComputeUtilization;
  readonly agents: readonly Agent[];
  /** Absent: derived from the agents' own timestamps (legacy). */
  readonly occupancy?: OccupancyInput;
  readonly asOf: IsoTimestamp;
}

export type OccupancyCoverage = "observed" | "partial" | "legacy" | "unknown";

export interface OccupancyInput {
  readonly intervals: readonly {
    readonly nodeId: ExecutionNodeId;
    readonly from: IsoTimestamp;
    readonly to?: IsoTimestamp;
  }[];
  readonly coverage: OccupancyCoverage;
}

/** Phases that run on the machine. Wait, queue and provisioning do not. */
const OCCUPYING_PHASES: ReadonlySet<string> = new Set([
  "startup",
  "setup",
  "work",
  "examination",
  "answer",
  "arbitration",
  "plan_review",
  "integration",
]);

/**
 * The machine occupancy behind a run: every operation interval whose phase runs
 * on the machine (open ones to `asOf`, incomplete ones to what was observed),
 * plus the timestamps of started agents that have no observed interval at all.
 */
export const occupancyOf = (input: {
  readonly operations: OperationsReport;
  readonly agents: readonly Agent[];
  readonly asOf: IsoTimestamp;
}): OccupancyInput => {
  const intervals: { nodeId: ExecutionNodeId; from: IsoTimestamp; to?: IsoTimestamp }[] = [];
  const observedAgents = new Set<string>();
  let unfinished = false;
  let observed = 0;
  for (const op of input.operations.operations) {
    if (!OCCUPYING_PHASES.has(op.phase) || op.startedAt === undefined) continue;
    const agentId = op.launch?.agentId ?? op.agentId;
    let to: IsoTimestamp | undefined;
    if (op.state === "closed") to = op.endedAt;
    else if (op.state === "open") {
      to = input.asOf;
      unfinished = true;
    } else if (op.state === "incomplete") {
      to = op.observedUntil;
      unfinished = true;
    }
    if (to === undefined) {
      unfinished = true;
      continue;
    }
    observed += 1;
    if (agentId !== undefined) observedAgents.add(agentId);
    intervals.push({ nodeId: op.nodeId as ExecutionNodeId, from: op.startedAt, to });
  }
  let fallbacks = 0;
  for (const a of input.agents) {
    if (a.startedAt === undefined || observedAgents.has(a.agentId)) continue;
    fallbacks += 1;
    intervals.push({
      nodeId: a.executionNodeId,
      from: a.startedAt,
      to: a.endedAt ?? input.asOf,
    });
  }
  const coverage: OccupancyCoverage =
    intervals.length === 0
      ? "unknown"
      : observed === 0
        ? "legacy"
        : fallbacks > 0 || unfinished
          ? "partial"
          : "observed";
  return { intervals, coverage };
};

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
  /** A terminate request for the instance was accepted; termination is asynchronous, so this is not an ending. */
  readonly terminationRequestedAt?: IsoTimestamp;
  /** The observed machine ending: the control plane described the instance as terminated. */
  readonly terminatedAt?: IsoTimestamp;
  /** A terminate request failed; the machine may still be running. */
  readonly terminationFailed?: boolean;
  /** True only when `terminatedAt` is present. */
  readonly observedEnd: boolean;
  /** `terminatedAt` minus `startedAt`; observed-closed attempts only. */
  readonly lifetimeMs?: number;
  /** Start to the runner's `endedAt` when no machine ending was observed: a lower bound, not a machine lifetime. */
  readonly runnerLifetimeMs?: number;
  /** Machine time after the runner stopped (`terminatedAt` minus `endedAt`), when both are known. */
  readonly afterRunnerMs?: number;
  readonly provisioningMs?: number;
  /** No observed machine end (`terminatedAt`): open, or the runner ending only. */
  readonly incomplete: boolean;
}

export interface InfrastructureLifetime {
  readonly requestedAt: IsoTimestamp;
  readonly firstReadyAt?: IsoTimestamp;
  /** The last observed machine ending (`terminatedAt`). */
  readonly lastEndedAt?: IsoTimestamp;
  /** The last runner ending (`endedAt`), which may precede the machine's. */
  readonly lastRunnerEndedAt?: IsoTimestamp;
  /** Sum of observed machine lifetimes: a lower bound unless coverage is complete. */
  readonly instanceLifetimeMs?: number;
  readonly gapsBetweenAttemptsMs: number;
  /** Attempts without an observed machine ending (open or runner ending only). */
  readonly openAttempts: number;
  /** Machine endings observed, versus attempts whose runner ended with no machine ending observed. */
  readonly observedEndings: number;
  readonly runnerOnlyEndings: number;
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
  readonly basis:
    | "observed machine lifetimes (terminatedAt - startedAt)"
    | "observed machine lifetimes, plus runner-metered seconds for attempts with machine end unobserved (lower bound)"
    | "runner-metered seconds; machine end unobserved (lower bound)"
    | "none observed";
  /** Metered seconds across attempts: they stop with the runner, beside the observed machine lifetimes. */
  readonly runnerMeteredSeconds: number;
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
  readonly coverage: OccupancyCoverage;
  /** Observed busy time, at least: occupancy inside observed-closed attempts. */
  readonly busyMs: number;
  /** Only for observed or legacy occupancy coverage; otherwise idle time is not claimed. */
  readonly idleMs?: number;
  readonly idleNote?: string;
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

export interface UnapportionedAttempt {
  readonly generation: number;
  readonly usd: number;
  readonly why: "open" | "machine end unobserved";
}

export interface InfrastructureApportionment {
  readonly method: "per-attempt occupied-time share of observed-closed attempt cost";
  readonly perNode?: readonly {
    readonly nodeId: ExecutionNodeId;
    readonly occupiedMs: number;
    readonly shareUsd: number;
  }[];
  readonly unapportionedUsd?: number;
  /** Attempts without terminatedAt: their cost (runner-metered, a lower bound) is never apportioned. */
  readonly unapportioned?: readonly UnapportionedAttempt[];
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

/**
 * The attempt's machine end was observed: `terminatedAt` and nothing else. The
 * runner's ending (`endedAt`, any `endReason`), a terminate request and a failed
 * termination never close a machine.
 */
const observedEndOf = (a: DispatchAttempt): IsoTimestamp | undefined => a.terminatedAt;

const attemptsOf = (dispatch: Dispatch): InfrastructureAttempt[] =>
  [...dispatch.attempts]
    .sort((a, b) => ms(a.startedAt) - ms(b.startedAt))
    .map((a) => {
      const observedEnd = observedEndOf(a);
      return {
        generation: a.generation,
        reason: a.reason,
        startedAt: a.startedAt,
        ...(a.readyAt === undefined ? {} : { readyAt: a.readyAt }),
        ...(a.runningAt === undefined ? {} : { runningAt: a.runningAt }),
        ...(a.endedAt === undefined ? {} : { endedAt: a.endedAt }),
        ...(a.endReason === undefined ? {} : { endReason: a.endReason }),
        ...(a.instanceId === undefined ? {} : { instanceId: a.instanceId }),
        ...(a.meteredSeconds === undefined ? {} : { meteredSeconds: a.meteredSeconds }),
        ...(a.terminationRequestedAt === undefined
          ? {}
          : { terminationRequestedAt: a.terminationRequestedAt }),
        ...(a.terminatedAt === undefined ? {} : { terminatedAt: a.terminatedAt }),
        ...(a.terminationFailed === undefined ? {} : { terminationFailed: a.terminationFailed }),
        observedEnd: observedEnd !== undefined,
        ...(observedEnd === undefined ? {} : { lifetimeMs: ms(observedEnd) - ms(a.startedAt) }),
        ...(observedEnd !== undefined || a.endedAt === undefined
          ? {}
          : { runnerLifetimeMs: ms(a.endedAt) - ms(a.startedAt) }),
        ...(observedEnd === undefined || a.endedAt === undefined
          ? {}
          : { afterRunnerMs: ms(observedEnd) - ms(a.endedAt) }),
        ...(a.readyAt === undefined ? {} : { provisioningMs: ms(a.readyAt) - ms(a.startedAt) }),
        incomplete: observedEnd === undefined,
      };
    });

const lifetimeOf = (dispatch: Dispatch, attempts: readonly InfrastructureAttempt[]) => {
  const closed = attempts.filter((a) => a.lifetimeMs !== undefined);
  const ready = attempts.flatMap((a) => (a.readyAt === undefined ? [] : [a.readyAt]));
  const terminated = attempts.flatMap((a) =>
    a.terminatedAt === undefined ? [] : [a.terminatedAt],
  );
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
  const lastEndedAt = [...terminated].sort(byTime).at(-1);
  const lastRunnerEndedAt = [...ended].sort(byTime).at(-1);
  const lifetime: InfrastructureLifetime = {
    requestedAt: dispatch.requestedAt,
    ...(firstReadyAt === undefined ? {} : { firstReadyAt }),
    ...(lastEndedAt === undefined ? {} : { lastEndedAt }),
    ...(lastRunnerEndedAt === undefined ? {} : { lastRunnerEndedAt }),
    ...(closed.length === 0
      ? {}
      : { instanceLifetimeMs: closed.reduce((sum, a) => sum + (a.lifetimeMs ?? 0), 0) }),
    gapsBetweenAttemptsMs: gaps,
    openAttempts: attempts.length - closed.length,
    observedEndings: closed.length,
    runnerOnlyEndings: attempts.filter((a) => !a.observedEnd && a.endedAt !== undefined).length,
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
  for (const o of occupancyFor(input).intervals) {
    const list = spans.get(o.nodeId) ?? [];
    list.push({ from: ms(o.from), to: o.to === undefined ? asOf : ms(o.to) });
    spans.set(o.nodeId, list);
  }
  return spans;
};

/** Without supplied occupancy the agents' own timestamps stand in. */
const occupancyFor = (input: InfrastructureInput): OccupancyInput => {
  if (input.occupancy !== undefined) return input.occupancy;
  const intervals = input.agents.flatMap((a) =>
    a.startedAt === undefined
      ? []
      : [
          {
            nodeId: a.executionNodeId,
            from: a.startedAt,
            ...(a.endedAt === undefined ? {} : { to: a.endedAt }),
          },
        ],
  );
  return { intervals, coverage: intervals.length === 0 ? "unknown" : "legacy" };
};

export const infrastructureOf = (input: InfrastructureInput): InfrastructureReport | undefined => {
  const { dispatch } = input;
  if (dispatch === undefined) return undefined;
  const attempts = attemptsOf(dispatch);
  const lifetime = lifetimeOf(dispatch, attempts);
  const stages = stagesOf(dispatch);
  const basis = dispatch.priceBasis;

  // An observed-closed attempt costs its machine lifetime (terminatedAt - startedAt);
  // metered seconds stop with the runner and are reported beside it. An attempt
  // without terminatedAt contributes its metered seconds as a lower bound.
  const attemptSeconds = (a: InfrastructureAttempt): number =>
    a.lifetimeMs === undefined ? (a.meteredSeconds ?? 0) : a.lifetimeMs / 1000;
  const observedCount = attempts.filter((a) => a.lifetimeMs !== undefined).length;
  const runnerOnlyCount = attempts.filter(
    (a) => a.lifetimeMs === undefined && a.meteredSeconds !== undefined,
  ).length;
  const instanceBasis: InstanceComponent["basis"] =
    observedCount > 0 && runnerOnlyCount > 0
      ? "observed machine lifetimes, plus runner-metered seconds for attempts with machine end unobserved (lower bound)"
      : observedCount > 0
        ? "observed machine lifetimes (terminatedAt - startedAt)"
        : runnerOnlyCount > 0
          ? "runner-metered seconds; machine end unobserved (lower bound)"
          : "none observed";
  const instanceSeconds = attempts.reduce((sum, a) => sum + attemptSeconds(a), 0);
  const instanceRate = basis?.usdPerHour ?? dispatch.usdPerHour;
  const instance: InstanceComponent = {
    seconds: instanceSeconds,
    basis: instanceBasis,
    runnerMeteredSeconds: attempts.reduce((sum, a) => sum + (a.meteredSeconds ?? 0), 0),
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

  // Occupancy and cost windows are startedAt -> terminatedAt, observed-closed
  // attempts only; an open attempt or a runner ending alone is never a window.
  const closedAttempts = attempts.flatMap((a) =>
    a.lifetimeMs === undefined
      ? []
      : [
          {
            attempt: a,
            window: { from: ms(a.startedAt), to: ms(a.startedAt) + a.lifetimeMs } as Span,
          },
        ],
  );
  const spansByNode = nodeSpans(input);
  const weighted = new Map<ExecutionNodeId, number>();
  const shareUsd = new Map<ExecutionNodeId, number>();
  const occupiedMs = new Map<ExecutionNodeId, number>();
  const busySpans: Span[] = [];
  let peak = 0;
  for (const { attempt, window } of closedAttempts) {
    const clipped = new Map<ExecutionNodeId, Span[]>();
    for (const [nodeId, spans] of spansByNode) {
      const list = spans.flatMap((s) => clip(s, [window]));
      if (list.length > 0) clipped.set(nodeId, list);
    }
    const allSpans = [...clipped.values()].flat();
    busySpans.push(...allSpans);
    const windowMs = window.to - window.from;
    const cost = usdOf(attemptSeconds(attempt), instanceRate);
    // Sweep: concurrent occupants split each moment equally within this attempt.
    const points = [...new Set(allSpans.flatMap((s) => [s.from, s.to]))].sort((a, b) => a - b);
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
        if (windowMs > 0) {
          shareUsd.set(
            nodeId,
            (shareUsd.get(nodeId) ?? 0) + (cost * (to - from)) / active.length / windowMs,
          );
        }
      }
    }
  }
  const busyMs = unionMs(busySpans);

  const closedMs = lifetime.instanceLifetimeMs;
  const occupancyCoverage = occupancyFor(input).coverage;
  const idleKnown =
    (occupancyCoverage === "observed" || occupancyCoverage === "legacy") &&
    closedMs !== undefined &&
    lifetime.coverage === "complete";
  const u = input.utilization;
  const occupancy: InfrastructureOccupancy = {
    ...(u?.setupSeconds === undefined ? {} : { setupSeconds: u.setupSeconds }),
    coverage: occupancyCoverage,
    busyMs,
    ...(idleKnown
      ? { idleMs: Math.max(0, closedMs - busyMs) }
      : {
          idleNote:
            closedMs === undefined
              ? "No attempt has an observed machine end (terminatedAt), so idle time is not claimed; busy time is observed busy time, at least."
              : lifetime.coverage !== "complete"
                ? "Not every attempt's machine end (terminatedAt) is observed, so idle time is not claimed; busy time is observed busy time, at least."
                : `Occupancy coverage is ${occupancyCoverage}, so idle time is not claimed; busy time is observed busy time, at least.`,
        }),
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

  const unapportioned: UnapportionedAttempt[] = attempts.flatMap((a) =>
    a.observedEnd
      ? []
      : [
          {
            generation: a.generation,
            usd: usdOf(attemptSeconds(a), instanceRate),
            why: a.endedAt === undefined ? ("open" as const) : ("machine end unobserved" as const),
          },
        ],
  );
  const perNode = [...weighted.keys()].map((nodeId) => ({
    nodeId,
    occupiedMs: occupiedMs.get(nodeId) ?? 0,
    shareUsd: roundUsd(shareUsd.get(nodeId) ?? 0),
  }));
  const shared = perNode.reduce((sum, n) => sum + n.shareUsd, 0);
  const apportionment: InfrastructureApportionment = {
    method: "per-attempt occupied-time share of observed-closed attempt cost",
    ...(closedAttempts.length === 0 ? {} : { perNode }),
    unapportionedUsd: roundUsd(instance.usd + volume.usd - shared),
    unapportioned,
    note:
      (closedAttempts.length === 0
        ? "No attempt has an observed machine end (terminatedAt), so cost cannot be apportioned to nodes. "
        : "") +
      "Each observed-closed attempt costs its observed machine lifetime (terminatedAt - startedAt) at the instance rate, split by occupied time within that same window (concurrent occupants share each moment equally). " +
      "The cost of attempts without an observed machine end (open, or machine end unobserved) is never apportioned and is listed per attempt, together with unoccupied time within closed attempts and the whole volume, as unapportioned.",
  };

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
