/**
 * The shape of `step.timeout` and `step.skip` (P19 S-02), shared by the root's
 * server and a strand's so the two cannot drift: the input, the guidance an
 * orchestrator reads in the tool's description, and the answer.
 */

import { StepAdjustmentRefusedError } from "@nightshift/execution";
import { z } from "zod";
import { ToolRefusal } from "./results.js";

export const STEP_TIMEOUT_TOOL = {
  title: "Raise a step's timeout",
  description:
    "Give a verification step more time for the rest of the run, as a recorded decision. Use it " +
    "when a step timed out and its work is real and slow, not hung: raise timeoutSeconds (the " +
    "time it gets) and/or cleanupSeconds (the time its trap gets after SIGTERM before SIGKILL). " +
    "A timeout may be raised to 7200 seconds at most and a cleanup time to 3600, and the " +
    "timeout plus the cleanup time must fit the run's wall clock (costPolicy.maxWallClockSeconds). " +
    "Only a raise is accepted. `reason` is required and is recorded. The next verification " +
    "applies it.",
  inputSchema: {
    stepId: z.string().min(1),
    timeoutSeconds: z.number().int().positive().optional(),
    cleanupSeconds: z.number().int().positive().optional(),
    reason: z.string().min(1),
  },
} as const;

export const STEP_SKIP_TOOL = {
  title: "Skip a timed-out step",
  description:
    "Skip one verification step for the rest of the run, as a recorded decision, so the run can " +
    "finish its other gates. Only a step whose most recent run timed out (exit 124) may be " +
    "skipped, and only when raising its timeout has not worked: raise first with step.timeout. " +
    "Never skip a step that failed: a step that ran and failed, or passed, is refused; fix it. " +
    "`reason` is required and is recorded; the report lists the step as not verified. The " +
    "engine applies the skip at the next verification only if the run's complete history " +
    "agrees that the step's most recent run timed out.",
  inputSchema: {
    stepId: z.string().min(1),
    reason: z.string().min(1),
  },
} as const;

/** An adjustment the rules refuse is a refusal the orchestrator can act on. */
export const asStepRefusal = (error: unknown): unknown =>
  error instanceof StepAdjustmentRefusedError
    ? new ToolRefusal("validation_failed", error.message)
    : error;

export const timeoutAnswer = (
  decisionId: string,
  input: {
    stepId: string;
    timeoutSeconds?: number | undefined;
    cleanupSeconds?: number | undefined;
  },
  next: string,
): string => {
  const values = [
    ...(input.timeoutSeconds === undefined ? [] : [`timeoutSeconds ${input.timeoutSeconds}`]),
    ...(input.cleanupSeconds === undefined ? [] : [`cleanupSeconds ${input.cleanupSeconds}`]),
  ].join(" and ");
  return `Recorded decision ${decisionId}: step ${input.stepId} now has ${values} for the rest of the run. ${next}`;
};

export const skipAnswer = (decisionId: string, stepId: string, next: string): string =>
  `Recorded decision ${decisionId}: step ${stepId} is skipped for the rest of the run. ${next}`;
