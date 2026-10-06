/**
 * The gate audit on a run's own machine, before the root orchestrator starts.
 *
 * A laptop run is audited by `nightshift run` before the run exists. A remote
 * run cannot be: the gates that matter are this machine's, with its toolchain,
 * its stores and its worker users. So the runner audits the base here, with
 * the same environment and the same users verification will use, and a gate
 * that fails every time ends the run as `failed` before any agent is paid for,
 * unless the human started it with `--allow-red-gates`. Each red gate's output
 * is kept on the run's program node, where the report and the Studio find it.
 *
 * Only on a dispatch's first machine. A replacement (T6) resumes a run that
 * has already started; its base was audited when it began.
 */
import type { CommitSha, ExecutionNodeId } from "@nightshift/contracts";
import { prerequisitesOf } from "@nightshift/core";
import {
  auditGates,
  createEventOutbox,
  DEFAULT_VERIFICATION_TIMEOUT_MS,
  type ExecutionEnvironment,
  failBeforeStart,
  type GateAudit,
  recordArtifact,
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

export interface MachineAuditResult {
  /** False when the run was ended here and the root must not start. */
  readonly proceed: boolean;
  readonly audit?: GateAudit;
}

/** The run's failure reason: the red gates, by id and command. */
export const redReason = (audit: GateAudit): string => {
  const named = audit.gates
    .filter((gate) => gate.verdict === "failed")
    .map((gate) => `${gate.id} (\`${gate.command}\`)`)
    .join(", ");
  return (
    `the gate audit on ${audit.base.slice(0, 8)} found ${named} failing every run, so no job ` +
    "could pass verification; nothing was started. Fix the base, or run again with " +
    "--allow-red-gates if this program's work is to make it pass. Each gate's output is on the run's program node."
  );
};

export const auditOnMachine = async (
  runtime: MachineAuditRuntime,
  context: MachineAuditContext,
  log: (line: string) => void,
): Promise<MachineAuditResult> => {
  if (context.dispatch.generation > 1) return { proceed: true };
  const unmet = new Set(
    prerequisitesOf(context.program)
      .filter((prerequisite) => prerequisite.status !== "satisfied")
      .map((prerequisite) => prerequisite.id),
  );
  log(`gate audit: setup and every check, twice, on ${context.dispatch.input.baseSha.slice(0, 8)}`);
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
    onStep: ({ pass, result }) =>
      log(
        `gate audit run ${pass}: ${result.stepId} ${result.exitCode === 0 ? "ok" : `exited ${result.exitCode}`} ` +
          `in ${(result.durationMs / 1000).toFixed(1)}s`,
      ),
  });
  if (audit.flaky.length > 0) log(`gate audit: flaky ${audit.flaky.join(", ")}`);
  if (!audit.red) return { proceed: true, audit };
  if (context.dispatch.input.allowRedGates === true) {
    log(
      `gate audit: red (${audit.failing.join(", ")}); starting anyway, as --allow-red-gates says`,
    );
    return { proceed: true, audit };
  }

  const run = await runtime.stores.runs.get(context.scope, context.scope.runId);
  if (run !== undefined) await keepRedOutput(runtime, context, run.rootNodeId, audit);
  await failBeforeStart(runtime, context.scope, redReason(audit));
  log(
    `gate audit: red (${audit.failing.join(", ")}); the run is failed and the root does not start`,
  );
  return { proceed: false, audit };
};

/** Each red gate's last output, as a verification log on the program node. */
const keepRedOutput = async (
  runtime: MachineAuditRuntime,
  context: MachineAuditContext,
  nodeId: ExecutionNodeId,
  audit: GateAudit,
): Promise<void> => {
  const outbox = createEventOutbox({
    events: runtime.stores.events,
    scope: context.scope,
    clock: runtime.clock,
    ids: runtime.ids,
    writerId: `${context.dispatch.engineAgentId}-gates`,
  });
  for (const gate of audit.gates.filter((candidate) => candidate.verdict === "failed")) {
    const last = gate.runs.at(-1);
    if (last === undefined) continue;
    await recordArtifact(
      { ...runtime, outbox },
      {
        scope: context.scope,
        nodeId,
        kind: "verification-log",
        contentType: "text/plain; charset=utf-8",
        bytes: last.output,
      },
    );
  }
  await outbox.flush(5_000).catch(() => undefined);
};
