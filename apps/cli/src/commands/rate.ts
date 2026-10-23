/**
 * `nightshift rate <program> up|down|clear [--run <id>] [--repo <path>]` (P20, D-04).
 *
 * The terminal's form of Studio's one-click verdict: a person saying a finished
 * run worked or did not. It reads the stored verdict, proposes the next version
 * of it and lets the control plane decide; a write that lost a race is reported,
 * never retried, because the person may no longer mean it.
 */
import type { RunVerdict } from "@nightshift/contracts";
import { buildRunFeedback, isRunRateable, nowIso, StaleWriteError } from "@nightshift/core";
import { ControlPlaneError, isTokenProfile } from "@nightshift/persistence/http";
import type { CliEnvironment } from "../environment.js";
import { resolveFrom } from "../program-files.js";
import { findProgram } from "../program-source.js";
import { openFreshSession } from "../session.js";
import { actingUser, findRun } from "./program-run.js";

export type RateAction = "up" | "down" | "clear";

export interface RateOptions {
  readonly id: string;
  readonly action: RateAction;
  readonly run?: string;
  readonly repo?: string;
}

const VERDICTS: Readonly<Record<RateAction, RunVerdict | null>> = {
  up: "worked",
  down: "did_not_work",
  clear: null,
};

const WORDS: Readonly<Record<RunVerdict, string>> = {
  worked: "worked",
  did_not_work: "did not work",
};

export const rateRun = async (
  environment: CliEnvironment,
  options: RateOptions,
): Promise<number> => {
  const repoPath = resolveFrom(environment.cwd, options.repo ?? environment.cwd);
  const session = await openFreshSession(environment);
  const files = await findProgram(environment, session, {
    repoPath,
    name: options.id,
    use: "ratified",
  });
  const program = {
    projectId: files.contract.projectId,
    programId: files.contract.programId,
  };
  const run = await findRun(session, program, options.id, options.run);
  const scope = { ...program, runId: run.runId };
  const verdict = VERDICTS[options.action];

  if (!isRunRateable(run)) {
    environment.err(
      `run ${run.runId} is not finished (${run.status}); a verdict can be given once it has ended`,
    );
    return 1;
  }

  const stored = await session.stores.feedback.get(scope);
  if (stored !== undefined && stored.verdict === verdict) {
    environment.out(
      verdict === null
        ? `run ${run.runId} is not rated`
        : `run ${run.runId} is already rated as ${WORDS[verdict]} (revision ${stored.version})`,
    );
    return 0;
  }

  const feedback = buildRunFeedback({
    ...(stored === undefined ? {} : { stored }),
    scope,
    verdict,
    actor: await actingUser(session, isTokenProfile(session.profile), program.projectId),
    at: nowIso(environment.clock),
  });
  try {
    await session.stores.feedback.put(feedback);
  } catch (error) {
    if (error instanceof StaleWriteError) {
      environment.err("the rating changed underneath you; run the command again");
      return 1;
    }
    if (error instanceof ControlPlaneError) {
      // Nothing was stored, so there is nothing to clear.
      if (verdict === null && error.status === 404) {
        environment.out(`run ${run.runId} is not rated`);
        return 0;
      }
      if (error.status === 409 && error.code === "run_not_finished") {
        environment.err(error.message);
        return 1;
      }
    }
    throw error;
  }
  environment.out(
    verdict === null
      ? `cleared the verdict on run ${run.runId}`
      : `rated run ${run.runId} as ${WORDS[verdict]} (revision ${feedback.version})`,
  );
  return 0;
};
