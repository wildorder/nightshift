/**
 * Where the run's verification time went (P17, D-P17-07): per step and phase,
 * summed from the run's `Verification` records; the forecast beside it when
 * the project's gate-health record kept one; and the catalogue's
 * recommendations re-priced with the run's real durations.
 */
import {
  type ProgramContract,
  RUN_VERIFICATION_PHASES,
  type RunVerificationPhase,
  SETUP_STEP_ID_PREFIX,
  stepRunsAt,
  VERIFICATION_PHASES,
  type Verification,
  type VerificationForecast,
  type VerificationPhase,
} from "@nightshift/contracts";
import { type Recommendation, recommend } from "../forecast/catalogue.js";
import { END_GATE_RUNS, forecast, type MeasuredStep } from "../forecast/model.js";
import { resolvedFromRecord } from "../forecast/record.js";

export { RUN_VERIFICATION_PHASES, VERIFICATION_PHASES, type VerificationPhase };

export interface PhaseTime {
  readonly runs: number;
  readonly totalMs: number;
}

export interface StepTimeReport {
  readonly id: string;
  readonly kind: "setup" | "landing" | "end";
  /** Times the step ran and had an exit code; a deferred step did not run. */
  readonly runs: number;
  readonly totalMs: number;
  /** Runs that were a rerun or a flaky first run, kept beside the rest: each is time spent. */
  readonly rerunRuns: number;
  /** Time of those runs, already inside `totalMs`. */
  readonly rerunMs: number;
  /** Quiet before the first output, summed over the runs that measured it. */
  readonly quietMs: number;
  readonly byPhase: Readonly<Record<RunVerificationPhase, PhaseTime>>;
  /** The forecast's one measured run, when the record kept one. */
  readonly forecastMs?: number;
}

export interface ForecastSummary {
  readonly machine: string;
  readonly landings: number;
  readonly landingMs: number;
  readonly projectedMs: number;
}

export interface VerificationTimeReport {
  readonly steps: readonly StepTimeReport[];
  /** Jobs that integrated: the run's actual landings. */
  readonly landings: number;
  readonly verifications: number;
  readonly totalMs: number;
  readonly forecast?: ForecastSummary;
  /** The catalogue over this run's durations, with the record's evidence. */
  readonly recommendations: readonly Recommendation[];
}

const emptyPhases = (): Record<RunVerificationPhase, { runs: number; totalMs: number }> =>
  Object.fromEntries(
    RUN_VERIFICATION_PHASES.map((phase) => [phase, { runs: 0, totalMs: 0 }]),
  ) as Record<RunVerificationPhase, { runs: number; totalMs: number }>;

const kindOf = (program: ProgramContract, id: string): StepTimeReport["kind"] => {
  if (id.startsWith(SETUP_STEP_ID_PREFIX)) return "setup";
  const step = program.verification.find((candidate) => candidate.id === id);
  return step === undefined ? "landing" : stepRunsAt(step);
};

const summarise = (record: VerificationForecast): ForecastSummary => {
  const cost = (kind: "setup" | "landing" | "end"): number =>
    record.steps
      .filter((step) => step.kind === kind && step.seeded !== true)
      .reduce((total, step) => total + step.durationMs, 0);
  const landingMs = cost("setup") + cost("landing");
  const endGatesMs = record.steps.some((step) => step.kind === "end")
    ? cost("setup") + cost("end")
    : 0;
  return {
    machine: record.machine,
    landings: record.landings,
    landingMs,
    projectedMs: record.landings * landingMs + END_GATE_RUNS * endGatesMs,
  };
};

/** A flaky command's own figures are the passing rerun's and a failed rerun's sit beside the first run's: each extra run is time spent. */
const timeOf = (command: Verification["commands"][number]) => {
  const extraMs = command.flaky?.firstDurationMs ?? command.rerun?.durationMs;
  return {
    runs: extraMs === undefined ? 1 : 2,
    durationMs: command.durationMs + (extraMs ?? 0),
    extraMs: extraMs ?? 0,
    extraRuns: extraMs === undefined ? 0 : 1,
  };
};

const totalOf = <
  T extends {
    runs: number;
    totalMs: number;
    rerunRuns: number;
    rerunMs: number;
    quietMs: number;
    phases: ReturnType<typeof emptyPhases>;
  },
>(
  totals: Map<string, T>,
  stepId: string,
): T => {
  let total = totals.get(stepId);
  if (total === undefined) {
    total = {
      runs: 0,
      totalMs: 0,
      rerunRuns: 0,
      rerunMs: 0,
      quietMs: 0,
      phases: emptyPhases(),
    } as T;
    totals.set(stepId, total);
  }
  return total;
};

export const verificationTimeOf = (
  program: ProgramContract,
  verifications: readonly Verification[],
  landings: number,
  record: VerificationForecast | undefined,
): VerificationTimeReport => {
  // The contract's order first, then any step a repair added along the way.
  const order = [
    ...(program.setup ?? []).map((step) => `${SETUP_STEP_ID_PREFIX}${step.id}`),
    ...program.verification.map((step) => step.id),
  ];
  const totals = new Map<
    string,
    {
      runs: number;
      totalMs: number;
      rerunRuns: number;
      rerunMs: number;
      quietMs: number;
      phases: ReturnType<typeof emptyPhases>;
    }
  >();
  for (const id of order)
    totals.set(id, {
      runs: 0,
      totalMs: 0,
      rerunRuns: 0,
      rerunMs: 0,
      quietMs: 0,
      phases: emptyPhases(),
    });
  for (const verification of verifications) {
    // A run's store holds no `line` verification: the record's schema refuses one.
    const phase = (verification.phase ?? "queue") as RunVerificationPhase;
    for (const command of verification.commands) {
      if (command.exitCode === undefined) continue;
      const total = totalOf(totals, command.stepId);
      const { runs, durationMs, extraMs, extraRuns } = timeOf(command);
      total.rerunRuns += extraRuns;
      total.rerunMs += extraMs;
      total.runs += runs;
      total.totalMs += durationMs;
      total.quietMs += command.quietMs ?? 0;
      total.phases[phase].runs += runs;
      total.phases[phase].totalMs += durationMs;
    }
  }
  const forecastOf = new Map((record?.steps ?? []).map((step) => [step.id, step]));
  const steps: StepTimeReport[] = [...totals.entries()].map(([id, total]) => {
    const forecastMs = forecastOf.get(id)?.durationMs;
    return {
      id,
      kind: kindOf(program, id),
      runs: total.runs,
      totalMs: total.totalMs,
      rerunRuns: total.rerunRuns,
      rerunMs: total.rerunMs,
      quietMs: total.quietMs,
      byPhase: total.phases,
      ...(forecastMs === undefined ? {} : { forecastMs }),
    };
  });

  // The catalogue over what this run measured: each step's average run, and
  // the landings it actually made. The evidence is the record's.
  const measured = new Map<string, MeasuredStep>(
    steps
      .filter((step) => step.runs > 0)
      .map((step) => [
        step.id,
        {
          durationMs: Math.round(step.totalMs / step.runs),
          quietMs: Math.round(step.quietMs / step.runs),
          exitCode: 0,
        },
      ]),
  );
  const recommendations = recommend(
    forecast({
      setup: program.setup ?? [],
      verification: program.verification,
      measured,
      landings: { count: Math.max(1, landings), source: "last run" },
    }),
    resolvedFromRecord(record),
  ).filter((recommendation) => recommendation.savingMs !== undefined);

  return {
    steps,
    landings,
    verifications: verifications.length,
    totalMs: steps.reduce((total, step) => total + step.totalMs, 0),
    ...(record === undefined ? {} : { forecast: summarise(record) }),
    recommendations,
  };
};
