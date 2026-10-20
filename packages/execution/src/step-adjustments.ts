/**
 * Recording a run's adjustments to a step's time (P19 S-02): raising a step's
 * timeout, or skipping a step whose most recent run timed out. Each is one
 * decision written through the caller's own decision path: a strand's
 * `recordWorkerDecision`, or the root's. Nothing is written to the contract.
 */
import type {
  Decision,
  DecisionId,
  ExecutionNodeId,
  Verification,
  VerificationStep,
} from "@nightshift/contracts";
import {
  type AdjustmentDecision,
  effectiveSteps,
  formatStepSkippedContext,
  formatStepTimeoutContext,
  type Page,
  type PageRequest,
  type ProjectStores,
  type RunScope,
  raiseRefusal,
  skipEligibility,
} from "@nightshift/core";
import type { WorkerDecisionInput } from "@nightshift/harness";

export class StepAdjustmentRefusedError extends Error {
  override readonly name = "StepAdjustmentRefusedError";
  constructor(message: string) {
    super(message);
  }
}

type StepShape = {
  readonly id: string;
  readonly timeoutSeconds?: number | undefined;
  readonly cleanupSeconds?: number | undefined;
};
type Record_ = (input: WorkerDecisionInput) => Promise<Decision>;

const stepNamed = <T extends StepShape>(steps: readonly T[], stepId: string, reason: string): T => {
  const step = steps.find((candidate) => candidate.id === stepId);
  if (step === undefined) {
    throw new StepAdjustmentRefusedError(
      `the run has no verification step "${stepId}"; its steps are ${steps.map((s) => s.id).join(", ") || "(none)"}`,
    );
  }
  if (reason.trim() === "") throw new StepAdjustmentRefusedError("a reason is required");
  return step;
};

export interface RecordStepTimeoutInput {
  readonly steps: readonly StepShape[];
  readonly decisions: readonly AdjustmentDecision[];
  readonly stepId: string;
  readonly timeoutSeconds?: number | undefined;
  readonly cleanupSeconds?: number | undefined;
  readonly reason: string;
  /** The run's costPolicy.maxWallClockSeconds (D-04). */
  readonly maxWallClockSeconds?: number | undefined;
}

export const recordStepTimeout = async (
  record: Record_,
  input: RecordStepTimeoutInput,
): Promise<Decision> => {
  const { stepId, timeoutSeconds, cleanupSeconds, reason } = input;
  const step = stepNamed(input.steps, stepId, reason);
  const raise = { timeoutSeconds, cleanupSeconds };
  const refusal = raiseRefusal(step, input.decisions, raise, {
    maxWallClockSeconds: input.maxWallClockSeconds,
  });
  if (refusal !== undefined) throw new StepAdjustmentRefusedError(refusal);
  const said = [
    ...(timeoutSeconds === undefined ? [] : [`timeoutSeconds to ${timeoutSeconds}`]),
    ...(cleanupSeconds === undefined ? [] : [`cleanupSeconds to ${cleanupSeconds}`]),
  ].join(" and ");
  return record({
    context: formatStepTimeoutContext(stepId, raise),
    alternatives: [{ summary: "wait with the current timeout" }, { summary: "skip the step" }],
    choice: `raise ${stepId}'s ${said} for the rest of the run`,
    rationale: reason,
    reversibility: "reversible",
  });
};

export interface RecordStepSkipInput {
  readonly steps: readonly StepShape[];
  readonly decisions: readonly AdjustmentDecision[];
  readonly verifications: readonly Verification[];
  readonly stepId: string;
  readonly reason: string;
}

export const recordStepSkip = async (
  record: Record_,
  input: RecordStepSkipInput,
): Promise<Decision> => {
  const { stepId, reason } = input;
  stepNamed(input.steps, stepId, reason);
  const eligibility = skipEligibility(stepId, input.verifications);
  if (!eligibility.eligible) throw new StepAdjustmentRefusedError(eligibility.reason);
  return record({
    context: formatStepSkippedContext(stepId),
    alternatives: [
      { summary: "raise the timeout again" },
      { summary: "fix the step so it finishes in time" },
    ],
    choice: `skip ${stepId} for the rest of the run`,
    rationale: reason,
    reversibility: "reversible",
  });
};

const everyPage = async <T>(
  list: (page: PageRequest) => Promise<Page<T>>,
): Promise<readonly T[]> => {
  const items: T[] = [];
  let cursor: string | undefined;
  do {
    const page = await list(cursor === undefined ? {} : { cursor });
    items.push(...page.items);
    cursor = page.cursor;
  } while (cursor !== undefined);
  return items;
};

/** Every decision of the run, oldest first. */
export const runDecisions = async (
  stores: Pick<ProjectStores, "decisions">,
  scope: RunScope,
): Promise<readonly Decision[]> =>
  [...(await everyPage((page) => stores.decisions.listByRun(scope, page)))].sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  );

/** Every verification of every node of the run. */
export const runVerifications = async (
  stores: Pick<ProjectStores, "executionNodes" | "verifications">,
  scope: RunScope,
): Promise<readonly Verification[]> => {
  const nodes = await everyPage((page) => stores.executionNodes.listByRun(scope, page));
  const lists = await Promise.all(
    nodes.map((node) =>
      stores.verifications.listByNode(scope, node.executionNodeId as ExecutionNodeId),
    ),
  );
  return lists.flat();
};

/** The steps of one verification once the run's adjustments are applied. */
export interface ResolvedSteps {
  /** The contract's order, raised timeouts applied; skipped steps are marked, not removed. */
  readonly steps: readonly VerificationStep[];
  /** The steps that run: not skipped. Plain contract steps, as the runner takes them. */
  readonly runnable: readonly VerificationStep[];
  /** step id -> decision id, for the steps whose skip is honoured. */
  readonly skipped: ReadonlyMap<string, DecisionId>;
  /** A skip that is not honoured: the step runs, and this says why. */
  readonly notApplied: readonly { stepId: string; decisionId: string; reason: string }[];
}

/**
 * Resolves `steps` through `effectiveSteps` from the run's decisions and its
 * complete verification history as of now: the engine's token sees every node,
 * so this is authoritative whatever a strand's reader could see.
 */
export const resolveSteps = async (
  stores: Pick<ProjectStores, "decisions" | "executionNodes" | "verifications">,
  scope: RunScope,
  steps: readonly VerificationStep[],
): Promise<ResolvedSteps> => {
  const [decisions, verifications] = await Promise.all([
    runDecisions(stores, scope),
    runVerifications(stores, scope),
  ]);
  const effective = effectiveSteps(steps, decisions, verifications);
  const skipped = new Map<string, DecisionId>();
  const notApplied: { stepId: string; decisionId: string; reason: string }[] = [];
  const runnable: VerificationStep[] = [];
  const plain: VerificationStep[] = [];
  for (const step of effective) {
    const { skipped: skip, skipNotHonoured, ...rest } = step;
    const clean = rest as VerificationStep;
    plain.push(clean);
    if (skip !== undefined) {
      skipped.set(step.id, skip.decisionId as DecisionId);
      continue;
    }
    if (skipNotHonoured !== undefined) {
      notApplied.push({ stepId: step.id, ...skipNotHonoured });
    }
    runnable.push(clean);
  }
  return { steps: plain, runnable, skipped, notApplied };
};
