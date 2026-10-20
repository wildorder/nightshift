/**
 * The verification plan's arithmetic (P17, D-P17-01, D-P17-02).
 *
 * Every number here is either measured — one run of the gate audit, labelled
 * with where — or measured × a multiplier the output states. Nothing is summed
 * that was not measured; nothing measured is shown without its label.
 */
import {
  SETUP_STEP_ID_PREFIX,
  type SetupStep,
  stepRunsAt,
  stepTime,
  type VerificationStep,
} from "@nightshift/contracts";

/** One step as the audit measured it. */
export interface MeasuredStep {
  readonly durationMs: number;
  /** How long it was quiet before its first output (D-P17-05). */
  readonly quietMs: number;
  readonly exitCode: number;
  /** Setup the audit skipped because the reference's installed tree seeded it. */
  readonly seeded?: boolean;
  /** The step's timeout killed it: its time is the cap, not how long it needs. */
  readonly timedOut?: boolean;
}

/** Where the landings multiplier came from, said with the number (D-P17-01). */
export type LandingsSource = "given" | "last run" | "default";

export const DEFAULT_LANDINGS = 10;
/** The end gates run once, or once more after a fix: two, assumed. */
export const END_GATE_RUNS = 2;

export interface ForecastInput {
  readonly setup: readonly SetupStep[];
  readonly verification: readonly VerificationStep[];
  /** By step id, setup steps under their `setup:` id. A step the audit did not run is absent. */
  readonly measured: ReadonlyMap<string, MeasuredStep>;
  readonly landings: {
    readonly count: number;
    readonly source: LandingsSource;
  };
}

export interface PlannedStep {
  readonly id: string;
  readonly command: string;
  readonly kind: "setup" | "landing" | "end";
  /** The step's timeout, from the contract (the default when it declares none). */
  readonly timeoutMs: number;
  readonly measured: MeasuredStep | undefined;
}

export interface VerificationPlan {
  readonly steps: readonly PlannedStep[];
  /** Setup's measured cost when it runs in full; 0 when the audit found it seeded. */
  readonly setupMs: number;
  /** Every landing step, plus setup. What one job's verification costs. */
  readonly landingMs: number;
  /** A candidate check and the queue's: an examined job pays for two landings (D-P8-09). */
  readonly examinedJobMs: number;
  /** Setup plus every end gate, once. */
  readonly endGatesMs: number;
  readonly landings: ForecastInput["landings"];
  /** landings × landingMs + END_GATE_RUNS × endGatesMs (when there are end gates). */
  readonly projectedMs: number;
  /** Steps the audit did not measure (waiting, unrun): the plan says so rather than guessing. */
  readonly unmeasured: readonly string[];
}

const sum = (values: readonly number[]): number => values.reduce((total, v) => total + v, 0);

export const forecast = (input: ForecastInput): VerificationPlan => {
  const steps: PlannedStep[] = [
    ...input.setup.map((step): PlannedStep => {
      const id = `${SETUP_STEP_ID_PREFIX}${step.id}`;
      return {
        id,
        command: step.command,
        kind: "setup",
        timeoutMs: stepTime(step).timeoutMs,
        measured: input.measured.get(id),
      };
    }),
    ...input.verification.map(
      (step): PlannedStep => ({
        id: step.id,
        command: step.command,
        kind: stepRunsAt(step),
        timeoutMs: stepTime(step).timeoutMs,
        measured: input.measured.get(step.id),
      }),
    ),
  ];
  const cost = (kind: PlannedStep["kind"]): number =>
    sum(
      steps
        .filter((step) => step.kind === kind && step.measured !== undefined)
        .map((step) => (step.measured?.seeded === true ? 0 : (step.measured?.durationMs ?? 0))),
    );
  const setupMs = cost("setup");
  const landingMs = setupMs + cost("landing");
  const endSteps = steps.filter((step) => step.kind === "end");
  const endGatesMs = endSteps.length === 0 ? 0 : setupMs + cost("end");
  return {
    steps,
    setupMs,
    landingMs,
    examinedJobMs: 2 * landingMs,
    endGatesMs,
    landings: input.landings,
    projectedMs: input.landings.count * landingMs + END_GATE_RUNS * endGatesMs,
    unmeasured: steps.filter((step) => step.measured === undefined).map((step) => step.id),
  };
};

/** `2h 10m`, `9m 10s`, `3.1s`: a duration a human reads at a glance. */
export const humanDuration = (ms: number): string => {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
};
