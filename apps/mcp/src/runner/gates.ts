/**
 * The gate audit on a run's own machine, before the root orchestrator starts.
 *
 * A laptop run is audited by `nightshift run` before the run exists. A remote
 * run cannot be: the gates that matter are this machine's, with its toolchain,
 * its stores and its worker users. So the runner audits the base here, once,
 * with the same environment and the same users verification will use. A gate
 * that fails does not stop the run (P15, D-P15-03): it is recorded as a
 * `gate.red` event on the run's program node, with each red gate's output beside
 * it, and the root starts. Its first job is the repair, and the engine holds the
 * strands until that lands.
 *
 * Only on a dispatch's first machine. A replacement (T6) resumes a run that
 * has already started; its base was audited when it began.
 */
import type { CommitSha } from "@nightshift/contracts";
import { prerequisitesOf } from "@nightshift/core";
import {
  auditGates,
  DEFAULT_VERIFICATION_TIMEOUT_MS,
  type ExecutionEnvironment,
  type GateAudit,
  recordRedBase,
  stepsAs,
} from "@nightshift/execution";
import type { Runtime } from "../compose.js";
import type { RunnerContext } from "./main.js";
import { storesEnvironment } from "./workspace.js";

export type MachineAuditRuntime = Pick<
  Runtime,
  "git" | "stores" | "bodies" | "ids" | "clock" | "runAs"
>;

export type MachineAuditContext = Pick<RunnerContext, "scope" | "layout" | "dispatch" | "program">;

/** What the audit found; absent on a replacement machine, which does not audit. A red one does not stop the root. */
export interface MachineAuditResult {
  readonly audit?: GateAudit;
}

/** What the runner says of a red base: the red gates, by id and command. */
export const redReason = (audit: GateAudit): string => {
  const named = audit.gates
    .filter((gate) => gate.verdict === "failed")
    .map((gate) => `${gate.id} (\`${gate.command}\`)`)
    .join(", ");
  return (
    `the gate audit on ${audit.base.slice(0, 8)} found ${named} failing; the run starts, and its ` +
    "first job is their repair. Each gate's output is on the run's program node."
  );
};

export const auditOnMachine = async (
  runtime: MachineAuditRuntime,
  context: MachineAuditContext,
  log: (line: string) => void,
): Promise<MachineAuditResult> => {
  if (context.dispatch.generation > 1) return {};
  const unmet = new Set(
    prerequisitesOf(context.program)
      .filter((prerequisite) => prerequisite.status !== "satisfied")
      .map((prerequisite) => prerequisite.id),
  );
  log(`gate audit: setup and every check, on ${context.dispatch.input.baseSha.slice(0, 8)}`);
  const audit = await auditGates({
    git: runtime.git,
    repoPath: context.layout.checkout,
    base: context.dispatch.input.baseSha as CommitSha,
    program: context.program,
    unmet,
    workDir: `${context.layout.run}/gate-audit`,
    timeoutMs: DEFAULT_VERIFICATION_TIMEOUT_MS,
    env: storesEnvironment(context.layout),
    // As verification on this machine runs its steps (D-P10-25).
    ...stepsAs(runtime as Pick<ExecutionEnvironment, "runAs">, {
      agentId: `${context.dispatch.engineAgentId}-gates`,
      role: "worker",
    }),
    onStep: (result) =>
      log(
        `gate audit: ${result.stepId} ${result.exitCode === 0 ? "ok" : `exited ${result.exitCode}`} ` +
          `in ${(result.durationMs / 1000).toFixed(1)}s`,
      ),
  });
  if (!audit.red) return { audit };

  const run = await runtime.stores.runs.get(context.scope, context.scope.runId);
  if (run !== undefined) {
    await recordRedBase(runtime, {
      scope: context.scope,
      nodeId: run.rootNodeId,
      audit,
      writerId: `${context.dispatch.engineAgentId}-gates`,
      event: true,
    });
  }
  log(`gate audit: red (${audit.failing.join(", ")}); ${redReason(audit)}`);
  return { audit };
};
