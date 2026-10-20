/**
 * A run's adjustments to a step's time (P19 S-02, D-01, D-05, D-06).
 *
 * An orchestrator may raise a step's timeout or cleanup time mid-run, or skip a
 * step whose most recent run timed out. Each is a recorded decision whose
 * context carries a fixed prefix; nothing is written to the contract, so the
 * plan hash and carry-over are untouched. Everything here is pure: the decisions
 * and verifications are handed in.
 */
import {
  DEFAULT_STEP_CLEANUP_SECONDS,
  DEFAULT_STEP_TIMEOUT_SECONDS,
  MAX_STEP_CLEANUP_SECONDS,
  MAX_STEP_TIMEOUT_SECONDS,
} from "@nightshift/contracts";

export const STEP_TIMEOUT_CONTEXT = "STEP TIMEOUT:";
export const STEP_SKIPPED_CONTEXT = "STEP SKIPPED:";

/**
 * The exit code of a step its timeout killed. Equals `TIMEOUT_EXIT_CODE` in
 * `@nightshift/verification`; core may not import verification, so the
 * execution package's test holds the two equal.
 */
export const STEP_TIMED_OUT_EXIT_CODE = 124;

export type StepTimeField = "timeoutSeconds" | "cleanupSeconds";
const FIELDS: readonly StepTimeField[] = ["timeoutSeconds", "cleanupSeconds"];

const MAXIMUMS: Record<StepTimeField, number> = {
  timeoutSeconds: MAX_STEP_TIMEOUT_SECONDS,
  cleanupSeconds: MAX_STEP_CLEANUP_SECONDS,
};
const DEFAULTS: Record<StepTimeField, number> = {
  timeoutSeconds: DEFAULT_STEP_TIMEOUT_SECONDS,
  cleanupSeconds: DEFAULT_STEP_CLEANUP_SECONDS,
};
const MAXIMUM_WORDS: Record<StepTimeField, string> = {
  timeoutSeconds: "7200 seconds (two hours); past that, skip the step (D-04)",
  cleanupSeconds: "3600 seconds (one hour)",
};

/** The part of a decision this module reads. */
export interface AdjustmentDecision {
  readonly decisionId: string;
  readonly context: string;
  readonly createdAt: string;
  readonly rationale: string;
}

/** The part of a verification's command result this module reads. */
export interface StepCommandLike {
  readonly stepId: string;
  readonly exitCode?: number | undefined;
  readonly deferred?: { readonly prerequisiteId: string } | undefined;
  readonly skipped?: { readonly decisionId: string } | undefined;
  /** The step's automatic rerun when it failed again; the command's own fields are the first run. */
  readonly rerun?: { readonly exitCode: number } | undefined;
}

/** The part of a verification this module reads. */
export interface StepVerificationLike {
  readonly verificationId: string;
  readonly commitSha: string;
  /** When it began; the end stands in where a reader has only that. */
  readonly startedAt?: string | undefined;
  readonly endedAt: string;
  readonly commands: readonly StepCommandLike[];
}

/** The part of a decision the authority rule reads. */
export interface AuthoredDecision extends AdjustmentDecision {
  readonly authority: string;
  readonly executionNodeId: string;
}

export type AdjustmentNodeKind = "program" | "sub-program" | "job";

/**
 * The decisions an adjustment may come from (P19 S-02: a gate is the program's,
 * and a job's agent does not loosen it). A decision's context is free text any
 * worker can write through `decision.record`, so the prefix alone proves
 * nothing: an adjustment is a decision on the root orchestrator's node (a
 * `program` node) or a strand's orchestrator's (a `sub-program` node), whatever
 * its authority; a human records an override on the run's root node. A decision
 * recorded on a job node, or on a node the reader cannot place, is never an
 * adjustment, whatever its context or authority says. The API's write boundary
 * keeps an execution token from writing `authority: "human"`.
 */
export const adjustmentDecisionsOf = <D extends AuthoredDecision>(
  decisions: readonly D[],
  nodeKindOf: (nodeId: string) => AdjustmentNodeKind | undefined,
): D[] =>
  decisions.filter((decision) => {
    const kind = nodeKindOf(decision.executionNodeId);
    return kind === "program" || kind === "sub-program";
  });

export interface TimeRaise {
  readonly timeoutSeconds?: number | undefined;
  readonly cleanupSeconds?: number | undefined;
}

export const formatStepTimeoutContext = (stepId: string, raise: TimeRaise): string =>
  [
    `${STEP_TIMEOUT_CONTEXT} ${stepId}`,
    ...FIELDS.flatMap((field) => (raise[field] === undefined ? [] : [`${field}=${raise[field]}`])),
  ].join(" ");

export const formatStepSkippedContext = (stepId: string): string =>
  `${STEP_SKIPPED_CONTEXT} ${stepId}`;

export type StepAdjustment<D extends AdjustmentDecision = AdjustmentDecision> =
  | {
      readonly kind: "timeout";
      readonly stepId: string;
      readonly timeoutSeconds?: number;
      readonly cleanupSeconds?: number;
      readonly decision: D;
    }
  | { readonly kind: "skip"; readonly stepId: string; readonly decision: D };

/** Reads a decision's context back; undefined when it is not a step adjustment. */
export const stepAdjustmentOf = <D extends AdjustmentDecision>(
  decision: D,
): StepAdjustment<D> | undefined => {
  const line = decision.context.split("\n", 1)[0] ?? "";
  if (line.startsWith(STEP_SKIPPED_CONTEXT)) {
    const stepId = line.slice(STEP_SKIPPED_CONTEXT.length).trim();
    return stepId === "" || /\s/.test(stepId) ? undefined : { kind: "skip", stepId, decision };
  }
  if (!line.startsWith(STEP_TIMEOUT_CONTEXT)) return undefined;
  const [stepId, ...rest] = line.slice(STEP_TIMEOUT_CONTEXT.length).trim().split(/\s+/);
  if (stepId === undefined || stepId === "") return undefined;
  const values: { timeoutSeconds?: number; cleanupSeconds?: number } = {};
  for (const token of rest) {
    const match = /^(timeoutSeconds|cleanupSeconds)=(\d+)$/.exec(token);
    if (match === null) return undefined;
    values[match[1] as StepTimeField] = Number(match[2]);
  }
  if (values.timeoutSeconds === undefined && values.cleanupSeconds === undefined) return undefined;
  return { kind: "timeout", stepId, ...values, decision };
};

interface Record_ {
  readonly verification: StepVerificationLike;
  readonly command: StepCommandLike;
}

/** The step's records, oldest first: by the verification's endedAt, then position. */
const recordsOf = (stepId: string, verifications: readonly StepVerificationLike[]): Record_[] =>
  verifications
    .map((verification, position) => ({ verification, position }))
    .sort(
      (a, b) =>
        a.verification.endedAt.localeCompare(b.verification.endedAt) || a.position - b.position,
    )
    .flatMap(({ verification }) =>
      verification.commands
        .filter((command) => command.stepId === stepId)
        .map((command) => ({ verification, command })),
    );

const ran = (command: StepCommandLike): boolean =>
  command.exitCode !== undefined && command.deferred === undefined && command.skipped === undefined;

/** The exit code of the command's latest execution: its rerun's when it has one. */
const latestExitOf = (command: StepCommandLike): number =>
  (command.rerun?.exitCode ?? command.exitCode) as number;

/** Timed out on its latest record: the first run and any rerun both exited 124. */
const timedOut = (command: StepCommandLike): boolean =>
  command.exitCode === STEP_TIMED_OUT_EXIT_CODE &&
  (command.rerun === undefined || command.rerun.exitCode === STEP_TIMED_OUT_EXIT_CODE);

/** The most recent result for the step that actually ran; deferred and skipped records are looked past. */
export const lastRunOf = (
  stepId: string,
  verifications: readonly StepVerificationLike[],
): { verification: StepVerificationLike; exitCode: number } | undefined => {
  const found = recordsOf(stepId, verifications)
    .filter((record) => ran(record.command))
    .at(-1);
  return found === undefined
    ? undefined
    : { verification: found.verification, exitCode: latestExitOf(found.command) };
};

/** Why a step may not be skipped, said from the record that stands in the way. */
const ineligibleReason = (stepId: string, command: StepCommandLike | undefined): string => {
  if (command === undefined) {
    return `${stepId} has not run in this run; only a step whose most recent run timed out may be skipped (D-06)`;
  }
  if (command.skipped !== undefined) {
    return `${stepId} is already skipped, by decision ${command.skipped.decisionId}`;
  }
  if (command.deferred !== undefined) {
    return `${stepId} was deferred on its most recent run, waiting on ${command.deferred.prerequisiteId}; it cannot be skipped`;
  }
  if (command.exitCode === 0)
    return `${stepId} passed on its most recent run; it cannot be skipped`;
  if (command.rerun !== undefined) {
    if (command.exitCode === STEP_TIMED_OUT_EXIT_CODE) {
      return `${stepId} timed out and then ran and failed with exit ${command.rerun.exitCode} on its rerun; fix it, it cannot be skipped`;
    }
    if (command.rerun.exitCode === STEP_TIMED_OUT_EXIT_CODE) {
      return `${stepId} ran and failed with exit ${command.exitCode} before timing out on its rerun; fix it, it cannot be skipped`;
    }
    return `${stepId} ran and failed with exit ${command.rerun.exitCode} on its rerun; fix it, it cannot be skipped`;
  }
  return `${stepId} ran and failed with exit ${command.exitCode}; fix it, it cannot be skipped`;
};

export type SkipEligibility =
  | { readonly eligible: true; readonly timedOut: { verificationId: string; commitSha: string } }
  | { readonly eligible: false; readonly reason: string };

/** The tool's check, over the step's most recent record of any kind. */
export const skipEligibility = (
  stepId: string,
  verifications: readonly StepVerificationLike[],
): SkipEligibility => {
  const latest = recordsOf(stepId, verifications).at(-1);
  if (latest !== undefined && ran(latest.command) && timedOut(latest.command)) {
    return {
      eligible: true,
      timedOut: {
        verificationId: latest.verification.verificationId,
        commitSha: latest.verification.commitSha,
      },
    };
  }
  return { eligible: false, reason: ineligibleReason(stepId, latest?.command) };
};

export type SkipHonoured =
  | { readonly honoured: true }
  | { readonly honoured: false; readonly reason: string };

/** The engine's authoritative check when a skip is applied: the latest actual run timed out. */
export const skipHonoured = (
  stepId: string,
  verifications: readonly StepVerificationLike[],
): SkipHonoured => {
  const records = recordsOf(stepId, verifications);
  const lastRan = records.filter((record) => ran(record.command)).at(-1);
  if (lastRan !== undefined && timedOut(lastRan.command)) {
    return { honoured: true };
  }
  return {
    honoured: false,
    reason: ineligibleReason(stepId, (lastRan ?? records.at(-1))?.command),
  };
};

interface StepTimeShape {
  readonly id: string;
  readonly timeoutSeconds?: number | undefined;
  readonly cleanupSeconds?: number | undefined;
}

const inOrder = <D extends AdjustmentDecision>(decisions: readonly D[]): D[] =>
  decisions
    .map((decision, position) => ({ decision, position }))
    .sort(
      (a, b) => a.decision.createdAt.localeCompare(b.decision.createdAt) || a.position - b.position,
    )
    .map(({ decision }) => decision);

/** What bounds a raise: the run's wall clock, when its program sets one. */
export interface AdjustmentLimits {
  readonly maxWallClockSeconds?: number | undefined;
}

/** A raise the wall clock stopped from applying. */
export interface RaiseNotApplied {
  readonly decisionId: string;
  readonly field: StepTimeField;
  readonly to: number;
  readonly reason: string;
}

interface StepState {
  timeoutSeconds?: number;
  cleanupSeconds?: number;
  latest?: StepAdjustment;
  notApplied?: RaiseNotApplied[];
}

const declaredOf = (step: StepTimeShape): StepState => ({
  ...(step.timeoutSeconds === undefined ? {} : { timeoutSeconds: step.timeoutSeconds }),
  ...(step.cleanupSeconds === undefined ? {} : { cleanupSeconds: step.cleanupSeconds }),
});

/** Applies the decisions in order to the steps' declared values. */
const replay = (
  steps: readonly StepTimeShape[],
  decisions: readonly AdjustmentDecision[],
  onRaise?: (
    stepId: string,
    decisionId: string,
    field: StepTimeField,
    from: number,
    to: number,
    reason: string,
    notApplied?: string,
  ) => void,
  onAdjustment?: (adjustment: StepAdjustment) => void,
  limits: AdjustmentLimits = {},
): Map<string, StepState> => {
  const states = new Map<string, StepState>();
  for (const step of steps) states.set(step.id, declaredOf(step));
  for (const decision of inOrder(decisions)) {
    const adjustment = stepAdjustmentOf(decision);
    if (adjustment === undefined) continue;
    const state = states.get(adjustment.stepId);
    if (state === undefined) continue;
    onAdjustment?.(adjustment);
    state.latest = adjustment;
    if (adjustment.kind !== "timeout") continue;
    for (const field of FIELDS) {
      const asked = adjustment[field];
      if (asked === undefined) continue;
      const to = Math.min(asked, MAXIMUMS[field]);
      const from = state[field] ?? DEFAULTS[field];
      const wallClock = limits.maxWallClockSeconds;
      if (wallClock !== undefined) {
        const timeout =
          field === "timeoutSeconds" ? to : (state.timeoutSeconds ?? DEFAULTS.timeoutSeconds);
        const cleanup =
          field === "cleanupSeconds" ? to : (state.cleanupSeconds ?? DEFAULTS.cleanupSeconds);
        if (timeout + cleanup > wallClock) {
          state.notApplied = state.notApplied ?? [];
          state.notApplied.push({
            decisionId: decision.decisionId,
            field,
            to,
            reason: `${field} ${to} with ${field === "timeoutSeconds" ? `cleanupSeconds ${cleanup}` : `timeoutSeconds ${timeout}`} is ${timeout + cleanup} seconds together, over the run's costPolicy.maxWallClockSeconds of ${wallClock}`,
          });
          onRaise?.(
            adjustment.stepId,
            decision.decisionId,
            field,
            from,
            to,
            decision.rationale,
            state.notApplied.at(-1)?.reason,
          );
          continue;
        }
      }
      onRaise?.(adjustment.stepId, decision.decisionId, field, from, to, decision.rationale);
      state[field] = to;
    }
  }
  return states;
};

/** A contract step with the run's adjustments applied. */
export type EffectiveStep<T extends StepTimeShape = StepTimeShape> = T & {
  readonly skipped?: { readonly decisionId: string };
  readonly skipNotHonoured?: { readonly decisionId: string; readonly reason: string };
  readonly raisesNotApplied?: readonly RaiseNotApplied[];
};

export const effectiveSteps = <T extends StepTimeShape>(
  contractSteps: readonly T[],
  decisions: readonly AdjustmentDecision[],
  verifications: readonly StepVerificationLike[],
  limits: AdjustmentLimits = {},
): EffectiveStep<T>[] => {
  const states = replay(contractSteps, decisions, undefined, undefined, limits);
  return contractSteps.map((step): EffectiveStep<T> => {
    const state = states.get(step.id) ?? {};
    const { timeoutSeconds, cleanupSeconds, latest } = state;
    const base = { ...step } as EffectiveStep<T> & {
      timeoutSeconds?: number | undefined;
      cleanupSeconds?: number | undefined;
      raisesNotApplied?: readonly RaiseNotApplied[];
    };
    if (timeoutSeconds !== undefined) base.timeoutSeconds = timeoutSeconds;
    if (cleanupSeconds !== undefined) base.cleanupSeconds = cleanupSeconds;
    if (state.notApplied !== undefined) base.raisesNotApplied = state.notApplied;
    if (latest?.kind !== "skip") return base;
    const verdict = skipHonoured(step.id, verifications);
    const decisionId = latest.decision.decisionId;
    return verdict.honoured
      ? { ...base, skipped: { decisionId } }
      : { ...base, skipNotHonoured: { decisionId, reason: verdict.reason } };
  });
};

/** The step's effective time, the defaults filled in. */
export const currentStepTime = (
  step: StepTimeShape,
  decisions: readonly AdjustmentDecision[],
  limits: AdjustmentLimits = {},
): { timeoutSeconds: number; cleanupSeconds: number } => {
  const state = replay([step], decisions, undefined, undefined, limits).get(step.id) ?? {};
  return {
    timeoutSeconds: state.timeoutSeconds ?? DEFAULT_STEP_TIMEOUT_SECONDS,
    cleanupSeconds: state.cleanupSeconds ?? DEFAULT_STEP_CLEANUP_SECONDS,
  };
};

/** Why a raise is refused, or undefined when it may be recorded. */
export const raiseRefusal = (
  step: StepTimeShape,
  decisions: readonly AdjustmentDecision[],
  raise: TimeRaise,
  limits: AdjustmentLimits = {},
): string | undefined => {
  const asked = FIELDS.filter((field) => raise[field] !== undefined);
  if (asked.length === 0) return "give timeoutSeconds, cleanupSeconds, or both";
  const current = currentStepTime(step, decisions, limits);
  for (const field of asked) {
    const value = raise[field] as number;
    if (!Number.isInteger(value) || value <= 0) {
      return `step "${step.id}": ${field} must be a positive whole number of seconds, got ${value}`;
    }
    if (value > MAXIMUMS[field]) {
      return `step "${step.id}": ${field} ${value} is over the maximum of ${MAXIMUM_WORDS[field]}`;
    }
    if (value <= current[field]) {
      return `step "${step.id}": ${field} ${value} is not above its current ${current[field]}; a timeout may only be raised`;
    }
  }
  const wallClock = limits.maxWallClockSeconds;
  if (wallClock !== undefined) {
    const timeout = raise.timeoutSeconds ?? current.timeoutSeconds;
    const cleanup = raise.cleanupSeconds ?? current.cleanupSeconds;
    if (timeout + cleanup > wallClock) {
      const say = (field: StepTimeField, value: number): string =>
        `${field} ${value}${raise[field] === undefined && step[field] === undefined && current[field] === DEFAULTS[field] ? " (the default)" : ""}`;
      return `step "${step.id}" would have ${say("timeoutSeconds", timeout)} and ${say("cleanupSeconds", cleanup)}, ${timeout + cleanup} seconds together, over the run's costPolicy.maxWallClockSeconds of ${wallClock}: raise a smaller amount, or skip the step`;
    }
  }
  return undefined;
};

export interface StepAdjustments {
  readonly skipped: readonly {
    readonly stepId: string;
    readonly decisionId: string;
    readonly reason: string;
    /** The commits of the verifications that recorded this decision's skip, in verification order. */
    readonly commits: readonly string[];
    /** Some verification recorded this decision's skip. */
    readonly applied: boolean;
    /** This decision is the step's latest adjustment and the skip holds now. */
    readonly inForce: boolean;
    /** No record of this skip, though a later verification ran the step: why the skip did not apply. */
    readonly notApplied?: string;
  }[];
  readonly raised: readonly {
    readonly stepId: string;
    readonly decisionId: string;
    readonly field: StepTimeField;
    readonly from: number;
    readonly to: number;
    readonly reason: string;
    /** The engine would not apply this raise: why. */
    readonly notApplied?: string;
  }[];
}

/**
 * Why a decision's skip never applied: the step ran in a verification that
 * started after the decision, so the engine had its chance. Undefined when no
 * verification has run the step since.
 */
const notAppliedReason = (
  stepId: string,
  decisionAt: string,
  verifications: readonly StepVerificationLike[],
): string | undefined => {
  const ordered = verifications
    .map((verification, position) => ({ verification, position }))
    .sort(
      (a, b) =>
        a.verification.endedAt.localeCompare(b.verification.endedAt) || a.position - b.position,
    )
    .map(({ verification }) => verification);
  const index = ordered.findIndex(
    (verification) =>
      (verification.startedAt ?? verification.endedAt) >= decisionAt &&
      verification.commands.some((command) => command.stepId === stepId && ran(command)),
  );
  if (index < 0) return undefined;
  const verdict = skipHonoured(stepId, ordered.slice(0, index));
  return verdict.honoured
    ? `${stepId} ran again after the decision and the skip was not recorded`
    : verdict.reason;
};

/** Every adjustment of the run, in decision order, for the report and `run.finish`. */
export const stepAdjustmentsOf = (
  contractSteps: readonly StepTimeShape[],
  decisions: readonly AdjustmentDecision[],
  verifications: readonly StepVerificationLike[],
  limits: AdjustmentLimits = {},
): StepAdjustments => {
  const raised: Array<StepAdjustments["raised"][number]> = [];
  const skips: StepAdjustment[] = [];
  const states = replay(
    contractSteps,
    decisions,
    (stepId, decisionId, field, from, to, reason, notApplied) =>
      raised.push({
        stepId,
        decisionId,
        field,
        from,
        to,
        reason,
        ...(notApplied === undefined ? {} : { notApplied }),
      }),
    (adjustment) => {
      if (adjustment.kind === "skip") skips.push(adjustment);
    },
    limits,
  );
  const skipped = skips.map((adjustment): StepAdjustments["skipped"][number] => {
    const { stepId, decision } = adjustment;
    const commits: string[] = [];
    for (const verification of verifications) {
      const recorded = verification.commands.some(
        (command) =>
          command.stepId === stepId && command.skipped?.decisionId === decision.decisionId,
      );
      if (recorded && !commits.includes(verification.commitSha))
        commits.push(verification.commitSha);
    }
    const applied = commits.length > 0;
    const latest = states.get(stepId)?.latest;
    const inForce =
      latest?.kind === "skip" &&
      latest.decision.decisionId === decision.decisionId &&
      skipHonoured(stepId, verifications).honoured;
    const notApplied = applied
      ? undefined
      : notAppliedReason(stepId, decision.createdAt, verifications);
    return {
      stepId,
      decisionId: decision.decisionId,
      reason: decision.rationale,
      commits,
      applied,
      inForce,
      ...(notApplied === undefined ? {} : { notApplied }),
    };
  });
  return { skipped, raised };
};
