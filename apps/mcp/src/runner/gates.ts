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
 * Before the audit the machine checks the human prerequisites itself (P16,
 * D-08): every `verifyCommand`, as a worker user in the project environment,
 * each recorded through `prerequisite.put` as a machine check under this
 * dispatch. The audit's `unmet` set is built from those checks alone. A
 * prerequisite the laptop's preflight satisfied is no evidence here: Docker on
 * the laptop says nothing of Docker on this machine.
 *
 * Only on a dispatch's first machine. A replacement (T6) resumes a run that
 * has already started; its base was audited when it began.
 */
import type { CheckDispatch, CommitSha, Prerequisite } from "@nightshift/contracts";
import { nowIso, prerequisitesOf, unmetPrerequisitesAt } from "@nightshift/core";
import {
  auditGates,
  DEFAULT_VERIFICATION_TIMEOUT_MS,
  deferralOf,
  type ExecutionEnvironment,
  type GateAudit,
  recordRedBase,
  runPreflight,
  stepsAs,
} from "@nightshift/execution";
import type { Runtime } from "../compose.js";
import type { RunnerContext } from "./main.js";
import { projectEnvironment } from "./workspace.js";

export type MachineAuditRuntime = Pick<
  Runtime,
  "git" | "stores" | "bodies" | "ids" | "clock" | "runAs" | "paths" | "prerequisites"
>;

export type MachineAuditContext = Pick<RunnerContext, "scope" | "layout" | "dispatch" | "program"> &
  Partial<Pick<RunnerContext, "projectEnv">>;

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

/** The project environment setup ran in (P16 S-01): the pinned runtimes and the stores. */
const environmentOf = (context: MachineAuditContext): Readonly<Record<string, string>> =>
  context.projectEnv ?? projectEnvironment(context.layout, context.dispatch.input.toolchain);

/** As verification on this machine runs its steps (D-P10-25): a worker user. */
const asWorker = (runtime: MachineAuditRuntime, context: MachineAuditContext) =>
  stepsAs(runtime as Pick<ExecutionEnvironment, "runAs">, {
    agentId: `${context.dispatch.engineAgentId}-gates`,
    role: "worker",
  });

/**
 * Every prerequisite's `verifyCommand`, run on this machine as a worker user in
 * the project environment, each recorded as a machine check under this
 * dispatch (P16, D-08). Returns the ids unmet here: those whose check, this
 * dispatch's own, did not exit zero. The laptop's status plays no part.
 */
export const checkPrerequisitesOnMachine = async (
  runtime: MachineAuditRuntime,
  context: MachineAuditContext,
  log: (line: string) => void,
): Promise<ReadonlySet<string>> => {
  const prerequisites = prerequisitesOf(context.program);
  if (prerequisites.length === 0) return new Set();
  const dispatch: CheckDispatch = {
    runId: context.scope.runId,
    generation: context.dispatch.generation,
  };
  const book = runtime.prerequisites;
  log(`prerequisites: checking ${prerequisites.length} on this machine`);
  const result = await runPreflight({
    contract: context.program,
    cwd: context.layout.checkout,
    site: { where: "machine", dispatch },
    env: environmentOf(context),
    ...asWorker(runtime, context),
    clock: runtime.clock,
    record: async (scope, prerequisiteId, exitCode): Promise<Prerequisite> => {
      if (book !== undefined) {
        return book.recordMachineCheck(scope, prerequisiteId, exitCode, dispatch);
      }
      // No control plane to tell (a suite's runtime): the check stands as run.
      const prerequisite = prerequisites.find((candidate) => candidate.id === prerequisiteId);
      if (prerequisite === undefined) throw new Error(`no prerequisite ${prerequisiteId}`);
      return {
        ...prerequisite,
        machineChecks: [
          { where: "machine", ...dispatch, exitCode, checkedAt: nowIso(runtime.clock) },
        ],
      };
    },
  });
  for (const check of result.checks) {
    log(
      `prerequisites: ${check.prerequisite.id} ${
        check.exitCode === 0
          ? "met"
          : check.timedOut
            ? "unmet (timed out)"
            : `unmet (exited ${check.exitCode})`
      } on this machine`,
    );
  }
  // Judged from the checks as recorded, this dispatch's alone.
  return unmetPrerequisitesAt(
    result.checks.map((check) => check.prerequisite),
    { where: "machine", dispatch },
  );
};

export const auditOnMachine = async (
  runtime: MachineAuditRuntime,
  context: MachineAuditContext,
  log: (line: string) => void,
): Promise<MachineAuditResult> => {
  if (context.dispatch.generation > 1) return {};
  const unmet = await checkPrerequisitesOnMachine(runtime, context, log);
  log(`gate audit: setup and every check, on ${context.dispatch.input.baseSha.slice(0, 8)}`);
  const audit = await auditGates({
    git: runtime.git,
    repoPath: context.layout.checkout,
    base: context.dispatch.input.baseSha as CommitSha,
    program: context.program,
    unmet,
    workDir: `${context.layout.run}/gate-audit`,
    timeoutMs: DEFAULT_VERIFICATION_TIMEOUT_MS,
    paths: runtime.paths,
    // The project environment setup ran in (P16 S-01): the pinned runtimes and the stores.
    env: environmentOf(context),
    // As verification on this machine runs its steps (D-P10-25).
    ...asWorker(runtime, context),
    onStep: (result) =>
      log(
        `gate audit: ${result.stepId} ${
          result.exitCode === 0
            ? "ok"
            : deferralOf(result) === undefined
              ? `exited ${result.exitCode}`
              : "deferred"
        } in ${(result.durationMs / 1000).toFixed(1)}s`,
      ),
  });
  // Deferred is not red (D-P7-10): it is said, with what it waits for, and the root starts.
  for (const gate of audit.gates.filter((candidate) => candidate.verdict === "deferred")) {
    log(
      `gate audit: ${gate.id} deferred` +
        (gate.deferral === undefined
          ? ""
          : `: ${gate.deferral.prerequisiteId} ${gate.deferral.description}`),
    );
  }
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
