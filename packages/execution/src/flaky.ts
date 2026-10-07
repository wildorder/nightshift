/**
 * Telling a flaky check from a failing one (P15, D-P15-06).
 *
 * Every verification that writes a `Verification` (the queue's, in
 * `verify.ts`, and the candidate check an examined job gets, in `examine.ts`)
 * reruns each check that failed exactly once, on the same checkout of the same
 * commit, as whoever ran it the first time, in a fresh scratch, without
 * running setup again and without resetting the tree. The failures it reruns
 * are the ones `rerunnableChecks` names: a declared deferral is not rerun, a
 * step waiting on a prerequisite never ran, and a failed setup leaves no check
 * to rerun.
 *
 * - **The rerun passes.** The command is recorded with the rerun's exit code,
 *   duration and log, and `flaky` carries the first run's; both logs are kept.
 *   The command now counts as passed, so the work goes on exactly as a pass
 *   does and nothing climbs the route. The flake is not hidden: a `gate.flaked`
 *   event names it, and the root opens a repair job off the blocking path.
 * - **The rerun fails.** It is a failure exactly as before, and the command is
 *   recorded as its **first** run: the same exit code, duration and log a
 *   verification without reruns would have recorded. The rerun's output is not
 *   kept; it adds a second copy of a failure, not new evidence.
 */
import type {
  AgentId,
  ExecutionNodeId,
  Verification,
  VerificationCommandResult,
  VerificationStep,
} from "@nightshift/contracts";
import { flakyStepIds } from "@nightshift/contracts";
import { type CheckRerun, rerunFailedChecks, type StepResult } from "@nightshift/verification";
import type { ExecutionEnvironment, RunSession } from "./environment.js";
import { recordArtifact } from "./runner.js";
import { discardScratch, freshScratch, type RunScratchAs, scratchEnv } from "./scratch.js";

export interface RerunInput {
  readonly steps: readonly VerificationStep[];
  /** The first run's check results. */
  readonly first: readonly StepResult[];
  /** The checkout the first run used, as it is: not reset, and setup not run again. */
  readonly cwd: string;
  readonly timeoutMs: number;
  /** Whoever ran the first run, so the rerun is the same identity (D-P10-25). */
  readonly as?: RunScratchAs;
  /** Leave the rerun's scratch for whoever works in the checkout next (the examiner). */
  readonly keepScratch?: boolean;
}

/** Reruns each failed check once, with a scratch of its own. Empty when nothing failed. */
export const rerunFailures = async (input: RerunInput): Promise<readonly CheckRerun[]> => {
  const { steps, first, cwd, timeoutMs, as, keepScratch } = input;
  if (first.every((result) => result.exitCode === 0)) return [];
  const scratch = await freshScratch(cwd, as);
  const ran = rerunFailedChecks({
    steps,
    first,
    cwd,
    timeoutMs,
    env: scratchEnv(scratch),
    ...(as === undefined ? {} : { as }),
  });
  return keepScratch === true ? ran : ran.finally(() => discardScratch(cwd, as));
};

/**
 * `commands` with each check whose rerun passed recorded as a flake: the
 * rerun's evidence, its log uploaded beside the first run's, and the first run
 * under `flaky`. A check whose rerun failed keeps its first run, unchanged.
 */
export const withFlakes = async (
  environment: Pick<ExecutionEnvironment, "stores" | "bodies" | "clock" | "ids" | "outbox">,
  at: { readonly scope: RunSession["scope"]; readonly nodeId: ExecutionNodeId },
  commands: readonly VerificationCommandResult[],
  reruns: readonly CheckRerun[],
): Promise<VerificationCommandResult[]> => {
  const passed = new Map(
    reruns.filter((run) => run.rerun.exitCode === 0).map((run) => [run.rerun.stepId, run.rerun]),
  );
  const out: VerificationCommandResult[] = [];
  for (const command of commands) {
    const rerun = passed.get(command.stepId);
    if (rerun === undefined || command.exitCode === undefined || command.exitCode === 0) {
      out.push(command);
      continue;
    }
    const logArtifactId = (await recordArtifact(environment, {
      scope: at.scope,
      nodeId: at.nodeId,
      kind: "verification-log",
      contentType: "text/plain; charset=utf-8",
      bytes: rerun.output,
    })) as VerificationCommandResult["logArtifactId"];
    out.push({
      stepId: command.stepId,
      command: command.command,
      exitCode: rerun.exitCode,
      durationMs: rerun.durationMs,
      ...(logArtifactId === undefined ? {} : { logArtifactId }),
      flaky: {
        firstExitCode: command.exitCode,
        firstDurationMs: command.durationMs,
        ...(command.logArtifactId === undefined
          ? {}
          : { firstLogArtifactId: command.logArtifactId }),
      },
    });
  }
  return out;
};

/**
 * `gate.flaked` on the node, when the verification recorded a flake. Called
 * after the `Verification` is written, so the event names a record that exists.
 * Returns what `verification.completed` adds for it: the flaky step ids, or
 * nothing when there were none.
 */
export const announceFlakes = (
  environment: Pick<ExecutionEnvironment, "outbox">,
  verification: Verification,
  agentId: AgentId | undefined,
): { readonly flakyStepIds?: readonly string[] } => {
  const stepIds = flakyStepIds(verification);
  if (stepIds.length === 0) return {};
  environment.outbox.emit({
    type: "gate.flaked",
    source: "control-plane",
    payload: {
      verificationId: verification.verificationId,
      commitSha: verification.commitSha,
      stepIds,
    },
    executionNodeId: verification.executionNodeId,
    ...(agentId === undefined ? {} : { agentId }),
  });
  return { flakyStepIds: stepIds };
};
