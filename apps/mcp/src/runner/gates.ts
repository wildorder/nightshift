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
 * The audit is then compared with the laptop's reference, gate by gate (P16
 * S-02). A gate green there and red here is an environment fault (D-07): the
 * machine is at fault, not the project. It is recorded as `environment.fault`
 * on the program node, with both outputs and both Nodes; no `gate.red` is
 * written, even for gates red on both; the run is cancelled before the root
 * starts, and the dispatch ends `failed` with `environment_fault`. A dispatch
 * without a reference (from before P16) is audited exactly as it was.
 *
 * Only on a dispatch's first machine. A replacement (T6) resumes a run that
 * has already started; its base was audited when it began.
 */
import type {
  CheckDispatch,
  CommitSha,
  EnvironmentFaultPayload,
  Prerequisite,
} from "@nightshift/contracts";
import {
  nowIso,
  parseRuntimeVersion,
  prerequisitesOf,
  transitionRun,
  unmetPrerequisitesAt,
} from "@nightshift/core";
import {
  auditGates,
  compareWithReference,
  DEFAULT_VERIFICATION_TIMEOUT_MS,
  deferralOf,
  type ExecutionEnvironment,
  environmentFaultReason,
  type GateAudit,
  type GateComparison,
  recordEnvironmentFault,
  recordRedBase,
  runPreflight,
  stepsAs,
} from "@nightshift/execution";
import { runVerificationSteps } from "@nightshift/verification";
import type { Runtime } from "../compose.js";
import type { RunnerContext, RunnerWorkEnd } from "./main.js";
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
  /** The audit compared with the dispatch's reference; with none, every gate is the machine's own. */
  readonly comparison?: GateComparison;
  /** Gates green in the reference and red here (P16 D-07): the root must not start. */
  readonly fault?: {
    readonly payload: EnvironmentFaultPayload;
    /** The run's `outcomeReason`, and the dispatch failure's message. */
    readonly reason: string;
  };
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

/**
 * `node --version` on this machine, exact and without the `v`, as a worker
 * user in the project environment: the Node the gates ran on. `undefined` when
 * there is none.
 */
export const nodeOnMachine = async (
  runtime: MachineAuditRuntime,
  context: MachineAuditContext,
): Promise<string | undefined> => {
  try {
    const [result] = await runVerificationSteps({
      steps: [{ id: "node", command: "node --version" }],
      cwd: context.layout.checkout,
      env: environmentOf(context),
      ...asWorker(runtime, context),
      timeoutMs: 60_000,
    });
    if (result === undefined || result.exitCode !== 0) return undefined;
    return parseRuntimeVersion("node", new TextDecoder().decode(result.output));
  } catch {
    return undefined;
  }
};

/**
 * Green on the laptop and red here (P16 D-07): `environment.fault` on the
 * program node, with each disagreeing gate's machine output and both Nodes;
 * then the run, still `pending`, is cancelled with the fault as its reason.
 */
const recordFault = async (
  runtime: MachineAuditRuntime,
  context: MachineAuditContext,
  audit: GateAudit,
  comparison: GateComparison,
  log: (line: string) => void,
): Promise<NonNullable<MachineAuditResult["fault"]>> => {
  const referenceNode = context.dispatch.input.reference?.node;
  const machineNode = await nodeOnMachine(runtime, context);
  const run = await runtime.stores.runs.get(context.scope, context.scope.runId);
  const unrecorded: EnvironmentFaultPayload = {
    baseCommit: audit.base,
    gates: comparison.faults.map((gate) => ({
      id: gate.id,
      command: gate.command,
      kind: gate.kind,
      reference: gate.reference ?? "unrun",
      machine: gate.machine,
      ...(gate.referenceOutputArtifactId === undefined
        ? {}
        : { referenceOutputArtifactId: gate.referenceOutputArtifactId }),
    })),
    ...(referenceNode === undefined ? {} : { referenceNode }),
    ...(machineNode === undefined ? {} : { machineNode }),
  };
  const payload =
    run === undefined
      ? unrecorded
      : await recordEnvironmentFault(runtime, {
          scope: context.scope,
          nodeId: run.rootNodeId,
          audit,
          comparison,
          referenceNode,
          machineNode,
          writerId: `${context.dispatch.engineAgentId}-gates`,
        });
  const reason = environmentFaultReason(payload);
  // `pending → cancelled`: the table has no `pending → failed` (D-07).
  if (run?.status === "pending") {
    await runtime.stores.runs.put(
      transitionRun(run, "cancel", { endedAt: nowIso(runtime.clock), outcomeReason: reason }),
    );
  }
  log(`gate audit: ${reason}`);
  return { payload, reason };
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
  const comparison = compareWithReference(context.dispatch.input.reference, audit);
  for (const gate of comparison.gates.filter(
    (candidate) => candidate.reference === "failed" && candidate.machine === "passed",
  )) {
    log(`gate audit: ${gate.id} failed in the reference audit and passes here; it is not red`);
  }
  // A fault outranks a red base: no `gate.red`, so nothing is repaired (D-07).
  if (comparison.faults.length > 0) {
    return {
      audit,
      comparison,
      fault: await recordFault(runtime, context, audit, comparison, log),
    };
  }
  // With no fault, every gate failing here is red: the machine's own result, or both agree.
  if (comparison.red.length === 0) return { audit, comparison };

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
  return { audit, comparison };
};

/**
 * The audit, then the root (P16 D-07): an environment fault ends the work with
 * `environment_fault` (`ended`) before the root is started, or paid for;
 * anything else, red base included, starts it.
 */
export const auditThenRoot = async (
  runtime: MachineAuditRuntime,
  context: MachineAuditContext,
  log: (line: string) => void,
  root: () => Promise<void>,
): Promise<{ readonly audited: MachineAuditResult; readonly ended?: RunnerWorkEnd }> => {
  const audited = await auditOnMachine(runtime, context, log);
  if (audited.fault !== undefined) {
    return {
      audited,
      ended: { failure: { code: "environment_fault", message: audited.fault.reason } },
    };
  }
  await root();
  return { audited };
};
